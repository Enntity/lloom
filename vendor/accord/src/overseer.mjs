// SPDX-License-Identifier: MIT
import { hash, id, integer, requireThat, text, token } from "./common.mjs";
import { redact } from "./session-awareness.mjs";

export class Overseer {
  constructor(store, awareness, collaboration) {
    this.store = store;
    this.db = store.db;
    this.sessions = awareness;
    this.mail = collaboration;
    this.actor = { id: "accord-overseer", role: "worker" };
    store.mutate(() => {
      if (
        !this.db.prepare("SELECT 1 FROM actors WHERE id=?").get(this.actor.id)
      )
        store.provision(this.actor.id, token(), "worker");
      this.db
        .prepare("INSERT OR IGNORE INTO participants VALUES(?,?,?,?,?,?)")
        .run(
          this.actor.id,
          "Accord overseer",
          '["monitor"]',
          "Watching declared work and registered resource policies",
          "",
          store.now(),
        );
      this.db.prepare("INSERT OR IGNORE INTO overseer_rules VALUES(?,?,1)").run(
        "quiet-work",
        JSON.stringify({
          kind: "quiet-session",
          quietMs: 900000,
          cooldownMs: 900000,
          maxPings: 3,
        }),
      );
    });
  }
  configure(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only operator may configure monitoring",
      403,
    );
    text(body.id, "rule id", 100);
    requireThat(
      ["quiet-session", "idle-resource", "external"].includes(body.kind),
      "INVALID_INPUT",
      "Unknown rule kind",
      400,
    );
    const config = {
      kind: body.kind,
      quietMs: body.quietMs ?? 900000,
      cooldownMs: body.cooldownMs ?? 900000,
      maxPings: body.maxPings ?? 3,
      threshold: body.threshold ?? 5,
      maxAgeMs: body.maxAgeMs ?? 10000,
    };
    integer(config.quietMs, "quietMs", 60000, 7 * 86400000);
    integer(config.cooldownMs, "cooldownMs", 60000, 7 * 86400000);
    integer(config.maxPings, "maxPings", 1, 10);
    integer(config.threshold, "threshold", 0, 100);
    integer(config.maxAgeMs, "maxAgeMs", 1000, 300000);
    if (body.kind === "idle-resource") {
      config.resource = text(body.resource, "resource", 220);
      if (body.telemetryHosts !== undefined) {
        requireThat(
          Array.isArray(body.telemetryHosts) &&
            body.telemetryHosts.length > 0 &&
            body.telemetryHosts.length <= 16,
          "INVALID_INPUT",
          "Use 1..16 linked telemetry hosts",
        );
        config.telemetryHosts = body.telemetryHosts.map((h) =>
          text(h, "host authority", 100),
        );
      }
    }
    if (body.kind === "external")
      config.source = text(body.source, "source", 64);
    return this.store.command(actor, body, "overseer.rule", () => {
      this.db
        .prepare(
          "INSERT INTO overseer_rules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,enabled=excluded.enabled",
        )
        .run(body.id, JSON.stringify(config), Number(body.enabled !== false));
      return { id: body.id, ...config, enabled: body.enabled !== false };
    });
  }
  rules() {
    return this.db
      .prepare("SELECT * FROM overseer_rules")
      .all()
      .map((r) => ({
        id: r.id,
        ...JSON.parse(r.config),
        enabled: !!r.enabled,
      }));
  }
  incidents() {
    return {
      incidents: this.db
        .prepare(
          "SELECT i.* FROM overseer_incidents i JOIN session_views v ON v.id=i.session_id WHERE v.hidden=0 ORDER BY i.updated_at DESC LIMIT 200",
        )
        .all()
        .map((r) => ({ ...r, evidence: JSON.parse(r.evidence) })),
    };
  }
  condition(rule, subject, session, evidence, qualifies, identity) {
    const now = this.store.now();
    return this.store.mutate(() => {
      const old = this.db
        .prepare(
          "SELECT * FROM overseer_incidents WHERE rule_id=? AND subject=?",
        )
        .get(rule.id, subject);
      if (!qualifies) {
        this.db
          .prepare("DELETE FROM overseer_samples WHERE rule_id=? AND subject=?")
          .run(rule.id, subject);
        if (old && old.state !== "resolved")
          this.db
            .prepare(
              "UPDATE overseer_incidents SET state='resolved',updated_at=?,evidence=? WHERE id=?",
            )
            .run(now, JSON.stringify(evidence), old.id);
        return;
      }
      const fingerprint = hash(identity),
        previous = this.db
          .prepare(
            "SELECT * FROM overseer_samples WHERE rule_id=? AND subject=?",
          )
          .get(rule.id, subject);
      if (
        !previous ||
        previous.fingerprint !== fingerprint ||
        now - previous.last_at > Math.max(60000, rule.maxAgeMs ?? 60000)
      ) {
        if (old?.state === "open")
          this.db
            .prepare(
              "UPDATE overseer_incidents SET state='resolved',updated_at=? WHERE id=?",
            )
            .run(now, old.id);
        this.db
          .prepare(
            "INSERT INTO overseer_samples VALUES(?,?,?,?,?) ON CONFLICT(rule_id,subject) DO UPDATE SET first_at=excluded.first_at,last_at=excluded.last_at,fingerprint=excluded.fingerprint",
          )
          .run(rule.id, subject, now, now, fingerprint);
        return;
      }
      this.db
        .prepare(
          "UPDATE overseer_samples SET last_at=? WHERE rule_id=? AND subject=?",
        )
        .run(now, rule.id, subject);
      if (
        now - previous.first_at <
        (rule.kind === "quiet-session" ? 0 : rule.quietMs)
      )
        return;
      if (old?.state === "open") {
        this.db
          .prepare(
            "UPDATE overseer_incidents SET evidence=? WHERE id=?",
          )
          .run(JSON.stringify(evidence), old.id);
        return;
      }
      const incidentId = old?.id ?? id();
      this.db
        .prepare(
          `INSERT INTO overseer_incidents(id,rule_id,subject,session_id,state,evidence,opened_at,updated_at) VALUES(?,?,?,?,'open',?,?,?)
        ON CONFLICT(rule_id,subject) DO UPDATE SET session_id=excluded.session_id,state='open',evidence=excluded.evidence,opened_at=excluded.opened_at,updated_at=excluded.updated_at,last_sent=0,attempts=0,episode=overseer_incidents.episode+1`,
        )
        .run(
          incidentId,
          rule.id,
          subject,
          session,
          JSON.stringify(evidence),
          now,
          now,
        );
      this.store.emit("overseer.opened", {
        incident: incidentId,
        rule: rule.id,
        subject,
        session,
      });
    });
  }
  quietEligible(row) {
    if (this.db.prepare('SELECT 1 FROM sessions WHERE id=? AND closed_at IS NOT NULL').get(row.id)) return false;
    return row.source !== 'agent' || !this.db.prepare('SELECT 1 FROM session_bindings b JOIN session_views n ON n.source=b.source AND n.external_id=b.external_id WHERE b.actor=? AND n.hidden=0').get(row.id);
  }
  quiet() {
    const now = this.store.now();
    for (const rule of this.rules().filter(
      (r) => r.enabled && r.kind === "quiet-session",
    ))
      for (const row of this.db
        .prepare(
          "SELECT v.* FROM session_views v WHERE v.hidden=0 AND NOT EXISTS (SELECT 1 FROM remote_routes r WHERE r.actor=v.id)",
        )
        .all()) {
        const quiet = now - row.progress_at,
          eligible =
            !row.private &&
            this.quietEligible(row) &&
            row.state === "working" &&
            row.snoozed_until <= now &&
            (!row.expected_at || row.expected_at <= now) &&
            quiet >= rule.quietMs;
        this.condition(
          rule,
          row.id,
          row.id,
          {
            kind: "quiet-session",
            state: row.state,
            quietMs: quiet,
            progressAt: row.progress_at,
            heartbeatAt: row.heartbeat_at,
            observedAt: now,
          },
          eligible,
          String(row.revision),
        );
      }
  }
  resource(rule, { resource, holder, utilization, observedAt, stale = false }) {
    const now = this.store.now(),
      session = holder?.actor,
      view =
        session &&
        this.db.prepare("SELECT * FROM session_views WHERE id=?").get(session);
    const valid =
      view &&
      !view.private &&
      view.snoozed_until <= now &&
      holder.state === "running" &&
      Number.isFinite(utilization) &&
      utilization >= 0 &&
      utilization <= 100 &&
      Number.isSafeInteger(observedAt) &&
      observedAt <= now &&
      now - observedAt <= rule.maxAgeMs &&
      !stale;
    this.condition(
      rule,
      resource,
      session ?? "",
      {
        kind: "idle-resource",
        resource,
        holder: holder?.actor ?? null,
        utilization: valid ? utilization : null,
        observedAt,
        unknown: !valid,
      },
      valid && utilization <= rule.threshold,
      JSON.stringify([session, holder?.generation]),
    );
  }
  signal(actor, body) {
    requireThat(
      actor.role === "admin",
      "FORBIDDEN",
      "Only a configured host adapter may supply external evidence",
      403,
    );
    const rule = this.rules().find(
      (r) => r.id === body.rule && r.enabled && r.kind === "external",
    );
    requireThat(
      rule && rule.source === body.source,
      "UNKNOWN_RULE",
      "External rule/source is not configured",
      400,
    );
    const view = this.sessions.row(body.session);
    text(body.subject, "subject", 200);
    text(body.reason, "reason", 2000);
    integer(body.observedAt, "observedAt", 0, this.store.now());
    const eligible =
      body.stuck === true &&
      !view.private &&
      view.snoozed_until <= this.store.now() &&
      this.store.now() - body.observedAt <= rule.maxAgeMs &&
      !["done", "exited", "cancelled"].includes(view.state);
    this.condition(
      rule,
      body.subject,
      view.id,
      {
        kind: "external",
        source: body.source,
        reason: redact(body.reason),
        observedAt: body.observedAt,
      },
      eligible,
      view.id + ":" + view.revision,
    );
    return { accepted: true };
  }
  dispatch() {
    const now = this.store.now(),
      rules = new Map(this.rules().map((r) => [r.id, r]));
    for (const row of this.db
      .prepare(
        "SELECT * FROM overseer_incidents WHERE state='open' ORDER BY opened_at LIMIT 100",
      )
      .all()) {
      const rule = rules.get(row.rule_id),
        session = this.sessions.row(row.session_id);
      if (
        !rule?.enabled ||
        session.hidden ||
        session.private ||
        session.snoozed_until > now ||
        (session.expected_at && session.expected_at > now) ||
        ["done", "failed", "exited", "cancelled", "waiting", "blocked"].includes(
          session.state,
        ) ||
        row.attempts >= rule.maxPings ||
        (row.last_sent && now - row.last_sent < rule.cooldownMs)
      )
        continue;
      const evidence = JSON.parse(row.evidence);
      // Recheck current progress immediately before sending: a report may have
      // arrived since the detector opened this incident.
      if(rule.kind==='quiet-session' && (!this.quietEligible(session)||session.state!=='working'||now-session.progress_at<rule.quietMs))continue;
      if (
        rule.kind !== "quiet-session" &&
        now - evidence.observedAt > rule.maxAgeMs
      )
        continue;
      const why =
        evidence.kind === "quiet-session"
          ? `No meaningful progress reported for ${Math.floor(evidence.quietMs / 60000)} minutes.`
          : evidence.kind === "idle-resource"
            ? `Your held resource ${row.subject} has remained below ${rule.threshold}% utilization.`
            : evidence.reason;
      const key = `overseer:${row.id}:${row.episode}:${row.attempts}`,
        route = this.db
          .prepare("SELECT * FROM remote_routes WHERE actor=?")
          .get(row.session_id);
      const recipient = route
        ? `${route.authority}/${route.session_id}`
        : `${this.store.authority}/${row.session_id}`;
      // The same delivery key survives a crash between queueing and recording the attempt.
      if (
        !this.db
          .prepare("SELECT 1 FROM commands WHERE actor=? AND key=?")
          .get(this.actor.id, key)
      )
        this.mail.send(this.actor, {
          key,
          to: recipient,
          kind: "notification",
          text: `Accord check-in: ${why} Please report progress, a blocker, expected wait, or completion. No resource has been released. Incident ${row.id}.`,
        });
      this.store.mutate(() => {
        this.db
          .prepare(
            "UPDATE overseer_incidents SET last_sent=?,attempts=attempts+1,updated_at=? WHERE id=? AND attempts=?",
          )
          .run(now, now, row.id, row.attempts);
        this.store.emit("overseer.pinged", {
          incident: row.id,
          attempt: row.attempts + 1,
        });
      });
    }
  }
}
