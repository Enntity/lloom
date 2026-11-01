// SPDX-License-Identifier: MIT
// State/fingerprint/settle semantics adapted from Tessera Steward and AgentDesk.
import { hash, id, integer, requireThat, text, token } from "./common.mjs";

export const awarenessSchema = `
CREATE TABLE remote_routes(actor TEXT PRIMARY KEY REFERENCES actors(id),authority TEXT NOT NULL,session_id TEXT NOT NULL);
CREATE TABLE session_bindings(source TEXT NOT NULL,external_id TEXT NOT NULL,actor TEXT NOT NULL REFERENCES actors(id),PRIMARY KEY(source,external_id));
CREATE TABLE source_privacy(source TEXT PRIMARY KEY,private INTEGER NOT NULL);
CREATE TABLE session_views(id TEXT PRIMARY KEY REFERENCES actors(id),owner TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT,
 title TEXT NOT NULL,state TEXT NOT NULL,location TEXT NOT NULL,detail TEXT NOT NULL,private INTEGER NOT NULL DEFAULT 0,
 observed_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,progress_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
 fingerprint TEXT NOT NULL,summary TEXT NOT NULL,summary_kind TEXT NOT NULL,summary_revision INTEGER NOT NULL DEFAULT 1,
 expected_at INTEGER,snoozed_until INTEGER NOT NULL DEFAULT 0,UNIQUE(source,external_id));
CREATE TABLE session_activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES session_views(id),
 external_key TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(session_id,external_key));
CREATE VIRTUAL TABLE session_search USING fts5(session_id UNINDEXED,title,location,detail,summary,body,tokenize='unicode61');
CREATE TABLE overseer_rules(id TEXT PRIMARY KEY,config TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE overseer_incidents(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,subject TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES session_views(id),
 state TEXT NOT NULL,evidence TEXT NOT NULL,opened_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_sent INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,episode INTEGER NOT NULL DEFAULT 1,UNIQUE(rule_id,subject));
CREATE TABLE overseer_samples(rule_id TEXT NOT NULL,subject TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(rule_id,subject));
CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id),title TEXT NOT NULL,state TEXT NOT NULL,
 note TEXT NOT NULL,progress TEXT,metrics TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reservation_id TEXT);
CREATE TABLE human_questions(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id),question TEXT NOT NULL,options TEXT NOT NULL,
 state TEXT NOT NULL,answer TEXT,created_at INTEGER NOT NULL,answered_at INTEGER);
`;
// Tessera Redactor patterns; redact before persistence, indexing, or model input.
export function redact(value) {
  let s = String(value ?? "");
  for (const re of [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
    /\blloom_[a-z]+_[0-9a-f]{16,}/g,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}/g,
    /\b(?:r8|hf|jina|xai)_[A-Za-z0-9]{20,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /\baccord_[A-Za-z0-9_-]{20,}/g,
  ])
    s = s.replace(re, "[secret]");
  return s.replace(
    /\b((?:authorization:\s*)?bearer\s+|(?:[A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd))\s*[:=]\s*["']?)([^\s"']{6,})/gi,
    "$1[secret]",
  );
}
const terminal = new Set(["done", "failed", "exited", "cancelled"]);
export const sessionStates = [
  "starting",
  "working",
  "idle",
  "waiting",
  "blocked",
  "done",
  "failed",
  "exited",
  "cancelled",
  "unknown",
];
export class SessionAwareness {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  bind(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only the host launcher may bind native identity",
      403,
    );
    text(body.source, "source", 64);
    text(body.externalId, "externalId", 200);
    requireThat(
      this.db
        .prepare(
          "SELECT id FROM sessions WHERE id=? AND closed_at IS NULL AND expires_at>?",
        )
        .get(body.actor, this.store.now()),
      "SESSION_EXPIRED",
      "Binding requires a live authenticated session",
    );
    return this.store.command(actor, body, "session.bind", () => {
      this.db
        .prepare(
          "INSERT INTO session_bindings VALUES(?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET actor=excluded.actor",
        )
        .run(body.source, body.externalId, body.actor);
      return { bound: true };
    });
  }
  row(session) {
    const row = this.db
      .prepare("SELECT * FROM session_views WHERE id=?")
      .get(session);
    requireThat(row, "NOT_FOUND", "Unknown observed session", 404);
    return row;
  }
  hideInternal(source, externalId) {
    // Host observer classification only: keep the source transcript and durable
    // identity intact, but remove it from collaboration and monitoring views.
    return this.store.mutate(() => {
      const row=this.db.prepare('SELECT id,hidden FROM session_views WHERE source=? AND external_id=?').get(source,externalId);
      if(!row||row.hidden)return;
      this.db.prepare('UPDATE session_views SET hidden=1,revision=revision+1 WHERE id=?').run(row.id);
      this.db.prepare('DELETE FROM session_search WHERE session_id=?').run(row.id);
      this.db.prepare("UPDATE overseer_incidents SET state='resolved',updated_at=? WHERE session_id=?").run(this.store.now(),row.id);
      this.db.prepare('DELETE FROM overseer_samples WHERE subject=?').run(row.id);
      this.store.emit('session.hidden',{session:row.id,reason:'internal-harness-session'});
    });
  }
  public(row) {
    const binding = !row.private && row.source === 'agent'
      ? this.db.prepare('SELECT source,external_id FROM session_bindings WHERE actor=? ORDER BY source,external_id LIMIT 1').get(row.id) : null;
    return {
      ...(binding ? {nativeSession:{source:binding.source,externalId:binding.external_id}} : {}),
      id: row.id,
      address: `${this.store.authority}/${row.id}`,
      source: row.source,
      externalId: row.external_id,
      title: row.private ? "Private session" : row.title,
      state: row.state,
      location: row.private ? "" : row.location,
      private: !!row.private,
      detail: row.private ? "" : row.detail,
      summary: row.private ? "" : row.summary,
      summaryKind: row.summary_kind,
      summaryDetails: row.private ? {} : row.summary_kind === 'model' && row.summary_revision === row.revision
        ? JSON.parse(row.summary_details) : {blocked:['waiting','blocked'].includes(row.state),needs:['waiting','blocked'].includes(row.state)?row.detail:null},
      summaryRevision: row.summary_revision,
      revision: row.revision,
      observedAt: row.observed_at,
      heartbeatAt: row.heartbeat_at,
      progressAt: row.progress_at,
      expectedAt: row.expected_at,
      snoozedUntil: row.snoozed_until,
      presence:
        this.store.now() - row.heartbeat_at < 120000 ? "recent" : "unknown",
      terminal: terminal.has(row.state),
    };
  }
  announce(actor, body) {
    const previous = this.db.prepare('SELECT state FROM session_views WHERE id=?').get(actor.id);
    return this.report(actor, {
      key: hash('report:' + body.key), title: body.label, detail: body.activity,
      location: body.location,
      state: body.state ?? previous?.state ?? 'working',
    });
  }
  report(actor, body) {
    const source = body.source ?? "agent";
    text(source, "source", 64);
    if (source !== "agent")
      requireThat(
        actor.role === "admin",
        "FORBIDDEN",
        "Host adapters require administrator authority",
        403,
      );
    const external =
        source === "agent" ? null : text(body.externalId, "externalId", 200),
      session = external
        ? `observed-${hash(source + "/" + external).slice(0, 40)}`
        : actor.id;
    text(body.title ?? actor.session?.label ?? actor.id, "title", 200);
    requireThat(
      sessionStates.includes(body.state ?? "working"),
      "INVALID_INPUT",
      "Invalid session state",
      400,
    );
    requireThat(
      !body.events || (Array.isArray(body.events) && body.events.length <= 50),
      "INVALID_INPUT",
      "At most 50 events per report",
      400,
    );
    if (body.expectedAt !== undefined && body.expectedAt !== null)
      integer(
        body.expectedAt,
        "expectedAt",
        this.store.now(),
        this.store.now() + 7 * 86400000,
      );
    const events = (body.events ?? []).map((e) => ({
      key: text(e.key, "event key", 200),
      kind: text(e.kind ?? "message", "event kind", 40),
      body: redact(text(e.text, "event text", 16000)),
    }));
    const title = redact(body.title ?? actor.session?.label ?? actor.id),
      location = redact(body.location ?? "").slice(0, 1000),
      detail = redact(body.detail ?? "").slice(0, 4000),
      state = body.state ?? "working",
      privacy =
        body.private === true ||
        this.db
          .prepare("SELECT private FROM source_privacy WHERE source=?")
          .get(source)?.private === 1;
    const persist =
      source === "agent"
        ? (fn) => this.store.command(actor, body, "session.report", fn)
        : (fn) => this.store.mutate(fn);
    return persist(() => {
      const old = this.db
          .prepare("SELECT * FROM session_views WHERE id=?")
          .get(session),
        now = this.store.now();
      requireThat(
        !old || old.owner === actor.id || actor.role === "admin",
        "FORBIDDEN",
        "Session belongs to another adapter",
        403,
      );
      if (!this.db.prepare("SELECT id FROM actors WHERE id=?").get(session))
        this.store.provision(session, token(), "worker");
      const fresh = privacy
        ? []
        : [...new Map(events.map((e) => [e.key, e])).values()].filter(
            (e) =>
              !this.db
                .prepare(
                  "SELECT 1 FROM session_activity WHERE session_id=? AND external_key=?",
                )
                .get(session, e.key),
          );
      const fingerprint = hash(
        JSON.stringify({
          title,
          state,
          location,
          detail: privacy ? "" : detail,
          private: privacy,
          tail: fresh.at(-1)?.body ?? old?.fingerprint,
        }),
      );
      const changed =
        !old ||
        old.title !== title ||
        old.state !== state ||
        old.location !== location ||
        old.detail !== (privacy ? "" : detail) ||
        old.private !== Number(privacy) ||
        fresh.length > 0;
      if (
        body.sourceProgressAt !== undefined &&
        body.sourceProgressAt !== null
      ) {
        requireThat(
          actor.role === "admin",
          "FORBIDDEN",
          "Source timestamps require a host adapter",
          403,
        );
        integer(body.sourceProgressAt, "sourceProgressAt", 0, now);
      }
      const revision = (old?.revision ?? 0) + (changed ? 1 : 0),
        progress = changed ? (body.sourceProgressAt ?? now) : old.progress_at;
      const summary = privacy
        ? ""
        : (detail || fresh.at(-1)?.body || old?.summary || title)
            .replace(/\s+/g, " ")
            .slice(0, 240);
      this.db
        .prepare(
          `INSERT INTO session_views(id,owner,source,external_id,title,state,location,detail,private,observed_at,heartbeat_at,progress_at,revision,fingerprint,summary,summary_kind,summary_revision,expected_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'extractive',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,location=excluded.location,detail=excluded.detail,private=excluded.private,
        observed_at=excluded.observed_at,heartbeat_at=excluded.heartbeat_at,progress_at=excluded.progress_at,revision=excluded.revision,fingerprint=excluded.fingerprint,
        summary=CASE WHEN ? THEN excluded.summary ELSE session_views.summary END,summary_kind=CASE WHEN ? THEN 'extractive' ELSE session_views.summary_kind END,
        summary_revision=CASE WHEN ? THEN excluded.summary_revision ELSE session_views.summary_revision END,expected_at=excluded.expected_at`,
        )
        .run(
          session,
          actor.id,
          source,
          external,
          privacy ? "Private session" : title,
          state,
          privacy ? "" : location,
          privacy ? "" : detail,
          Number(privacy),
          now,
          now,
          progress,
          revision,
          changed ? fingerprint : old.fingerprint,
          summary,
          revision,
          body.expectedAt ?? null,
          Number(changed),
          Number(changed),
          Number(changed),
        );
      if (privacy) {
        this.db
          .prepare("DELETE FROM session_activity WHERE session_id=?")
          .run(session);
        this.db
          .prepare(
            "UPDATE overseer_incidents SET state='resolved',evidence='{}' WHERE session_id=?",
          )
          .run(session);
      } else
        for (const e of fresh)
          this.db
            .prepare(
              "INSERT INTO session_activity(session_id,external_key,at,kind,body) VALUES(?,?,?,?,?)",
            )
            .run(session, e.key, now, e.kind, e.body);
      this.db
        .prepare(
          "DELETE FROM session_activity WHERE session_id=? AND seq NOT IN (SELECT seq FROM session_activity WHERE session_id=? ORDER BY seq DESC LIMIT 500)",
        )
        .run(session, session);
      if (changed) {
        this.index(session);
        this.store.emit("session.observed", {
          session,
          revision,
          state,
          source,
        });
      }
      this.db
        .prepare(
          `INSERT INTO participants VALUES(?,?,? ,?,?,?) ON CONFLICT(actor) DO UPDATE SET label=excluded.label,activity=excluded.activity,location=excluded.location,updated_at=excluded.updated_at`,
        )
        .run(
          session,
          privacy ? "Private session" : title,
          JSON.stringify([source]),
          privacy ? "private session" : summary,
          privacy ? "" : location,
          now,
        );
      return this.public(this.row(session));
    });
  }
  index(session) {
    const r = this.row(session);
    this.db
      .prepare("DELETE FROM session_search WHERE session_id=?")
      .run(session);
    if (!r.private && !r.hidden)
      this.db.prepare("INSERT INTO session_search VALUES(?,?,?,?,?,?)").run(
        session,
        r.title,
        r.location,
        r.detail,
        r.summary,
        this.db
          .prepare(
            "SELECT body FROM session_activity WHERE session_id=? ORDER BY seq DESC LIMIT 100",
          )
          .all(session)
          .map((r) => r.body)
          .join("\n"),
      );
  }
  privacy(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only operator may change source privacy",
      403,
    );
    text(body.source, "source", 64);
    return this.store.command(actor, body, "source.privacy", () => {
      this.db
        .prepare(
          "INSERT INTO source_privacy VALUES(?,?) ON CONFLICT(source) DO UPDATE SET private=excluded.private",
        )
        .run(body.source, Number(body.private === true));
      if (body.private === true) {
        for (const row of this.db
          .prepare("SELECT id FROM session_views WHERE source=?")
          .all(body.source)) {
          this.db
            .prepare(
              "UPDATE session_views SET private=1,title='Private session',location='',detail='',summary='',revision=revision+1 WHERE id=?",
            )
            .run(row.id);
          this.db
            .prepare("DELETE FROM session_activity WHERE session_id=?")
            .run(row.id);
          this.db
            .prepare(
              "UPDATE participants SET label='Private session',activity='private session',location='' WHERE actor=?",
            )
            .run(row.id);
          this.db
            .prepare(
              "UPDATE overseer_incidents SET state='resolved',evidence='{}' WHERE session_id=?",
            )
            .run(row.id);
          this.index(row.id);
        }
      }
      return { source: body.source, private: body.private === true };
    });
  }
  heartbeat(actor) {
    return this.store.mutate(() => {
      const now = this.store.now();
      this.db
        .prepare("UPDATE session_views SET heartbeat_at=? WHERE id=?")
        .run(now, actor.id);
      this.db
        .prepare("UPDATE participants SET updated_at=? WHERE actor=?")
        .run(now, actor.id);
      return { heartbeatAt: now };
    });
  }
  list({ query = "", limit = 50 } = {}) {
    integer(limit, "limit", 1, 200);
    requireThat(
      typeof query === "string" && query.length <= 200,
      "INVALID_INPUT",
      "Query too long",
      400,
    );
    const words = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const rows = words.length
      ? this.db
          .prepare(
            `SELECT v.* FROM session_search f JOIN session_views v ON v.id=f.session_id WHERE v.hidden=0 AND session_search MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(words.map((w) => '"' + w + '"').join(" AND "), limit)
      : this.db
          .prepare(
            "SELECT * FROM session_views WHERE hidden=0 ORDER BY progress_at DESC LIMIT ?",
          )
          .all(limit);
    return { sessions: rows.map((r) => this.public(r)) };
  }
  read(session, { after = 0, limit = 60 } = {}) {
    integer(after, "after", 0, Number.MAX_SAFE_INTEGER);
    integer(limit, "limit", 1, 200);
    const row = this.row(session);
    requireThat(!row.hidden,'NOT_FOUND','Session is internal to its harness',404);
    requireThat(
      !row.private,
      "PRIVATE_SESSION",
      "Session content is private",
      403,
    );
    const events = after
      ? this.db
          .prepare(
            "SELECT seq,at,kind,body FROM session_activity WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
          )
          .all(session, after, limit)
      : this.db
          .prepare(
            "SELECT seq,at,kind,body FROM session_activity WHERE session_id=? ORDER BY seq DESC LIMIT ?",
          )
          .all(session, limit)
          .reverse();
    return {
      session: this.public(row),
      events,
      cursor: events.at(-1)?.seq ?? after,
    };
  }
  summarize(session, revision, summary, details = {}) {
    return this.store.mutate(() => {
      const r = this.row(session);
      if (r.private || r.hidden || r.revision !== revision) return { accepted: false };
      text(summary, "summary", 1000);
      requireThat(details.blocked===undefined||typeof details.blocked==='boolean','INVALID_INPUT','blocked must be boolean',400);
      requireThat(details.needs==null||typeof details.needs==='string'&&details.needs.length<=1000,'INVALID_INPUT','needs must be a short string',400);
      const needs=details.needs?.trim();
      const extra={blocked:details.blocked===true,needs:needs&&!['none','nothing','n/a','no action','-'].includes(needs.toLowerCase().replace(/\.+$/,''))?redact(needs):null};
      this.db
        .prepare(
          "UPDATE session_views SET summary=?,summary_kind='model',summary_revision=?,summary_details=? WHERE id=?",
        )
        .run(redact(summary), revision, JSON.stringify(extra), session);
      this.index(session);
      return { accepted: true };
    });
  }
  snooze(actor, body) {
    const row = this.row(body.id);
    requireThat(
      actor.role === "admin" ||
        row.owner === actor.id ||
        this.db
          .prepare(
            "SELECT 1 FROM session_bindings WHERE source=? AND external_id=? AND actor=?",
          )
          .get(row.source, row.external_id, actor.id),
      "FORBIDDEN",
      "Only owner or operator can snooze",
      403,
    );
    integer(
      body.until,
      "until",
      this.store.now(),
      this.store.now() + 7 * 86400000,
    );
    return this.store.command(actor, body, "session.snooze", () => {
      this.db
        .prepare("UPDATE session_views SET snoozed_until=? WHERE id=?")
        .run(body.until, body.id);
      return this.public(this.row(body.id));
    });
  }
  job(actor, body) {
    return this.store.command(actor, body, "job.update", () => {
      const old =
        body.id &&
        this.db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(body.id);
      requireThat(!body.id || old, "NOT_FOUND", "Unknown job", 404);
      requireThat(
        !old || old.actor === actor.id,
        "NOT_OWNER",
        "Job belongs to another session",
        403,
      );
      const state = body.state ?? old?.state ?? "working";
      requireThat(
        ["working", "waiting", "done", "failed", "cancelled"].includes(state),
        "INVALID_INPUT",
        "Invalid job state",
        400,
      );
      text(body.title ?? old?.title, "title", 200);
      for (const field of ["progress", "metrics"])
        if (body[field] != null)
          requireThat(
            typeof body[field] === "object" &&
              !Array.isArray(body[field]) &&
              JSON.stringify(body[field]).length <= 4000,
            "INVALID_INPUT",
            field + " must be a bounded object",
            400,
          );
      if (body.reservationId) {
        const reservation = this.db
          .prepare(
            "SELECT actor FROM reservations WHERE id=? UNION ALL SELECT actor FROM manager_requests WHERE id=?",
          )
          .get(body.reservationId, body.reservationId);
        requireThat(
          reservation?.actor === actor.id,
          "NOT_OWNER",
          "Attach only your own reservation",
          403,
        );
      }
      const jobId = old?.id ?? id(),
        now = this.store.now();
      this.db
        .prepare(
          "INSERT INTO agent_jobs VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,note=excluded.note,progress=excluded.progress,metrics=excluded.metrics,updated_at=excluded.updated_at",
        )
        .run(
          jobId,
          actor.id,
          redact(body.title ?? old.title),
          state,
          redact(body.note ?? "").slice(0, 4000),
          JSON.stringify(body.progress ?? null),
          JSON.stringify(body.metrics ?? {}),
          old?.created_at ?? now,
          now,
          body.reservationId ?? old?.reservation_id ?? null,
        );
      return this.db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(jobId);
    });
  }
  jobs() {
    return {
      jobs: this.db
        .prepare("SELECT * FROM agent_jobs ORDER BY updated_at DESC LIMIT 200")
        .all()
        .map((j) => ({
          ...j,
          progress: JSON.parse(j.progress),
          metrics: JSON.parse(j.metrics),
          stalled:
            j.state === "working" && this.store.now() - j.updated_at > 900000,
        })),
    };
  }
  ask(actor, body) {
    return this.store.command(actor, body, "question.ask", () => {
      text(body.question, "question", 4000);
      requireThat(
        Array.isArray(body.options ?? []) && (body.options ?? []).length <= 6,
        "INVALID_INPUT",
        "At most six options",
        400,
      );
      for (const o of body.options ?? []) text(o, "option", 200);
      const q = id();
      this.db
        .prepare(
          "INSERT INTO human_questions VALUES(?,?,?,?, 'pending',NULL,?,NULL)",
        )
        .run(
          q,
          actor.id,
          redact(body.question),
          JSON.stringify((body.options ?? []).map(redact)),
          this.store.now(),
        );
      return { id: q, state: "pending" };
    });
  }
  answer(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only operator may answer",
      403,
    );
    return this.store.command(actor, body, "question.answer", () => {
      text(body.answer, "answer", 4000);
      const r = this.db
        .prepare(
          "UPDATE human_questions SET answer=?,state='answered',answered_at=? WHERE id=? AND state='pending'",
        )
        .run(redact(body.answer), this.store.now(), body.id);
      requireThat(r.changes === 1, "NOT_PENDING", "Question is not pending");
      return this.question(actor, body.id);
    });
  }
  dismiss(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only operator may dismiss",
      403,
    );
    return this.store.command(actor, body, "question.dismiss", () => {
      this.db
        .prepare(
          "UPDATE human_questions SET state='dismissed' WHERE id=? AND state='pending'",
        )
        .run(body.id);
      return this.question(actor, body.id);
    });
  }
  question(actor, question) {
    const r = this.db
      .prepare("SELECT * FROM human_questions WHERE id=?")
      .get(question);
    requireThat(r, "NOT_FOUND", "Unknown question", 404);
    requireThat(
      actor.role === "admin" || r.actor === actor.id,
      "NOT_OWNER",
      "Question belongs to another session",
      403,
    );
    return { ...r, options: JSON.parse(r.options) };
  }
}
