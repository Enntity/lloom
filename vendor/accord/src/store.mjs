// SPDX-License-Identifier: MIT
import { messageAttentionSchema } from './message-attention.mjs';
import { managerSchema } from './resource-managers.mjs';
import { awarenessSchema } from './session-awareness.mjs';
import { continuitySchema, persistentDeadline, upgradeSessionContinuity } from './session-continuity.mjs';
import { discoveryCleanupSchema } from './discovery-cleanup.mjs';
import { windowDuration } from './reservation-policy.mjs';
import { database, transaction, hash, id, requireThat, text, integer, monotonicWallClock } from './common.mjs';

const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE leader(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, epoch INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE actors(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','worker')));
CREATE TABLE resources(id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, input TEXT NOT NULL, expected_hash TEXT NOT NULL,
 resource TEXT NOT NULL REFERENCES resources(id), dependency TEXT REFERENCES tasks(id), state TEXT NOT NULL,
 checkpoint TEXT, result TEXT, created_at INTEGER NOT NULL, max_attempts INTEGER NOT NULL);
CREATE TABLE claims(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), resource TEXT NOT NULL REFERENCES resources(id),
 actor TEXT NOT NULL REFERENCES actors(id), generation INTEGER NOT NULL, state TEXT NOT NULL,
 deadline INTEGER NOT NULL, outcome TEXT, error TEXT, result TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_holder ON claims(resource) WHERE state IN ('preparing','running','releasing','revoking');
CREATE UNIQUE INDEX one_attempt ON claims(task_id) WHERE state IN ('preparing','running','releasing','revoking');
CREATE TABLE commands(actor TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,key));
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
`;

const bootstrapSchema = `
CREATE TABLE credentials(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('enroll','discover')));
CREATE TABLE sessions(id TEXT PRIMARY KEY REFERENCES actors(id), label TEXT NOT NULL, harness TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER);
CREATE TABLE peers(authority TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, credential TEXT NOT NULL, added_at INTEGER NOT NULL);
`;

const resourceSchema = `
CREATE TABLE resource_bindings(id TEXT PRIMARY KEY REFERENCES resources(id),instance TEXT NOT NULL,plugin TEXT NOT NULL,asset TEXT UNIQUE NOT NULL,enforcement TEXT NOT NULL);
`;

// Migration 4: collaboration metadata and thin reservations. Legacy task APIs remain compatible.
const collaborationSchema = `
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
CREATE TABLE participants(actor TEXT PRIMARY KEY REFERENCES actors(id), label TEXT NOT NULL, capabilities TEXT NOT NULL,
 activity TEXT NOT NULL, location TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE reservations(id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES actors(id), task_id TEXT UNIQUE NOT NULL REFERENCES tasks(id),
 lease_ms INTEGER NOT NULL, queued_until INTEGER NOT NULL);
CREATE TABLE links(authority TEXT PRIMARY KEY,url TEXT NOT NULL,outbound TEXT NOT NULL,inbound_hash TEXT UNIQUE NOT NULL);
CREATE TABLE message_outbox(id TEXT PRIMARY KEY,actor TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,last_attempt INTEGER NOT NULL DEFAULT 0);
`;

export class Store {
  constructor(file, { now = monotonicWallClock(), leaderMs = 5000 } = {}) {
    this.db = database(file, [schema, bootstrapSchema, resourceSchema, collaborationSchema, awarenessSchema, managerSchema, continuitySchema, discoveryCleanupSchema, "ALTER TABLE session_views ADD COLUMN summary_details TEXT NOT NULL DEFAULT '{}';",messageAttentionSchema, "ALTER TABLE session_views ADD COLUMN parent_session TEXT;",`CREATE TABLE resource_pools(resource TEXT PRIMARY KEY REFERENCES resources(id),pool TEXT NOT NULL);CREATE INDEX resource_pool ON resource_pools(pool);ALTER TABLE reservations ADD COLUMN pool TEXT;`,
      // New links share nothing by default; links made before this choice existed keep working.
      "ALTER TABLE links ADD COLUMN share_sessions INTEGER NOT NULL DEFAULT 0;UPDATE links SET share_sessions=1;",
      // Memory panorama: descriptions and provenance only; bodies stay in native stores.
      `CREATE TABLE memory_entries(id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        description TEXT NOT NULL, updated TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'shared',
        stale INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX memory_entries_updated ON memory_entries(updated DESC);`,
      // NULL declares nothing, so the reservation default applies.
      "ALTER TABLE resource_bindings ADD COLUMN max_ownership_ms INTEGER;ALTER TABLE resource_bindings ADD COLUMN allow_indefinite INTEGER NOT NULL DEFAULT 0;",
      // Migration 16: a finite window is owned by the daemon, not a chat heartbeat.
      "ALTER TABLE reservations ADD COLUMN duration_ms INTEGER;"]); this.now = now; this.leaderMs = leaderMs;
    transaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES('authority',?)").run(id());
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES('paused','false')").run();
      this.db.prepare("INSERT OR IGNORE INTO resources(id) VALUES('artifact')").run();
    });
    this.authority = this.db.prepare("SELECT value FROM meta WHERE key='authority'").get().value;
  }
  close() { this.db.close(); }
  provision(actor, credential, role) {
    this.db.prepare('INSERT INTO actors VALUES(?,?,?)').run(actor, hash(credential), role);
  }
  authenticate(credential) {
    const actor = this.db.prepare('SELECT id,role FROM actors WHERE token_hash=?').get(hash(credential));
    requireThat(actor, 'UNAUTHORIZED', 'Unknown credential', 401);
    const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(actor.id);
    requireThat(!session || (session.closed_at === null && session.expires_at > this.now()), 'SESSION_EXPIRED', 'Session ended; bootstrap a new session', 401);
    return { ...actor, ...(session ? { session } : {}) };
  }
  provisionCredential(name, credential, purpose) {
    this.db.prepare('INSERT INTO credentials VALUES(?,?,?)').run(name, hash(credential), purpose);
  }
  purpose(credential, purpose) {
    const row = this.db.prepare('SELECT id,purpose FROM credentials WHERE token_hash=?').get(hash(credential));
    requireThat(row?.purpose === purpose, 'FORBIDDEN', `A ${purpose} credential is required`, 403);
    return row;
  }
  openSession(enroller, body, secretFor) {
    return this.command({id: `enroll:${enroller.id}`}, body, 'session.open', () => {
      text(body.label, 'label', 120); text(body.harness, 'harness', 80);
      const persistent=body.ttlMs===undefined;
      if(!persistent)integer(body.ttlMs, 'ttlMs', 1000, 86400000);
      const sessionId = id(), createdAt = this.now(), expiresAt = persistent ? persistentDeadline : createdAt + body.ttlMs;
      this.provision(sessionId, secretFor(sessionId), 'worker');
      this.db.prepare('INSERT INTO sessions(id,label,harness,created_at,expires_at,closed_at,persistent) VALUES(?,?,?,?,?,NULL,?)').run(sessionId, body.label, body.harness, createdAt, expiresAt,Number(persistent));
      this.emit('session.opened', {session: sessionId, label: body.label, harness: body.harness, expiresAt:persistent?null:expiresAt,persistent});
      return {sessionId, expiresAt:persistent?null:expiresAt, persistent, authority: this.authority};
    });
  }
  endSession(actor, sessionId, body) {
    requireThat(actor.id === sessionId || actor.role === 'admin', 'NOT_OWNER', 'Session belongs to another actor', 403);
    return this.command(actor, body, `session.close:${sessionId}`, () => {
      requireThat(this.db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId), 'NOT_FOUND', 'Unknown session', 404);
      this.db.prepare('UPDATE sessions SET closed_at=COALESCE(closed_at,?) WHERE id=?').run(this.now(), sessionId);
      this.revokeSession(sessionId);
      this.emit('session.closed', {session: sessionId});
      return {closed: true, release: 'confirmation required for any held resource'};
    });
  }
  revokeSession(sessionId) {
    this.db.prepare("UPDATE session_views SET state='exited',revision=revision+1,summary_kind='extractive',summary='Session closed' WHERE id=? AND state NOT IN ('done','failed','cancelled')").run(sessionId);
    for (const claim of this.db.prepare("SELECT * FROM claims WHERE actor=? AND state IN ('preparing','running')").all(sessionId)) {
      this.fence(claim, 'session ended');
      this.emit('claim.session_ended', {claim: claim.id, session: sessionId});
    }
  }
  addPeer(actor, body) {
    requireThat(actor.role === 'admin', 'FORBIDDEN', 'Administrator required', 403);
    return this.command(actor, body, 'peer.add', () => {
      requireThat(body.authority !== this.authority, 'SELF_PEER', 'Cannot pair a host with itself');
      requireThat(this.db.prepare('SELECT count(*) AS n FROM peers').get().n < 32, 'CAPACITY_LIMIT', 'At most 32 direct peers', 503);
      const old = this.db.prepare('SELECT * FROM peers WHERE authority=? OR url=?').get(body.authority, body.url);
      requireThat(!old || (old.authority === body.authority && old.url === body.url && old.credential === body.credential), 'PEER_CONFLICT', 'Peer identity or endpoint changed; remove the old pairing explicitly');
      this.db.prepare('INSERT OR IGNORE INTO peers VALUES(?,?,?,?)').run(body.authority, body.url, body.credential, this.now());
      this.emit('peer.joined', {authority: body.authority, url: body.url});
      return {authority: body.authority, url: body.url};
    });
  }
  removePeer(actor, body) {
    requireThat(actor.role === 'admin', 'FORBIDDEN', 'Administrator required', 403);
    return this.command(actor, body, 'peer.remove', () => {
      text(body.authority, 'authority', 100);
      this.db.prepare('DELETE FROM peers WHERE authority=?').run(body.authority);
      this.emit('peer.removed', {authority: body.authority}); return {removed: body.authority};
    });
  }
  registerResource(actor,body,binding){
    requireThat(actor.role==='admin','FORBIDDEN','Administrator required',403);
    return this.command(actor,body,'resource.register',()=>{
      const old=this.db.prepare('SELECT * FROM resource_bindings WHERE id=? OR asset=?').get(binding.id,binding.asset);
      requireThat(!old||['id','instance','plugin','asset','enforcement'].every(k=>old[k]===binding[k]),'RESOURCE_CONFLICT','Resource binding changed');
      // A name used before starts above every generation it issued, so an old holder stays fenced.
      this.db.prepare("INSERT OR IGNORE INTO resources(id,generation) VALUES(?,coalesce((SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation_floor'),0))").run(binding.id);
      this.db.prepare('INSERT OR IGNORE INTO resource_bindings(id,instance,plugin,asset,enforcement) VALUES(?,?,?,?,?)').run(binding.id,binding.instance,binding.plugin,binding.asset,binding.enforcement);
      this.db.prepare('UPDATE resource_bindings SET max_ownership_ms=?,allow_indefinite=? WHERE id=?').run(binding.maxOwnershipMs??null,binding.allowIndefinite?1:0,binding.id);
      if(body.pool)this.db.prepare('INSERT OR IGNORE INTO resource_pools VALUES(?,?)').run(binding.id,body.pool);
      this.emit('resource.registered',binding);return binding;
    });
  }
  // Forget a withdrawn or retired resource once nothing holds, awaits or depends on it.
  removeResource(resource){
    return this.mutate(()=>{
      const b=this.binding(resource),busy="SELECT 1 FROM tasks WHERE resource=? AND state IN ('queued','preparing','running','releasing','recovering','cancelling')";
      if(!b||this.db.prepare("SELECT 1 FROM claims WHERE resource=? AND state!='closed'").get(resource)||this.db.prepare(busy).get(resource)
        ||this.db.prepare('SELECT 1 FROM tasks t JOIN tasks d ON d.id=t.dependency WHERE d.resource=? AND t.resource!=?').get(resource,resource))return false;
      const {generation}=this.db.prepare('SELECT generation FROM resources WHERE id=?').get(resource);
      this.db.prepare("INSERT INTO meta VALUES('generation_floor',?) ON CONFLICT(key) DO UPDATE SET value=max(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))").run(String(generation));
      // Its registration replays as new, so the same command registers it again.
      this.db.prepare("DELETE FROM commands WHERE json_extract(response,'$.id')=? AND json_extract(response,'$.asset')=?").run(resource,b.asset);
      this.db.prepare('DELETE FROM reservations WHERE task_id IN (SELECT id FROM tasks WHERE resource=?)').run(resource);
      for(const table of ['claims','tasks'])this.db.prepare(`DELETE FROM ${table} WHERE resource=?`).run(resource);
      this.db.prepare('DELETE FROM resource_pools WHERE resource=?').run(resource);
      this.db.prepare('DELETE FROM resource_bindings WHERE id=?').run(resource);
      this.db.prepare('DELETE FROM resources WHERE id=?').run(resource);
      this.emit('resource.removed',{id:resource,asset:b.asset,generation});return true;
    });
  }
  binding(resource){return this.db.prepare('SELECT * FROM resource_bindings WHERE id=?').get(resource);}
  // A reservation may hold a resource as long as the resource declares; null means indefinitely.
  ownershipLimit(resource){const b=this.binding(resource);return b?.allow_indefinite?null:b?.max_ownership_ms??28800000;}
  takeLeadership() {
    this.leaderToken = id();
    transaction(this.db, () => {
      const old = this.db.prepare('SELECT * FROM leader').get();
      requireThat(!old || old.until_ms <= this.now(), 'LEADER_ACTIVE', 'Another coordinator still owns the leadership lease', 503);
      this.epoch = (old?.epoch || 0) + 1;
      this.db.prepare('INSERT OR REPLACE INTO leader VALUES(1,?,?,?)').run(this.leaderToken, this.epoch, this.now() + this.leaderMs);
      // A restart never assumes the old attempt stopped. Revoke every unfinished grant,
      // except a bounded window: it promised its holder the resource until its deadline,
      // so the driver reconfirms the same generation for the same holder instead.
      for (const claim of this.db.prepare(`SELECT c.*,(r.duration_ms IS NOT NULL AND c.deadline>?) AS resume FROM claims c
        LEFT JOIN reservations r ON r.task_id=c.task_id WHERE c.state IN ('preparing','running')`).all(this.now())) {
        if (claim.resume) {
          this.db.prepare("UPDATE claims SET state='preparing',error='coordinator restarted' WHERE id=?").run(claim.id);
          this.db.prepare("UPDATE tasks SET state='preparing' WHERE id=?").run(claim.task_id);
          this.emit('claim.resuming', { claim: claim.id, generation: claim.generation, reason: 'coordinator restarted' });
          continue;
        }
        this.fence(claim, 'coordinator restarted');
        this.emit('claim.recovering', { claim: claim.id, reason: 'coordinator restarted' });
      }
      upgradeSessionContinuity(this);
      this.emit('coordinator.started', { epoch: this.epoch });
    });
  }
  leaderRow() {
    const row = this.db.prepare('SELECT * FROM leader').get();
    requireThat(row?.token === this.leaderToken && row.until_ms > 0, 'LEADER_LOST', 'Coordinator authority replaced or released; restart and reconcile', 503);
    return row;
  }
  // Called only with the SQLite write lock held. An expired election lease lets
  // a contender take over, but an unchanged token proves none has done so yet.
  renewLeadership(row) {
    const now = this.now();
    this.db.prepare('UPDATE leader SET until_ms=? WHERE token=?').run(now + this.leaderMs, this.leaderToken);
    if (row.until_ms <= now) this.emit('coordinator.lease_recovered', {
      epoch: this.epoch, expiredAt: row.until_ms, resumedAt: now, gapMs: now - row.until_ms
    });
  }
  assertLeader() {
    if (this.leaderRow().until_ms <= this.now()) this.beat();
  }
  mutate(fn) {
    return transaction(this.db, () => {
      const row = this.leaderRow();
      if (row.until_ms <= this.now()) this.renewLeadership(row);
      return fn();
    });
  }
  beat() { transaction(this.db, () => this.renewLeadership(this.leaderRow())); }
  releaseLeadership() {
    this.db.prepare('UPDATE leader SET until_ms=0 WHERE token=?').run(this.leaderToken);
  }
  emit(kind, data) { this.db.prepare('INSERT INTO events(at,kind,data) VALUES(?,?,?)').run(this.now(), kind, JSON.stringify(data)); }
  command(actor, body, operation, fn) {
    text(body.key, 'key', 128);
    const fingerprint = hash(JSON.stringify({ operation, body }));
    return this.mutate(() => {
      const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(actor.id);
      requireThat(!session || (session.closed_at === null && session.expires_at > this.now()), 'SESSION_EXPIRED', 'Session ended', 401);
      const prior = this.db.prepare('SELECT * FROM commands WHERE actor=? AND key=?').get(actor.id, body.key);
      if (prior) {
        requireThat(prior.payload_hash === fingerprint, 'KEY_REUSED', 'Idempotency key has a different payload');
        return JSON.parse(prior.response);
      }
      const response = fn();
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(actor.id, body.key, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  task(taskId) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    requireThat(task, 'NOT_FOUND', 'Unknown task', 404); return task;
  }
  claim(claimId) {
    const claim = this.db.prepare('SELECT * FROM claims WHERE id=?').get(claimId);
    requireThat(claim, 'NOT_FOUND', 'Unknown claim', 404); return claim;
  }
  owned(actor, claimId, active = false) {
    const claim = this.claim(claimId);
    requireThat(claim.actor === actor.id, 'NOT_OWNER', 'Claim belongs to another actor', 403);
    if (active) requireThat(claim.state === 'running' && claim.deadline > this.now(), 'STALE_CLAIM', 'Claim is not active');
    return claim;
  }
  fence(claim, reason) {
    this.db.prepare("UPDATE claims SET state='revoking',outcome=?,error=? WHERE id=?").run(this.retryOutcome(claim.task_id), reason, claim.id);
    this.db.prepare("UPDATE tasks SET state='recovering' WHERE id=?").run(claim.task_id);
  }
  retryOutcome(taskId) {
    const attempts = this.db.prepare('SELECT count(*) AS n FROM claims WHERE task_id=?').get(taskId).n;
    return attempts >= this.task(taskId).max_attempts ? 'failed' : 'queued';
  }
  submit(actor, body) {
    return this.command(actor, body, 'submit', () => {
      text(body.title, 'title', 200); text(body.input, 'input', 8000);
      integer(body.maxAttempts ?? 3, 'maxAttempts', 1, 10);
      requireThat(typeof body.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(body.expectedHash), 'INVALID_INPUT', 'expectedHash must be a SHA-256 digest', 400);
      requireThat(this.db.prepare("SELECT count(*) AS n FROM tasks WHERE state IN ('queued','preparing','running','recovering','releasing','cancelling')").get().n < 5000, 'CAPACITY_LIMIT', 'Active task limit reached', 503);
      if (body.dependency) this.task(body.dependency);
      const resource=body.resource??'artifact';requireThat(this.db.prepare('SELECT id FROM resources WHERE id=?').get(resource),'RESOURCE_UNKNOWN','Register the resource before submitting work',400);
      const taskId = id();
      this.db.prepare("INSERT INTO tasks(id,title,input,expected_hash,resource,dependency,state,checkpoint,result,created_at,max_attempts) VALUES(?,?,?,?,?,?,'queued',NULL,NULL,?,?)")
        .run(taskId, body.title, body.input, body.expectedHash, resource, body.dependency || null, this.now(), body.maxAttempts ?? 3);
      this.emit('task.queued', { task: taskId, actor: actor.id }); return { taskId };
    });
  }
  acquire(actor, body) {
    return this.command(actor, body, 'claim', () => {
      requireThat(this.db.prepare("SELECT value FROM meta WHERE key='paused'").get().value !== 'true', 'PAUSED', 'New admissions are paused');
      integer(body.leaseMs ?? 10000, 'leaseMs', 500, body.taskId && this.task(body.taskId).kind==='reservation' ? 300000 : 30000);
      if(body.resource)requireThat(this.db.prepare('SELECT id FROM resources WHERE id=?').get(body.resource),'RESOURCE_UNKNOWN','Unknown resource',400);
      const task = body.taskId ? this.task(body.taskId) : this.db.prepare(`SELECT t.* FROM tasks t
        LEFT JOIN tasks d ON d.id=t.dependency WHERE t.kind='task' AND t.state='queued' AND (t.dependency IS NULL OR d.state='succeeded')
        AND (? IS NULL OR t.resource=?)
        AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.resource=t.resource AND c.state!='closed')
        ORDER BY t.created_at,t.rowid LIMIT 1`).get(body.resource??null,body.resource??null);
      requireThat(task, 'NO_WORK', 'No eligible queued work');
      requireThat(!body.resource||task.resource===body.resource,'RESOURCE_MISMATCH','Task belongs to another resource');
      requireThat(task.kind!=='reservation'||this.db.prepare('SELECT actor FROM reservations WHERE task_id=?').get(task.id)?.actor===actor.id,'NOT_OWNER','Reservation belongs to another session',403);
      requireThat(task.state === 'queued', 'TASK_BUSY', 'Task is already claimed or terminal');
      requireThat(!task.dependency || this.task(task.dependency).state === 'succeeded', 'DEPENDENCY', 'Dependency has not succeeded');
      const firstReservation=this.db.prepare(`SELECT r.task_id FROM reservations r JOIN tasks t ON t.id=r.task_id
        WHERE t.resource=? AND t.state='queued' ORDER BY t.created_at,t.rowid LIMIT 1`).get(task.resource);
      requireThat(!firstReservation||firstReservation.task_id===task.id,'RESOURCE_BUSY','An earlier reservation is waiting');
      const holder = this.db.prepare("SELECT id FROM claims WHERE resource=? AND state IN ('preparing','running','releasing','revoking')").get(task.resource);
      requireThat(!holder, 'RESOURCE_BUSY', 'Resource is held; release has not been confirmed');
      const duration = task.kind === 'reservation' ? this.db.prepare('SELECT duration_ms FROM reservations WHERE task_id=?').get(task.id)?.duration_ms : null;
      const leaseMs = duration ?? body.leaseMs ?? 10000;
      const limit = this.ownershipLimit(task.resource);
      requireThat(!duration || limit === null || duration <= limit, 'ATTEMPT_LIMIT', 'Reservation window exceeds the resource ownership limit');
      const generation = this.db.prepare('UPDATE resources SET generation=generation+1 WHERE id=? RETURNING generation').get(task.resource).generation;
      const claimId = id();
      this.db.prepare("INSERT INTO claims VALUES(?,?,?,?,?,'preparing',?,NULL,NULL,NULL,?)")
        .run(claimId, task.id, task.resource, actor.id, generation, this.now() + leaseMs, this.now());
      this.db.prepare("UPDATE tasks SET state='preparing' WHERE id=?").run(task.id);
      this.emit('claim.preparing', { claim: claimId, task: task.id, actor: actor.id, generation });
      return { claimId };
    });
  }
  checkpoint(actor, claimId, body) {
    return this.command(actor, body, `checkpoint:${claimId}`, () => {
      const claim = this.owned(actor, claimId, true); text(body.note, 'note', 4000);
      this.db.prepare('UPDATE tasks SET checkpoint=? WHERE id=?').run(body.note, claim.task_id);
      this.emit('task.checkpoint', { task: claim.task_id, claim: claimId }); return { saved: true };
    });
  }
  renew(actor, claimId, body) {
    return this.command(actor, body, `renew:${claimId}`, () => {
      const claim = this.owned(actor, claimId);
      const reservation=this.task(claim.task_id).kind==='reservation';
      requireThat((claim.state === 'running' || (reservation && claim.state === 'preparing')) && claim.deadline > this.now(),
        'STALE_CLAIM', 'Claim is not active');
      const duration = windowDuration(body);
      requireThat(duration === null || reservation, 'INVALID_INPUT', 'Windows are only available for reservations', 400);
      if (duration === null) integer(body.leaseMs, 'leaseMs', 500, reservation?300000:30000);
      const deadline = Math.max(claim.deadline, this.now() + (duration ?? body.leaseMs));
      const limit = reservation ? this.ownershipLimit(claim.resource) : 300000;
      requireThat(limit === null || deadline <= claim.created_at + limit, 'ATTEMPT_LIMIT', 'Ownership reached its maximum duration; release and requeue');
      if (duration !== null) this.db.prepare('UPDATE reservations SET duration_ms=? WHERE task_id=?').run(duration, claim.task_id);
      this.db.prepare('UPDATE claims SET deadline=? WHERE id=?').run(deadline, claimId);
      this.emit('claim.renewed', { claim: claimId, deadline }); return { deadline };
    });
  }
  cancel(actor, taskId, body) {
    requireThat(actor.role === 'admin', 'FORBIDDEN', 'Administrator required', 403);
    return this.command(actor, body, `cancel:${taskId}`, () => {
      const task = this.task(taskId);
      requireThat(!['succeeded','releasing'].includes(task.state), 'ALREADY_ACCEPTED', 'A verified result cannot be cancelled');
      const claim = this.db.prepare("SELECT * FROM claims WHERE task_id=? AND state!='closed'").get(taskId);
      if (claim) {
        this.db.prepare("UPDATE claims SET state='revoking',outcome='cancelled' WHERE id=?").run(claim.id);
        this.db.prepare("UPDATE tasks SET state='cancelling' WHERE id=?").run(taskId);
      } else this.db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(taskId);
      this.emit('task.cancel_requested', { task: taskId, actor: actor.id });
      return { state: claim ? 'cancelling' : 'cancelled' };
    });
  }
  finish(actor, claimId, body, receipt) {
    return this.command(actor, body, `finish:${claimId}`, () => {
      const claim = this.owned(actor, claimId, true), task = this.task(claim.task_id);
      requireThat(receipt.claimId === claim.id && receipt.generation === claim.generation && receipt.sha256 === task.expected_hash,
        'RESULT_REJECTED', 'Driver receipt does not satisfy this task', 422);
      this.db.prepare("UPDATE claims SET state='releasing',outcome='succeeded',result=? WHERE id=?").run(JSON.stringify(receipt), claimId);
      this.db.prepare("UPDATE tasks SET state='releasing' WHERE id=?").run(task.id);
      this.emit('result.verified', { task: task.id, claim: claimId, receipt: receipt.id }); return { accepted: true, state: 'releasing' };
    });
  }
  steer(actor, body) {
    requireThat(actor.role === 'admin', 'FORBIDDEN', 'Administrator required', 403);
    return this.command(actor, body, 'steer', () => {
      requireThat(typeof body.paused === 'boolean', 'INVALID_INPUT', 'paused must be boolean', 400);
      this.db.prepare("UPDATE meta SET value=? WHERE key='paused'").run(String(body.paused));
      this.emit('admission.changed', { paused: body.paused, actor: actor.id }); return { paused: body.paused };
    });
  }
  sweep() {
    this.mutate(() => {
      for (const session of this.db.prepare('SELECT id FROM sessions WHERE closed_at IS NULL AND expires_at<=?').all(this.now())) {
        this.db.prepare('UPDATE sessions SET closed_at=? WHERE id=?').run(this.now(), session.id);
        this.revokeSession(session.id); this.emit('session.expired', {session: session.id});
      }
      for (const claim of this.db.prepare("SELECT * FROM claims WHERE state IN ('preparing','running') AND deadline<=?").all(this.now())) {
        this.fence(claim, 'lease expired');
        this.emit('claim.expired', { claim: claim.id, generation: claim.generation });
      }
    });
  }
  pending() { return this.db.prepare("SELECT * FROM claims WHERE state IN ('preparing','releasing','revoking') ORDER BY created_at").all(); }
  activated(claimId) {
    this.mutate(() => {
      const claim = this.claim(claimId);
      if (claim.state !== 'preparing' || claim.deadline <= this.now()) return;
      this.db.prepare("UPDATE claims SET state='running',error=NULL WHERE id=?").run(claimId);
      this.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(claim.task_id);
      this.emit('claim.active', { claim: claimId, generation: claim.generation });
    });
  }
  released(claimId) {
    this.mutate(() => {
      const claim = this.claim(claimId);
      if (!['releasing','revoking'].includes(claim.state)) return;
      this.db.prepare("UPDATE claims SET state='closed',error=NULL WHERE id=?").run(claimId);
      this.db.prepare('UPDATE tasks SET state=?,result=? WHERE id=?').run(claim.outcome, claim.result, claim.task_id);
      this.emit('claim.released', { claim: claimId, generation: claim.generation, outcome: claim.outcome });
    });
  }
  // A driver that cannot reconfirm a resumed generation fences it as a restart always did.
  refused(claimId, code) {
    this.mutate(() => {
      const claim = this.claim(claimId);
      if (claim.state !== 'preparing') return;
      this.fence(claim, code);
      this.emit('claim.recovering', { claim: claimId, reason: code });
    });
  }
  driverError(claimId, code) {
    this.mutate(() => {
      const claim = this.claim(claimId);
      if (claim.error === code || claim.state === 'closed') return;
      this.db.prepare('UPDATE claims SET error=? WHERE id=?').run(code, claimId);
      this.emit('driver.unavailable', { claim: claimId, reason: code });
    });
  }
  board(after = 0) {
    this.assertLeader();
    const tasks = this.db.prepare('SELECT * FROM tasks ORDER BY created_at,rowid').all();
    const claims = this.db.prepare('SELECT * FROM claims ORDER BY created_at,rowid').all();
    const events = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500').all(after).map(e => ({ ...e, data: JSON.parse(e.data) }));
    const holders = claims.filter(c => c.state !== 'closed');
    for (const task of tasks) task.blockedBy = task.dependency && this.task(task.dependency).state !== 'succeeded' ? 'dependency' : task.state === 'queued' && holders.some(c=>c.resource===task.resource) ? 'resource held' : null;
    return { authority: this.authority, epoch: this.epoch, observedAt: this.now(), paused: this.db.prepare("SELECT value FROM meta WHERE key='paused'").get().value === 'true',
      tasks, claims, sessions:this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all(), resource: { id: 'artifact', capacity: 1, enforcement: 'enforced-at-artifact-API', holders: holders.filter(c=>c.resource==='artifact').map(c => c.id) },
      resources:this.db.prepare('SELECT r.id,b.plugin,b.asset,b.enforcement FROM resources r LEFT JOIN resource_bindings b ON b.id=r.id ORDER BY r.id').all().map(r=>({...r,capacity:1,holders:holders.filter(c=>c.resource===r.id).map(c=>c.id)})), events,
      cursor: events.at(-1)?.seq ?? after, hasMore: events.length === 500 };
  }
}
