// SPDX-License-Identifier: MIT
import { database, transaction, id, hash, equal, bearer, requireThat, text, integer, createHttp, readBody } from './common.mjs';

export const artifactSchema = `
CREATE TABLE state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance TEXT NOT NULL,
 authority TEXT, epoch INTEGER NOT NULL, generation INTEGER NOT NULL, claim_id TEXT, token_hash TEXT);
CREATE TABLE receipts(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, generation INTEGER NOT NULL,
 effect_key TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(claim_id,effect_key));
CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, generation INTEGER NOT NULL, claim_id TEXT, at INTEGER NOT NULL);
`;
export class ArtifactDriver {
  constructor(file, {recover = true, migrations = []} = {}) {
    this.db = database(file, [artifactSchema, ...migrations]);
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO state(singleton,instance,authority,epoch,generation,claim_id,token_hash) VALUES(1,?,NULL,0,0,NULL,NULL)').run(id());
      // Restart invalidates live grants, retaining the high-water mark. Never resurrect them.
      const old = this.status();
      if (recover && old.claim_id) {
        this.audit('restart.revoked', old.generation, old.claim_id);
        this.db.prepare('UPDATE state SET claim_id=NULL,token_hash=NULL').run();
      }
    });
  }
  close() { this.db.close(); }
  status() { return this.db.prepare('SELECT instance,authority,epoch,generation,claim_id FROM state').get(); }
  audit(kind, generation, claimId) { this.db.prepare('INSERT INTO audit(kind,generation,claim_id,at) VALUES(?,?,?,?)').run(kind, generation, claimId, Date.now()); }
  validate(body) {
    text(body.authority, 'authority', 100); text(body.claimId, 'claimId', 100);
    integer(body.epoch, 'epoch', 1, Number.MAX_SAFE_INTEGER);
    integer(body.generation, 'generation', 1, Number.MAX_SAFE_INTEGER);
    const current = this.status();
    requireThat(current.instance === body.instance, 'DRIVER_REPLACED', 'Driver database identity changed; operator reconciliation required', 503);
    requireThat(!current.authority || current.authority === body.authority, 'WRONG_AUTHORITY', 'Driver belongs to a different coordinator', 403);
    requireThat(body.epoch >= current.epoch && body.generation >= current.generation, 'STALE_FENCE', 'Stale authority epoch or generation');
    return current;
  }
  activate(body) {
    return transaction(this.db, () => {
      text(body.credentialHash, 'credentialHash', 64);
      const old = this.validate(body);
      if (body.generation === old.generation) {
        const secret = this.db.prepare('SELECT token_hash FROM state').get().token_hash;
        requireThat(old.claim_id === body.claimId && equal(secret, body.credentialHash), 'REVOKED', 'This generation is no longer active');
      } else {
        requireThat(!old.claim_id, 'DRIVER_BUSY', 'Prior resource owner has not been revoked');
        this.db.prepare('UPDATE state SET authority=?,epoch=?,generation=?,claim_id=?,token_hash=?')
          .run(body.authority, body.epoch, body.generation, body.claimId, body.credentialHash);
        this.audit('grant.active', body.generation, body.claimId);
      }
      this.db.prepare('UPDATE state SET epoch=?').run(body.epoch);
      return { active: true, instance: old.instance, generation: body.generation, claimId: body.claimId };
    });
  }
  revoke(body) {
    return transaction(this.db, () => {
      const old = this.validate(body);
      // A tombstone also fences an activation that has been delayed in the network.
      requireThat(!old.claim_id || old.claim_id === body.claimId, 'OWNER_MISMATCH', 'Cannot revoke a different active attempt');
      this.db.prepare('UPDATE state SET authority=?,epoch=?,generation=?,claim_id=NULL,token_hash=NULL')
        .run(body.authority, body.epoch, body.generation);
      if (old.claim_id || old.generation !== body.generation) this.audit('grant.revoked', body.generation, body.claimId);
      return { released: true, instance: old.instance, generation: body.generation, claimId: body.claimId };
    });
  }
  write(credential, body) {
    return transaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM state').get();
      requireThat(current.claim_id && equal(hash(credential), current.token_hash), 'STALE_GRANT', 'Resource credential is not the active grant');
      text(body.key, 'key', 128); text(body.content, 'content', 8000);
      const digest = hash(body.content);
      const old = this.db.prepare('SELECT * FROM receipts WHERE claim_id=? AND effect_key=?').get(current.claim_id, body.key);
      if (old) {
        requireThat(old.sha256 === digest, 'KEY_REUSED', 'Effect key has different content');
        return this.receipt(old.id);
      }
      requireThat(this.db.prepare('SELECT count(*) AS n FROM receipts').get().n < 100000, 'CAPACITY_LIMIT', 'Artifact limit reached', 503);
      const receiptId = id();
      // The artifact and its receipt commit together. No uncontrolled filesystem effect.
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(receiptId, current.claim_id, current.generation, body.key, digest, body.content, Date.now());
      this.audit('artifact.written', current.generation, current.claim_id);
      return this.receipt(receiptId);
    });
  }
  receipt(receiptId) {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(receiptId);
    requireThat(row, 'NOT_FOUND', 'Unknown receipt', 404);
    return { id: row.id, claimId: row.claim_id, generation: row.generation, sha256: row.sha256, bytes: Buffer.byteLength(row.content), at: row.at };
  }
}

