// SPDX-License-Identifier: MIT
// A compatibility authority remains authoritative: never mirror it with a second lock.
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hash, id, integer, requireThat, text } from "./common.mjs";
export const managerSchema = `CREATE TABLE manager_requests(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id),manager TEXT NOT NULL,resource TEXT NOT NULL,
 payload TEXT NOT NULL,remote_id TEXT,state TEXT NOT NULL DEFAULT 'pending',snapshot TEXT,error TEXT,release_requested INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,queued_until INTEGER NOT NULL,attempted INTEGER NOT NULL DEFAULT 0,last_checked INTEGER NOT NULL DEFAULT 0);`;
const mapState = (s) =>
  ({
    active: "running",
    queued: "queued",
    acquiring: "preparing",
    releasing: "releasing",
    stuck: "recovering",
    released: "released",
    expired: "released",
    withdrawn: "cancelled",
    failed: "failed",
  })[s] ?? "unknown";
export class ResourceManagers {
  constructor(store, data, { configs, fetchImpl = fetch } = {}) {
    this.store = store;
    this.data = data;
    this.boardCache = new Map();
    this.db = store.db;
    this.fetch = fetchImpl;
    this.busy = false;
    this.nextCheck = 0;
    this.configs =
      configs ??
      (existsSync(join(data, "managers.json"))
        ? JSON.parse(readFileSync(join(data, "managers.json"), "utf8"))
        : {});
    for (const [name, c] of Object.entries(this.configs)) {
      requireThat(
        /^[a-z][a-z0-9-]{0,30}$/.test(name) &&
          ["lloom", "schedule-v1"].includes(c.type),
        "MANAGER_CONFIG",
        "Unsupported resource manager",
      );
      const u = new URL(c.url);
      requireThat(
        !u.username &&
          !u.password &&
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost"].includes(u.hostname))),
        "MANAGER_CONFIG",
        "Use HTTPS or a loopback SSH tunnel",
      );
    }
  }
  configure(actor, body) {
    requireThat(actor.role==='admin','FORBIDDEN','Operator required',403);
    const name=body.name;
    requireThat(typeof name==='string'&&/^[a-z][a-z0-9-]{0,30}$/.test(name),'INVALID_INPUT','Invalid manager name',400);
    if(body.ifAbsent===true&&this.configs[name])return {configured:true,existing:true};
    // Adding a native UI must not silently enable a new reservation authority.
    const old=this.configs[name], next={type:body.type??'lloom',url:body.url,readOnly:old?old.readOnly===true:true,
      tokenFile:old?.tokenFile??join(this.data,`manager-${name}.key`),...(body.basePath?{basePath:body.basePath}:{})};
    if(old&&old.url!==next.url)requireThat(!this.db.prepare("SELECT 1 FROM manager_requests WHERE manager=? AND state NOT IN ('released','cancelled','failed','succeeded')").get(name),'MANAGER_ACTIVE','Cannot replace a manager with outstanding reservations');
    new ResourceManagers(this.store,this.data,{configs:{[name]:next},fetchImpl:this.fetch});
    if(body.key!==undefined){
      requireThat(typeof body.key==='string'&&body.key.length<=8192,'INVALID_INPUT','Invalid manager key',400);
      // Never overwrite an arbitrary externally configured token file.
      next.tokenFile=join(this.data,`manager-${name}.key`);
      const temporary=next.tokenFile+'.tmp-'+id();
      writeFileSync(temporary,body.key,{mode:0o600,flag:'wx'});renameSync(temporary,next.tokenFile);
    }
    requireThat(existsSync(next.tokenFile),'INVALID_INPUT','Manager credential required',400);
    const configs={...this.configs,[name]:next}, path=join(this.data,'managers.json'),temporary=path+'.tmp-'+id();
    writeFileSync(temporary,JSON.stringify(configs,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,path);
    this.configs=configs;this.boardCache.delete(name);
    return {configured:true,readOnly:next.readOnly};
  }
  async schedules() {
    return {managers:await Promise.all(Object.keys(this.configs).map(async name=>{
      let cached=this.boardCache.get(name);
      if(!cached||Date.now()-cached.at>5000){
        if(!cached?.flight){
          const entry={at:Date.now()};
          entry.flight=this.call(name,'/gateway/schedule').then(board=>{
            requireThat(Array.isArray(board.resources)&&Array.isArray(board.reservations),'MANAGER_RESPONSE','Invalid manager board');
            if(board.authority==='accord')return {name,state:'migrated',sampledAt:entry.at,board:null};
            return {name,state:'observed',sampledAt:entry.at,readOnly:this.configs[name].readOnly===true,board};
          }).catch(()=>({name,state:'unknown',sampledAt:entry.at,board:null})).then(value=>{entry.value=value;entry.flight=null;return value;});
          this.boardCache.set(name,entry);cached=entry;
        }
      }
      return cached.flight??cached.value;
    }))};
  }
  owns(resource) {
    return (
      typeof resource === "string" &&
      resource.includes(":") &&
      Object.hasOwn(this.configs, resource.split(":")[0])
    );
  }
  async call(manager, path, body) {
    const c = this.configs[manager];
    requireThat(c, "MANAGER_UNKNOWN", "Unknown resource manager", 404);
    if (c.type === "schedule-v1") {
      requireThat(
        typeof c.basePath === "string" &&
          /^\/[a-zA-Z0-9/_-]+$/.test(c.basePath),
        "MANAGER_CONFIG",
        "Generic schedule adapter needs an absolute API basePath",
      );
      path = path.replace("/gateway/schedule", c.basePath.replace(/\/$/, ""));
    }
    const credential = readFileSync(c.tokenFile, "utf8").trim();
    let response;
    try {
      response = await this.fetch(new URL(path, c.url), {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${credential}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Object.assign(
        Error("Resource manager unavailable; ownership unknown"),
        { code: "MANAGER_UNAVAILABLE" },
      );
    }
    requireThat(
      response.ok,
      "MANAGER_UNAVAILABLE",
      "Resource manager did not confirm the operation",
      503,
    );
    const reader = response.body.getReader();
    let size = 0,
      chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        requireThat(
          size <= 2 * 1024 * 1024,
          "MANAGER_RESPONSE",
          "Manager response too large",
        );
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  reserve(actor, body) {
    requireThat(body.durationMs === undefined, 'WINDOW_UNSUPPORTED', 'This compatibility manager does not support reservation windows; use an explicit supervised heartbeat lease');
    return this.store.command(actor, body, "manager.reserve", () => {
      requireThat(
        this.owns(body.resource),
        "RESOURCE_UNKNOWN",
        "Resource manager is not configured",
        404,
      );
      text(body.purpose ?? "reserved", "purpose", 200);
      integer(body.leaseMs ?? 300000, "leaseMs", 60000, 300000);
      integer(body.waitMs ?? 3600000, "waitMs", 1000, 86400000);
      const [manager, ...parts] = body.resource.split(":"),
        resource = parts.join(":");
      text(resource, "resource", 100);
      requireThat(!this.configs[manager].readOnly,"MANAGER_READ_ONLY","This manager is observation-only; reserve through its existing authority",409);
      requireThat(
        this.db.prepare("SELECT count(*) n FROM manager_requests WHERE state NOT IN ('released','cancelled','failed','succeeded')").get().n <
          5000,
        "CAPACITY_LIMIT",
        "Active manager request limit reached",
      );
      const requestId = id(),
        now = this.store.now(),
        payload = {
          resource,
          owner: `accord:${hash(this.store.authority + "/" + requestId).slice(0, 40)}`,
          session: `accord:${this.store.authority}/${actor.id}`,
          purpose: body.purpose ?? "reserved",
          ttlMs: body.leaseMs ?? 300000,
          wait: true,
          apply: true,
          yes: true,
          requestId,
        };
      this.db
        .prepare(
          "INSERT INTO manager_requests(id,actor,manager,resource,payload,created_at,queued_until) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          requestId,
          actor.id,
          manager,
          resource,
          JSON.stringify(payload),
          now,
          now + (body.waitMs ?? 3600000),
        );
      return this.status(actor, requestId);
    });
  }
  row(actor, requestId) {
    const row = this.db
      .prepare("SELECT * FROM manager_requests WHERE id=?")
      .get(requestId);
    requireThat(row, "NOT_FOUND", "Unknown manager reservation", 404);
    requireThat(
      row.actor === actor.id,
      "NOT_OWNER",
      "Reservation belongs to another session",
      403,
    );
    return row;
  }
  status(actor, requestId) {
    const r = this.row(actor, requestId),
      snapshot = r.snapshot ? JSON.parse(r.snapshot) : null;
    return {
      id: r.id,
      resource: `${r.manager}:${r.resource}`,
      state: ["released", "cancelled", "failed"].includes(r.state)
        ? r.state
        : r.error ||
            (snapshot &&
              (this.store.now() - snapshot.observedAt > 10000 ||
                (r.state === "running" &&
                  snapshot.expiresAt !== null &&
                  snapshot.expiresAt <= this.store.now())))
          ? "unknown"
          : r.state,
      claimId: null,
      deadline: snapshot?.expiresAt ?? null,
      queuedUntil: r.queued_until,
      error: r.error,
      manager: r.manager,
      remoteId: r.remote_id,
      enforcement: "manager-confirmed drain and restore",
      observedAt: snapshot?.observedAt ?? null,
    };
  }
  release(actor, body) {
    return this.store.command(actor, body, "manager.release", () => {
      const row = this.row(actor, body.id);
      this.db
        .prepare("UPDATE manager_requests SET release_requested=1 WHERE id=?")
        .run(row.id);
      return this.status(actor, row.id);
    });
  }
  async renew(actor, body) {
    requireThat(body.durationMs === undefined, 'WINDOW_UNSUPPORTED', 'This compatibility manager does not support reservation windows');
    const intent = this.store.command(
      actor,
      body,
      "manager.renew-intent",
      () => {
        const row = this.row(actor, body.id);
        integer(body.leaseMs ?? 300000, "leaseMs", 60000, 300000);
        requireThat(
          row.remote_id && row.state === "running" && !row.release_requested,
          "NOT_RUNNING",
          "Reservation is not confirmed running",
        );
        const until = this.store.now() + (body.leaseMs ?? 300000);
        requireThat(
          until <= row.created_at + 8 * 3600000,
          "LEASE_LIMIT",
          "Release and requeue after eight hours",
        );
        return { until };
      },
    );
    const row = this.row(actor, body.id),
      payload = JSON.parse(row.payload),
      ttlMs = intent.until - this.store.now();
    if (ttlMs > 0)
      await this.call(
        row.manager,
        `/gateway/schedule/reservations/${encodeURIComponent(row.remote_id)}/renew`,
        { owner: payload.owner, expiresAt: intent.until },
      );
    return this.refresh(row);
  }
  async refresh(row) {
    const remote = await this.call(
        row.manager,
        `/gateway/schedule/reservations/${encodeURIComponent(row.remote_id)}`,
      ),
      payload = JSON.parse(row.payload);
    requireThat(
      remote.id === row.remote_id &&
        remote.owner === payload.owner &&
        remote.resource === row.resource,
      "MANAGER_IDENTITY",
      "Manager reservation identity changed",
      503,
    );
    this.store.mutate(() =>
      this.db
        .prepare(
          "UPDATE manager_requests SET state=?,snapshot=?,error=NULL WHERE id=?",
        )
        .run(
          mapState(remote.state),
          JSON.stringify({ ...remote, observedAt: this.store.now() }),
          row.id,
        ),
    );
    if (row.state !== "running" && mapState(remote.state) === "running") this.onRunning?.(row);
    return this.status({ id: row.actor }, row.id);
  }
  async reconcile() {
    if (this.busy || this.store.now() < this.nextCheck) return;
    this.busy = true;
    this.nextCheck = this.store.now() + 2000;
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM manager_requests WHERE state NOT IN ('released','cancelled','failed') ORDER BY last_checked,created_at LIMIT 16",
        )
        .all();
      await Promise.all(
        rows.map(async (original) => {
          let row = original;
          try {
            this.store.mutate(() =>
              this.db
                .prepare(
                  "UPDATE manager_requests SET last_checked=? WHERE id=?",
                )
                .run(this.store.now(), row.id),
            );
            const actor = this.db
                .prepare("SELECT * FROM sessions WHERE id=?")
                .get(row.actor),
              payload = JSON.parse(row.payload),
              ended =
                actor &&
                (actor.closed_at !== null ||
                  actor.expires_at <= this.store.now()),
              cancel =
                row.release_requested ||
                ended ||
                (["pending", "queued"].includes(row.state) &&
                  row.queued_until <= this.store.now());
            if (!row.remote_id) {
              if (cancel && !row.attempted) {
                this.store.mutate(() =>
                  this.db
                    .prepare(
                      "UPDATE manager_requests SET state='cancelled',error=NULL WHERE id=?",
                    )
                    .run(row.id),
                );
                return;
              }
              const board = await this.call(row.manager, "/gateway/schedule");
              requireThat(
                board.capabilities?.includes("reservation-request-id-v1") &&
                  board.capabilities?.includes("reservation-renew-until-v1"),
                "MANAGER_UPGRADE_REQUIRED",
                "Manager must support durable request IDs before Accord can reserve",
                503,
              );
              this.store.mutate(() =>
                this.db
                  .prepare("UPDATE manager_requests SET attempted=1 WHERE id=?")
                  .run(row.id),
              );
              const result = await this.call(
                row.manager,
                "/gateway/schedule/reservations",
                payload,
              );
              requireThat(
                typeof result.id === "string",
                "MANAGER_RESPONSE",
                "Missing reservation ID",
              );
              this.store.mutate(() =>
                this.db
                  .prepare("UPDATE manager_requests SET remote_id=? WHERE id=?")
                  .run(result.id, row.id),
              );
              row = { ...row, remote_id: result.id };
            }
            if (cancel)
              await this.call(
                row.manager,
                `/gateway/schedule/reservations/${encodeURIComponent(row.remote_id)}/release`,
                { owner: payload.owner, apply: true, yes: true },
              );
            await this.refresh(row);
          } catch (e) {
            this.store.mutate(() =>
              this.db
                .prepare("UPDATE manager_requests SET error=? WHERE id=?")
                .run(e.code ?? "MANAGER_UNAVAILABLE", row.id),
            );
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }
  async resources() {
    return (
      await Promise.all(
        Object.keys(this.configs).map(async (manager) => {
          try {
            const board = await this.call(manager, "/gateway/schedule");
            requireThat(
              Array.isArray(board.resources) &&
                Array.isArray(board.reservations),
              "MANAGER_RESPONSE",
              "Invalid manager board",
            );
            if(board.authority==='accord')return [];
            return board.resources.map((resource) => {
              const holders = (resource.holders ?? [])
                .map((id) => {
                  const remote = board.reservations.find((r) => r.id === id);
                  if (!remote) return null;
                  const local = this.db
                    .prepare(
                      "SELECT * FROM manager_requests WHERE manager=? AND remote_id=?",
                    )
                    .get(manager, id);
                  const bound =
                    local &&
                    JSON.parse(local.payload).owner === remote.owner &&
                    local.resource === remote.resource;
                  return {
                    id: remote.id,
                    owner: remote.owner,
                    session: remote.session,
                    state: mapState(remote.state),
                    deadline: remote.expiresAt,
                    ...(bound
                      ? { actor: local.actor, generation: remote.id }
                      : {}),
                  };
                })
                .filter(Boolean);
              const known =
                !resource.error &&
                holders.length === (resource.holders ?? []).length;
              return {
                id: `${this.store.authority}/${manager}:${resource.id}`,
                localId: `${manager}:${resource.id}`,
                manager,
                capacity: resource.capacity,
                hosts: resource.hosts,
                state: !known
                  ? "unknown"
                  : holders.length
                    ? "held"
                    : resource.queue?.length
                      ? "queued"
                      : "unclaimed",
                enforcement: "external manager is authoritative",
                driver: known ? "reachable" : "MANAGER_UNCONFIRMED",
                observedAt: this.store.now(),
                holders,
                holder:
                  known &&
                  holders.length === 1 &&
                  holders[0].actor &&
                  holders[0].deadline > this.store.now()
                    ? holders[0]
                    : null,
              };
            });
          } catch {
            return [
              {
                id: `${this.store.authority}/${manager}:unknown`,
                manager,
                state: "unknown",
                driver: "MANAGER_UNAVAILABLE",
                enforcement: "external manager is authoritative",
              },
            ];
          }
        }),
      )
    ).flat();
  }
}