export function driverServer(defaultDriver, controlToken, {resolveDriver,register,list} = {}) {
  return createHttp(async (req, res, url) => {
    const credential = bearer(req);
    const resource=url.searchParams.get('resource')||'artifact';
    const driver=resolveDriver?resolveDriver(resource):defaultDriver;
    if(url.pathname==='/v1/processes'&&req.method==='POST') {requireThat(driver.start,'WRONG_DRIVER','Resource has no process operation');return driver.start(credential,await readBody(req));}
    if(url.pathname==='/v1/processes'&&req.method==='GET') {requireThat(driver.inspect,'WRONG_DRIVER','Resource has no process operation');return driver.inspect(credential);}

    if(url.pathname==='/v1/workloads'&&req.method==='POST'){requireThat(driver.registerExternal,'WRONG_DRIVER','External workloads unsupported');return driver.registerExternal(credential,await readBody(req));}
    if(url.pathname==='/v1/workloads'&&req.method==='GET'){requireThat(driver.externalStatus,'WRONG_DRIVER','External workloads unsupported');return driver.externalStatus(credential);}
    if(url.pathname==='/v1/workloads/start'&&req.method==='POST'){requireThat(driver.launchExternal,'WRONG_DRIVER','External workloads unsupported');return driver.launchExternal(credential,await readBody(req));}
    if (url.pathname === '/v1/artifacts' && req.method === 'POST') {requireThat(resource==='artifact','WRONG_DRIVER','Use the registered driver operation');return driver.write(credential, await readBody(req));}
    requireThat(equal(hash(credential), hash(controlToken)), 'FORBIDDEN', 'Driver control credential required', 403);
    if(url.pathname==='/control/workloads/audit'&&req.method==='GET'){requireThat(driver.externalAudit,'WRONG_DRIVER','External workloads unsupported');return driver.externalAudit();}
    if(url.pathname==='/control/workloads'&&req.method==='POST'){requireThat(driver.adoptExternal,'WRONG_DRIVER','External workloads unsupported');return driver.adoptExternal(await readBody(req));}
    if(url.pathname==='/control/resources'&&req.method==='POST'){requireThat(register,'UNSUPPORTED','Registration unavailable');return register(await readBody(req));}
    if(url.pathname==='/control/resources'&&req.method==='GET')return {resources:list?list():[]};
    if (req.method === 'GET' && url.pathname === '/control/status') return {...driver.status(),...(driver.availability?await driver.availability():{})};
    if (req.method === 'GET' && url.pathname === '/control/audit') return { events: driver.db.prepare('SELECT * FROM audit ORDER BY seq').all() };
    if (req.method === 'GET' && url.pathname.startsWith('/control/receipts/')) return driver.receipt(url.pathname.split('/').at(-1));
    if (req.method === 'GET' && url.pathname.startsWith('/control/artifacts/')) {
      const row = driver.db.prepare('SELECT content FROM receipts WHERE id=?').get(url.pathname.split('/').at(-1));
      requireThat(row, 'NOT_FOUND', 'Unknown artifact', 404); return row;
    }
    if (req.method === 'POST' && url.pathname === '/control/activate') return driver.activate(await readBody(req));
    if (req.method === 'POST' && url.pathname === '/control/revoke') return driver.revoke(await readBody(req));
    requireThat(false, 'NOT_FOUND', 'Unknown driver route', 404);
  });
}
