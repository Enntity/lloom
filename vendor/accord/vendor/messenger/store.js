import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomUUID, randomInt, randomBytes, createHash } from "node:crypto";
import { createToken, tokenHash, tokenHint } from "./auth.js";
import { fail } from "./errors.js";

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MESSAGE_LIMIT_BYTES = 64 * 1024;
const DATA_LIMIT_BYTES = 32 * 1024;
const BLOB_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_LEASE_MS = 5 * 60_000;
const PUBLIC_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_PUBLIC_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_PUBLIC_INVITE_TTL_MS = 30 * 24 * 60 * 60_000;
const PUBLIC_BODY_LIMIT_BYTES = 8 * 1024;
const PUBLIC_DAILY_SEND_LIMIT = 500;
const PUBLIC_DAILY_RECIPIENT_LIMIT = 500;
const PUBLIC_TOTAL_LIMIT = 1000;
const PUBLIC_DAILY_REGISTRATION_LIMIT = 100;
const AUDIT_RETENTION = 10_000;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('admin','agent','human','service')),
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX credentials_principal ON credentials(principal_id);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
        title TEXT,
        direct_key TEXT UNIQUE,
        created_by TEXT NOT NULL REFERENCES principals(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        role TEXT NOT NULL CHECK(role IN ('owner','member')),
        joined_at TEXT NOT NULL,
        left_at TEXT,
        PRIMARY KEY(conversation_id, principal_id)
      );
      CREATE INDEX conversation_members_principal
        ON conversation_members(principal_id, conversation_id);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author_id TEXT NOT NULL REFERENCES principals(id),
        client_message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        data_json TEXT,
        reply_to TEXT REFERENCES messages(id),
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, seq),
        UNIQUE(author_id, client_message_id)
      );
      CREATE INDEX messages_conversation_seq ON messages(conversation_id, seq);
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES principals(id),
        state TEXT NOT NULL CHECK(state IN ('pending','offered','read','acknowledged','dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        offered_at TEXT,
        read_at TEXT,
        acknowledged_at TEXT,
        lease_expires_at TEXT,
        dead_reason TEXT,
        UNIQUE(message_id, recipient_id)
      );
      CREATE INDEX deliveries_recipient_state
        ON deliveries(recipient_id, state, lease_expires_at);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE deliveries ADD COLUMN available_at TEXT;
      CREATE INDEX deliveries_recipient_available
        ON deliveries(recipient_id, state, available_at, lease_expires_at);
      CREATE UNIQUE INDEX messages_one_authored_reply
        ON messages(author_id, reply_to) WHERE reply_to IS NOT NULL;
      CREATE TABLE conversation_aliases (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, alias)
      );
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        data_json TEXT,
        reply_to TEXT REFERENCES messages(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX drafts_author_updated ON drafts(author_id, updated_at);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE blobs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES principals(id),
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX blobs_owner_created ON blobs(owner_id, created_at);
      CREATE TABLE message_blobs (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        blob_id TEXT NOT NULL REFERENCES blobs(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY(message_id, blob_id),
        UNIQUE(message_id, ordinal)
      );
      CREATE TABLE draft_blobs (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        blob_id TEXT NOT NULL REFERENCES blobs(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY(draft_id, blob_id),
        UNIQUE(draft_id, ordinal)
      );
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE deliveries ADD COLUMN lease_token TEXT;
    `
  },
  {
    version: 5,
    sql: `
      ALTER TABLE drafts ADD COLUMN client_draft_id TEXT;
      CREATE UNIQUE INDEX drafts_author_client_id
        ON drafts(author_id, client_draft_id) WHERE client_draft_id IS NOT NULL;
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE principals ADD COLUMN public_address TEXT;
      ALTER TABLE principals ADD COLUMN public_registered INTEGER NOT NULL DEFAULT 0
        CHECK(public_registered IN (0,1));
      ALTER TABLE principals ADD COLUMN public_discoverable INTEGER NOT NULL DEFAULT 1
        CHECK(public_discoverable IN (0,1));
      ALTER TABLE credentials ADD COLUMN expires_at TEXT;
      CREATE UNIQUE INDEX principals_public_address ON principals(public_address)
        WHERE public_address IS NOT NULL;
      CREATE INDEX principals_public_registered ON principals(public_registered, created_at);
      CREATE TABLE public_blocks (
        recipient_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        blocked_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(recipient_id, blocked_principal_id)
      );
      CREATE INDEX public_blocks_blocked ON public_blocks(blocked_principal_id);
      CREATE TABLE security_audit_events (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
        remote_address TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX security_audit_events_created ON security_audit_events(created_at, id);
    `
  },
  {
    version: 7,
    sql: `
      CREATE TABLE public_invites (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
        revoked_at TEXT
      );
      CREATE INDEX public_invites_active
        ON public_invites(expires_at, used_at, revoked_at);
    `
  }
];

export class MessengerStore {
  checkReady() {
    this.db.prepare("SELECT 1").get();
  }

  constructor(file, { leaseMs = DEFAULT_LEASE_MS, blobDir = null, requireInvite = true } = {}) {
    if (!file) throw new Error("A database path is required");
    this.file = path.resolve(file);
    this.blobDir = path.resolve(blobDir || path.join(path.dirname(this.file), "blobs"));
    this.leaseMs = Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS);
    this.publicInviteRequired = Boolean(requireInvite);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    this.#migrate();
    this.#ensurePublicAddresses();
    try { chmodSync(this.file, 0o600); } catch {}
  }

  close() {
    this.db.close();
  }

  #migrate() {
    const appliedRows = this.db.prepare("SELECT version, checksum FROM schema_migrations").all();
    const applied = new Map(appliedRows.map((row) => [Number(row.version), row.checksum]));
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== checksum) {
          throw new Error(`Migration checksum mismatch at version ${migration.version}`);
        }
        continue;
      }
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?,?,?)"
        ).run(migration.version, checksum, nowIso());
      });
    }
  }

  #ensurePublicAddresses() {
    const rows = this.db.prepare(`
      SELECT id FROM principals
      WHERE kind != 'admin' AND public_address IS NULL
    `).all();
    if (!rows.length) return;
    this.transaction(() => {
      const update = this.db.prepare("UPDATE principals SET public_address = ? WHERE id = ?");
      for (const row of rows) update.run(this.#newPublicAddress(), row.id);
    });
  }

  #newPublicAddress() {
    let address;
    do {
      address = `x${String(randomInt(0, 1_000_000_000_000)).padStart(12, "0")}`;
    } while (this.db.prepare("SELECT 1 FROM principals WHERE public_address = ?").get(address));
    return address;
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  bootstrapAdmin({ handle = "admin", displayName = "Administrator" } = {}) {
    const existing = this.db.prepare(
      "SELECT p.* FROM principals p WHERE p.kind = 'admin' AND p.retired_at IS NULL LIMIT 1"
    ).get();
    if (existing) fail("ALREADY_INITIALIZED", "An administrator already exists", 409);
    return this.createPrincipal({ handle, displayName, kind: "admin" });
  }

  createPrincipal({ handle, displayName = null, kind = "agent" } = {}) {
    const normalized = normalizeHandle(handle);
    const principalKind = String(kind || "agent").toLowerCase();
    if (!["admin", "agent", "human", "service"].includes(principalKind)) {
      fail("INVALID_PRINCIPAL_KIND", "Principal kind is invalid");
    }
    const id = `prn_${randomUUID()}`;
    const token = createToken();
    const createdAt = nowIso();
    const publicAddress = principalKind === "admin" ? null : this.#newPublicAddress();
    try {
      this.transaction(() => {
        this.db.prepare(`
          INSERT INTO principals(id, handle, display_name, kind, created_at, public_address)
          VALUES(?,?,?,?,?,?)
        `).run(id, normalized, compact(displayName || normalized, 120), principalKind, createdAt, publicAddress);
        this.db.prepare(`
          INSERT INTO credentials(id, principal_id, token_hash, token_hint, created_at)
          VALUES(?,?,?,?,?)
        `).run(`cred_${randomUUID()}`, id, tokenHash(token), tokenHint(token), createdAt);
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: principals.handle")) {
        fail("HANDLE_EXISTS", `Principal handle already exists: ${normalized}`, 409);
      }
      throw error;
    }
    return {
      principal: {
        id,
        handle: normalized,
        ...(publicAddress ? { address: publicAddress } : {}),
        displayName: compact(displayName || normalized, 120),
        kind: principalKind,
        createdAt
      },
      token
    };
  }

  issueCredential(handle) {
    const principal = this.principalByHandle(handle);
    if (!principal) fail("UNKNOWN_PRINCIPAL", `Unknown principal: ${handle}`, 404);
    const id = `cred_${randomUUID()}`;
    const token = createToken();
    const createdAt = nowIso();
    const expiresAt = principal.publicRegistered
      ? new Date(Date.now() + PUBLIC_CREDENTIAL_TTL_MS).toISOString()
      : null;
    this.transaction(() => {
      if (principal.publicRegistered) {
        this.db.prepare(`
          UPDATE credentials SET revoked_at = ?
          WHERE principal_id = ? AND revoked_at IS NULL
        `).run(createdAt, principal.id);
      }
      this.db.prepare(`
        INSERT INTO credentials(id, principal_id, token_hash, token_hint, created_at, expires_at)
        VALUES(?,?,?,?,?,?)
      `).run(id, principal.id, tokenHash(token), tokenHint(token), createdAt, expiresAt);
      if (principal.publicRegistered) this.recordSecurityEvent("credential_rotate", principal.id, null, {});
    });
    return {
      credential: { id, principalId: principal.id, tokenHint: tokenHint(token), createdAt, revokedAt: null, expiresAt },
      token
    };
  }

  listCredentials(handle) {
    const principal = this.principalByHandle(handle);
    if (!principal) fail("UNKNOWN_PRINCIPAL", `Unknown principal: ${handle}`, 404);
    return this.db.prepare(`
      SELECT id, principal_id, token_hint, created_at, revoked_at, expires_at
      FROM credentials WHERE principal_id = ? ORDER BY created_at
    `).all(principal.id).map(publicCredential);
  }

  revokeCredential(credentialId) {
    const row = this.db.prepare(`
      SELECT c.id, c.principal_id, c.token_hint, c.created_at, c.revoked_at, c.expires_at, p.kind
      FROM credentials c JOIN principals p ON p.id = c.principal_id
      WHERE c.id = ?
    `).get(credentialId);
    if (!row) fail("CREDENTIAL_NOT_FOUND", "Credential was not found", 404);
    if (row.revoked_at) return publicCredential(row);
    if (row.kind === "admin") {
      const active = this.db.prepare(`
        SELECT COUNT(*) AS count FROM credentials
        WHERE principal_id = ? AND revoked_at IS NULL
      `).get(row.principal_id);
      if (Number(active.count) <= 1) {
        fail("LAST_ADMIN_CREDENTIAL", "Issue a replacement before revoking the last administrator credential", 409);
      }
    }
    this.db.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ?")
      .run(nowIso(), credentialId);
    return publicCredential(this.db.prepare(`
      SELECT id, principal_id, token_hint, created_at, revoked_at, expires_at
      FROM credentials WHERE id = ?
    `).get(credentialId));
  }

  authenticate(token) {
    const row = this.db.prepare(`
      SELECT p.id, p.handle, p.public_address, p.public_registered, p.public_discoverable,
             p.display_name, p.kind, p.created_at, c.id AS credential_id, c.expires_at
      FROM credentials c
      JOIN principals p ON p.id = c.principal_id
      WHERE c.token_hash = ? AND c.revoked_at IS NULL AND p.retired_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > ?)
    `).get(tokenHash(token), nowIso());
    if (!row) fail("INVALID_CREDENTIAL", "Bearer credential is invalid", 401);
    const principal = publicPrincipal(row);
    Object.defineProperty(principal, "_credentialId", { value: row.credential_id, enumerable: false });
    Object.defineProperty(principal, "_credentialExpiresAt", { value: row.expires_at || null, enumerable: false });
    return principal;
  }

  requireAdmin(principal) {
    if (principal?.kind !== "admin") fail("ADMIN_REQUIRED", "Administrator authority is required", 403);
  }

  listPrincipals({ includeRetired = false, actor = null } = {}) {
    if (actor && this.isPublicPrincipal(actor)) return this.listPublicDirectory(actor);
    const clauses = [];
    if (!includeRetired) clauses.push("retired_at IS NULL");
    if (actor && actor.kind !== "admin") clauses.push("kind != 'admin'");
    const rows = this.db.prepare(`
      SELECT id, handle, public_address, public_registered, public_discoverable,
             display_name, kind, created_at, retired_at
      FROM principals
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY handle
    `).all();
    return rows.map(publicPrincipal);
  }

  principalByHandle(handle) {
    const normalized = normalizeHandle(handle);
    const row = this.db.prepare(`
      SELECT id, handle, public_address, public_registered, public_discoverable,
             display_name, kind, created_at, retired_at
      FROM principals WHERE handle = ? AND retired_at IS NULL
    `).get(normalized);
    if (row) return publicPrincipal(row);
    if (/^x\d{12}$/.test(normalized)) {
      const addressRow = this.db.prepare(`
        SELECT id, handle, public_address, public_registered, public_discoverable,
               display_name, kind, created_at, retired_at
        FROM principals WHERE public_address = ? AND retired_at IS NULL AND kind != 'admin'
      `).get(normalized);
      return addressRow ? publicPrincipal(addressRow) : null;
    }
    return null;
  }

  principalByAddress(address) {
    const normalized = normalizePublicAddress(address);
    const row = this.db.prepare(`
      SELECT id, handle, public_address, public_registered, public_discoverable,
             display_name, kind, created_at, retired_at
      FROM principals
      WHERE public_address = ? AND retired_at IS NULL AND kind != 'admin'
    `).get(normalized);
    return row ? publicPrincipal(row) : null;
  }

  publicAddressProfile(actor, address) {
    const principal = this.principalByAddress(address);
    if (!principal) fail("ADDRESS_NOT_FOUND", "Public address was not found", 404);
    return publicProfile(principal);
  }

  listPublicDirectory(actor) {
    const rows = this.db.prepare(`
      SELECT id, handle, public_address, public_registered, public_discoverable,
             display_name, kind, created_at
      FROM principals
      WHERE retired_at IS NULL AND kind != 'admin'
        AND ((public_registered = 1 AND public_discoverable = 1) OR id = ?)
      ORDER BY public_address
    `).all(actor.id);
    return rows.map((row) => publicProfile(publicPrincipal(row)));
  }

  isPublicPrincipal(actor) {
    if (actor?.publicRegistered != null) return Boolean(actor.publicRegistered);
    if (!actor?.id) return false;
    const row = this.db.prepare("SELECT public_registered FROM principals WHERE id = ?").get(actor.id);
    return Boolean(row?.public_registered);
  }

  issuePublicInvite(actor, { expiresInMs = DEFAULT_PUBLIC_INVITE_TTL_MS, now = new Date() } = {}) {
    this.requireAdmin(actor);
    const at = toDate(now);
    const duration = boundedInviteTtl(expiresInMs);
    const id = `inv_${randomUUID()}`;
    const code = randomBytes(24).toString("base64url");
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + duration).toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO public_invites(id, code_hash, created_at, expires_at)
        VALUES(?,?,?,?)
      `).run(id, tokenHash(code), createdAt, expiresAt);
      this.recordSecurityEvent("invite_issued", actor.id, null, { inviteId: id, expiresAt });
    });
    return {
      invite: { id, createdAt, expiresAt, usedAt: null, revokedAt: null },
      code
    };
  }

  publicRegistration({ displayName, discoverable = true, inviteCode = null, now = new Date() } = {}) {
    const name = validatePublicDisplayName(displayName);
    if (typeof discoverable !== "boolean") fail("INVALID_DISCOVERABLE", "discoverable must be a boolean");
    if (this.publicInviteRequired && !String(inviteCode || "").trim()) {
      fail("INVITE_REQUIRED", "A one-use invite code is required", 400);
    }
    const normalizedInviteCode = this.publicInviteRequired ? validateInviteCode(inviteCode) : null;
    const at = toDate(now);
    const dayStart = utcDayStart(at);
    const id = `prn_${randomUUID()}`;
    const address = this.#newPublicAddress();
    const token = createToken();
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + PUBLIC_CREDENTIAL_TTL_MS).toISOString();
    let principal;
    try {
      this.transaction(() => {
        let invite = null;
        if (this.publicInviteRequired) {
          invite = this.db.prepare(`
            SELECT id, expires_at, used_at, revoked_at FROM public_invites
            WHERE code_hash = ?
          `).get(tokenHash(normalizedInviteCode));
          if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= createdAt) {
            fail("INVALID_INVITE", "Invite code is invalid or expired", 400);
          }
        }
        const total = this.db.prepare(
          "SELECT COUNT(*) AS count FROM principals WHERE public_registered = 1"
        ).get();
        if (Number(total.count) >= PUBLIC_TOTAL_LIMIT) {
          fail("PUBLIC_PRINCIPAL_LIMIT", "Public registration capacity has been reached", 429);
        }
        const daily = this.db.prepare(`
          SELECT COUNT(*) AS count FROM principals
          WHERE public_registered = 1 AND created_at >= ?
        `).get(dayStart);
        if (Number(daily.count) >= PUBLIC_DAILY_REGISTRATION_LIMIT) {
          fail("PUBLIC_REGISTRATION_LIMIT", "Public registration limit has been reached for today", 429);
        }
        this.db.prepare(`
          INSERT INTO principals(id, handle, public_address, display_name, kind, created_at,
            public_registered, public_discoverable)
          VALUES(?,?,?,?,?,?,1,?)
        `).run(id, address, address, name, "agent", createdAt, discoverable ? 1 : 0);
        this.db.prepare(`
          INSERT INTO credentials(id, principal_id, token_hash, token_hint, created_at, expires_at)
          VALUES(?,?,?,?,?,?)
        `).run(`cred_${randomUUID()}`, id, tokenHash(token), tokenHint(token), createdAt, expiresAt);
        if (invite) {
          const consumed = this.db.prepare(`
            UPDATE public_invites SET used_at = ?, used_principal_id = ?
            WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          `).run(createdAt, id, invite.id, createdAt);
          if (Number(consumed.changes) !== 1) fail("INVALID_INVITE", "Invite code is invalid or expired", 400);
        }
        this.recordSecurityEvent("registration", id, null, {
          discoverable,
          ...(invite ? { inviteId: invite.id } : {})
        });
        principal = {
          id,
          handle: address,
          address,
          displayName: name,
          kind: "agent",
          createdAt,
          publicRegistered: true,
          publicDiscoverable: discoverable
        };
      });
    } catch (error) {
      if (error?.code === "PUBLIC_PRINCIPAL_LIMIT" || error?.code === "PUBLIC_REGISTRATION_LIMIT" || error?.code === "INVALID_INVITE") {
        this.recordSecurityEvent("registration_rejected", null, null, { code: error.code });
        throw error;
      }
      if (String(error.message).includes("UNIQUE constraint failed")) {
        fail("ADDRESS_COLLISION", "Please retry registration", 503);
      }
      throw error;
    }
    return {
      principal: publicProfile(principal),
      token,
      expiresAt,
      next: {
        me: "/v1/me",
        directory: "/v1/principals",
        renew: "/v1/me/credentials",
        inbox: "/v1/inbox"
      }
    };
  }

  renewPublicCredential(actor, { now = new Date() } = {}) {
    if (!this.isPublicPrincipal(actor)) fail("PUBLIC_PRINCIPAL_REQUIRED", "Only public principals may renew credentials", 403);
    const currentId = actor._credentialId;
    if (!currentId) fail("CREDENTIAL_REQUIRED", "The current credential is required", 401);
    const at = toDate(now);
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + PUBLIC_CREDENTIAL_TTL_MS).toISOString();
    const token = createToken();
    let credential;
    this.transaction(() => {
      const current = this.db.prepare(`
        SELECT c.id, c.revoked_at, c.expires_at FROM credentials c
        WHERE c.id = ? AND c.principal_id = ?
      `).get(currentId, actor.id);
      if (!current || current.revoked_at || (current.expires_at && current.expires_at <= createdAt)) {
        fail("INVALID_CREDENTIAL", "Bearer credential is invalid", 401);
      }
      this.db.prepare(`
        UPDATE credentials SET revoked_at = ?
        WHERE principal_id = ? AND revoked_at IS NULL
      `).run(createdAt, actor.id);
      const id = `cred_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO credentials(id, principal_id, token_hash, token_hint, created_at, expires_at)
        VALUES(?,?,?,?,?,?)
      `).run(id, actor.id, tokenHash(token), tokenHint(token), createdAt, expiresAt);
      this.recordSecurityEvent("credential_rotate", actor.id, null, {});
      credential = { id, principalId: actor.id, tokenHint: tokenHint(token), createdAt, revokedAt: null, expiresAt };
    });
    return { credential, token, expiresAt };
  }

  listBlocks(actor) {
    return this.db.prepare(`
      SELECT p.public_address, p.display_name, b.created_at
      FROM public_blocks b JOIN principals p ON p.id = b.blocked_principal_id
      WHERE b.recipient_id = ? ORDER BY p.public_address
    `).all(actor.id).map((row) => ({
      address: row.public_address,
      displayName: row.display_name,
      createdAt: row.created_at
    }));
  }

  blockPublicPrincipal(actor, address) {
    const target = this.principalByAddress(address);
    if (!target || !target.publicRegistered) fail("PUBLIC_ADDRESS_NOT_FOUND", "Public address was not found", 404);
    if (target.id === actor.id) fail("INVALID_BLOCK_TARGET", "A principal cannot block itself");
    const createdAt = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO public_blocks(recipient_id, blocked_principal_id, created_at)
        VALUES(?,?,?) ON CONFLICT(recipient_id, blocked_principal_id) DO NOTHING
      `).run(actor.id, target.id, createdAt);
      this.recordSecurityEvent("block", actor.id, null, { blockedAddress: target.address });
    });
    return { address: target.address, blocked: true };
  }

  unblockPublicPrincipal(actor, address) {
    const target = this.principalByAddress(address);
    if (!target || !target.publicRegistered) fail("PUBLIC_ADDRESS_NOT_FOUND", "Public address was not found", 404);
    this.transaction(() => {
      this.db.prepare("DELETE FROM public_blocks WHERE recipient_id = ? AND blocked_principal_id = ?")
        .run(actor.id, target.id);
      this.recordSecurityEvent("unblock", actor.id, null, { blockedAddress: target.address });
    });
    return { address: target.address, blocked: false };
  }

  isBlocked(recipientId, publicPrincipalId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM public_blocks
      WHERE recipient_id = ? AND blocked_principal_id = ?
    `).get(recipientId, publicPrincipalId));
  }

  recordSecurityEvent(event, principalId = null, remoteAddress = null, details = {}) {
    const safeDetails = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (["body", "token", "authorization", "password", "secret"].some((part) => key.toLowerCase().includes(part))) continue;
      if (["string", "number", "boolean"].includes(typeof value) || value === null) safeDetails[key] = value;
    }
    try {
      this.db.prepare(`
        INSERT INTO security_audit_events(id, event, principal_id, remote_address, details_json, created_at)
        VALUES(?,?,?,?,?,?)
      `).run(`audit_${randomUUID()}`, compact(event, 80), principalId, compact(remoteAddress, 120) || null,
        JSON.stringify(safeDetails), nowIso());
      this.db.prepare(`
        DELETE FROM security_audit_events WHERE id IN (
          SELECT id FROM security_audit_events ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(AUDIT_RETENTION);
    } catch {
      // Security telemetry must never turn a completed product operation into a failure.
    }
  }

  publicQuotaLimits() {
    return {
      registrationPerDay: PUBLIC_DAILY_REGISTRATION_LIMIT,
      totalPublicPrincipals: PUBLIC_TOTAL_LIMIT,
      sendsPerPrincipalPerDay: PUBLIC_DAILY_SEND_LIMIT,
      deliveriesPerRecipientPerDay: PUBLIC_DAILY_RECIPIENT_LIMIT,
      bodyBytes: PUBLIC_BODY_LIMIT_BYTES,
      longPollsPerPrincipal: 2,
      credentialDays: 30
    };
  }

  enforcePublicSendLimits(actor, conversationId, recipients, text, dataJson, attachments, now = new Date()) {
    if (!this.isPublicPrincipal(actor)) return;
    if (attachments.length) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ATTACHMENTS_FORBIDDEN" });
      fail("PUBLIC_ATTACHMENTS_FORBIDDEN", "Public principals cannot attach blobs", 403);
    }
    const publicContentBytes = Buffer.byteLength(text, "utf8") + Buffer.byteLength(dataJson || "", "utf8");
    if (publicContentBytes > PUBLIC_BODY_LIMIT_BYTES) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BODY_TOO_LARGE" });
      fail("PUBLIC_BODY_TOO_LARGE", `Public message content exceeds ${PUBLIC_BODY_LIMIT_BYTES} bytes`, 413);
    }
    const dayStart = utcDayStart(toDate(now));
    const authored = this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages m
      JOIN principals p ON p.id = m.author_id
      WHERE m.author_id = ? AND p.public_registered = 1 AND m.created_at >= ?
    `).get(actor.id, dayStart);
    if (Number(authored.count) >= PUBLIC_DAILY_SEND_LIMIT) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_SEND_LIMIT" });
      fail("PUBLIC_SEND_LIMIT", "Public daily send limit has been reached", 429);
    }
    for (const recipient of recipients) {
      if (this.isBlocked(recipient.principal_id, actor.id)) {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BLOCKED" });
        fail("PUBLIC_BLOCKED", "The recipient has blocked this public principal", 403);
      }
      const deliveries = this.db.prepare(`
        SELECT COUNT(*) AS count FROM deliveries d
        JOIN messages m ON m.id = d.message_id
        JOIN principals p ON p.id = m.author_id
        WHERE d.recipient_id = ? AND p.public_registered = 1 AND m.created_at >= ?
      `).get(recipient.principal_id, dayStart);
      if (Number(deliveries.count) >= PUBLIC_DAILY_RECIPIENT_LIMIT) {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_RECIPIENT_LIMIT" });
        fail("PUBLIC_RECIPIENT_LIMIT", "Recipient public delivery limit has been reached", 429);
      }
    }
  }

  assertPublicConversationAllowed(actor, principals) {
    for (const principal of principals) {
      if (principal.id === actor.id || !this.isBlocked(principal.id, actor.id)) continue;
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BLOCKED" });
      fail("PUBLIC_BLOCKED", "The recipient has blocked this public principal", 403);
    }
  }

  publicConversationState(conversationId) {
    const row = this.db.prepare(`
      SELECT c.kind,
        EXISTS(
          SELECT 1 FROM conversation_members cm
          JOIN principals p ON p.id = cm.principal_id
          WHERE cm.conversation_id = c.id AND cm.left_at IS NULL AND p.public_registered = 1
        ) AS has_public
      FROM conversations c WHERE c.id = ?
    `).get(conversationId);
    const hasPublic = Boolean(row?.has_public);
    if (hasPublic && row.kind !== "direct") {
      fail("PUBLIC_DIRECT_ONLY", "Conversations containing public principals must be direct", 403);
    }
    return hasPublic;
  }

  createConversation(actor, { members = [], title = null, kind = null, clientConversationId = null } = {}, internal = false) {
    const publicActor = this.isPublicPrincipal(actor);
    if (publicActor && !internal) {
      if (!Array.isArray(members) || members.length !== 1 || (kind && kind !== "direct") || title) {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DIRECT_ONLY" });
        fail("PUBLIC_DIRECT_ONLY", "Public principals may create only one-to-one direct conversations", 403);
      }
      const target = this.principalByAddress(members[0]);
      if (!target || target.id === actor.id || target.kind === "admin") {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ADDRESS_NOT_FOUND" });
        fail("PUBLIC_ADDRESS_NOT_FOUND", "Public address was not found", 404);
      }
      if (this.isBlocked(target.id, actor.id)) {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BLOCKED" });
        fail("PUBLIC_BLOCKED", "The recipient has blocked this public principal", 403);
      }
      const alias = compact(clientConversationId, 200);
      if (alias) {
        const existingAlias = this.db.prepare(`
          SELECT conversation_id FROM conversation_aliases
          WHERE principal_id = ? AND alias = ?
        `).get(actor.id, alias);
        if (existingAlias) {
          const existingMembers = this.db.prepare(`
            SELECT principal_id FROM conversation_members
            WHERE conversation_id = ? AND principal_id != ? AND left_at IS NULL
          `).all(existingAlias.conversation_id, actor.id);
          if (existingMembers.length !== 1 || existingMembers[0].principal_id !== target.id) {
            fail("PUBLIC_DIRECT_ONLY", "Public conversation alias does not identify the requested address", 403);
          }
        }
      }
      return this.createConversation(actor, {
        members: [target.handle],
        title: null,
        kind: "direct",
        clientConversationId
      }, true);
    }
    const alias = compact(clientConversationId, 200);
    if (alias) {
      const existingAlias = this.db.prepare(`
        SELECT conversation_id FROM conversation_aliases
        WHERE principal_id = ? AND alias = ?
      `).get(actor.id, alias);
      if (existingAlias) return this.getConversation(actor, existingAlias.conversation_id);
    }
    const handles = [...new Set([actor.handle, ...(Array.isArray(members) ? members : [])]
      .map(normalizeHandle))];
    if (handles.length < 2) fail("MEMBERS_REQUIRED", "A conversation requires at least two members");
    const principals = handles.map((handle) => {
      const principal = this.principalByHandle(handle);
      if (!principal) fail("UNKNOWN_PRINCIPAL", `Unknown principal: ${handle}`, 404);
      return principal;
    });
    const hasPublicMember = principals.some((principal) => principal.publicRegistered);
    if (actor.kind !== "admin" && principals.some((principal) => principal.kind === "admin")) {
      fail("PRINCIPAL_NOT_ADDRESSABLE", "One or more principals are not addressable", 403);
    }
    const conversationKind = kind || (principals.length === 2 && !title ? "direct" : "group");
    if (!["direct", "group"].includes(conversationKind)) fail("INVALID_CONVERSATION_KIND", "Conversation kind is invalid");
    if (hasPublicMember && (conversationKind !== "direct" || principals.length !== 2 || title)) {
      fail("PUBLIC_DIRECT_ONLY", "Conversations containing public principals must be direct", 403);
    }
    if (conversationKind === "direct" && principals.length !== 2) {
      fail("INVALID_DIRECT_MEMBERSHIP", "A direct conversation has exactly two members");
    }
    const directKey = conversationKind === "direct"
      ? principals.map((item) => item.id).sort().join(":")
      : null;
    if (directKey) {
      const existing = this.db.prepare("SELECT id FROM conversations WHERE direct_key = ?").get(directKey);
      if (existing) {
        if (publicActor) {
          this.transaction(() => {
            this.assertPublicConversationAllowed(actor, principals);
            if (alias) this.db.prepare(`
              INSERT INTO conversation_aliases(principal_id, alias, conversation_id, created_at)
              VALUES(?,?,?,?)
              ON CONFLICT(principal_id, alias) DO UPDATE SET conversation_id = excluded.conversation_id
            `).run(actor.id, alias, existing.id, nowIso());
          });
        } else if (alias) {
          this.db.prepare(`
            INSERT INTO conversation_aliases(principal_id, alias, conversation_id, created_at)
            VALUES(?,?,?,?)
            ON CONFLICT(principal_id, alias) DO UPDATE SET conversation_id = excluded.conversation_id
          `).run(actor.id, alias, existing.id, nowIso());
        }
        return this.getConversation(actor, existing.id);
      }
    }
    const id = `conv_${randomUUID()}`;
    const createdAt = nowIso();
    this.transaction(() => {
      if (publicActor) this.assertPublicConversationAllowed(actor, principals);
      this.db.prepare(`
        INSERT INTO conversations(id, kind, title, direct_key, created_by, created_at)
        VALUES(?,?,?,?,?,?)
      `).run(id, conversationKind, title ? compact(title, 200) : null, directKey, actor.id, createdAt);
      const insertMember = this.db.prepare(`
        INSERT INTO conversation_members(conversation_id, principal_id, role, joined_at)
        VALUES(?,?,?,?)
      `);
      for (const principal of principals) {
        insertMember.run(id, principal.id, principal.id === actor.id ? "owner" : "member", createdAt);
      }
      if (alias) {
        this.db.prepare(`
          INSERT INTO conversation_aliases(principal_id, alias, conversation_id, created_at)
          VALUES(?,?,?,?)
        `).run(actor.id, alias, id, createdAt);
      }
    });
    return this.getConversation(actor, id);
  }

  listConversations(actor, { limit = 100 } = {}) {
    const rows = this.db.prepare(`
      SELECT c.id, c.kind, c.title, c.created_at,
        COALESCE(MAX(m.seq), 0) AS latest_seq,
        MAX(m.created_at) AS latest_message_at,
        SUM(CASE WHEN d.state IN ('pending','offered') THEN 1 ELSE 0 END) AS unread_count
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
        AND cm.principal_id = ? AND cm.left_at IS NULL
      LEFT JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN deliveries d ON d.message_id = m.id AND d.recipient_id = ?
      WHERE (? = 0 OR c.kind = 'direct')
      GROUP BY c.id
      ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC
      LIMIT ?
    `).all(actor.id, actor.id, this.isPublicPrincipal(actor) ? 1 : 0, boundedLimit(limit, 100));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      createdAt: row.created_at,
      latestSeq: Number(row.latest_seq),
      latestMessageAt: row.latest_message_at || null,
      unreadCount: Number(row.unread_count || 0),
      members: this.conversationMembers(row.id, actor)
    }));
  }

  getConversation(actor, conversationId) {
    const resolvedId = this.resolveConversationId(actor.id, conversationId);
    this.requireMembership(actor.id, resolvedId);
    const row = this.db.prepare(`
      SELECT id, kind, title, created_at FROM conversations WHERE id = ?
    `).get(resolvedId);
    if (!row) fail("CONVERSATION_NOT_FOUND", "Conversation was not found", 404);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      createdAt: row.created_at,
      members: this.conversationMembers(row.id, actor)
    };
  }

  resolveConversationId(principalId, value) {
    const wanted = String(value || "").trim();
    if (!wanted) fail("CONVERSATION_NOT_FOUND", "Conversation was not found", 404);
    const direct = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(wanted);
    if (direct) return direct.id;
    const alias = this.db.prepare(`
      SELECT conversation_id FROM conversation_aliases
      WHERE principal_id = ? AND alias = ?
    `).get(principalId, wanted);
    return alias?.conversation_id || wanted;
  }

  conversationMembers(conversationId, actor = null) {
    return this.db.prepare(`
      SELECT p.id, p.handle, p.public_address, p.public_registered, p.public_discoverable,
             p.display_name, p.kind, p.created_at, cm.role, cm.joined_at
      FROM conversation_members cm
      JOIN principals p ON p.id = cm.principal_id
      WHERE cm.conversation_id = ? AND cm.left_at IS NULL
      ORDER BY p.handle
    `).all(conversationId).map((row) => ({
      ...(actor && this.isPublicPrincipal(actor) ? publicProfile(publicPrincipal(row)) : publicPrincipal(row)),
      role: row.role,
      joinedAt: row.joined_at
    }));
  }

  sendMessage(actor, {
    conversationId,
    clientMessageId,
    body = "",
    data = null,
    replyTo = null,
    attachmentIds = []
  } = {}) {
    conversationId = this.resolveConversationId(actor.id, conversationId);
    this.requireMembership(actor.id, conversationId);
    const publicConversation = this.publicConversationState(conversationId);
    const idempotencyKey = compact(clientMessageId, 200);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "clientMessageId is required");
    const publicActor = this.isPublicPrincipal(actor);
    if (publicActor && body != null && typeof body !== "string") {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BODY_INVALID" });
      fail("PUBLIC_BODY_INVALID", "Public message body must be a string", 400);
    }
    if (publicActor && attachmentIds != null && !Array.isArray(attachmentIds)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ATTACHMENTS_FORBIDDEN" });
      fail("PUBLIC_ATTACHMENTS_FORBIDDEN", "Public principals cannot attach blobs", 403);
    }
    const text = String(body || "");
    const dataJson = data == null ? null : JSON.stringify(data);
    if (publicActor && Array.isArray(attachmentIds) && attachmentIds.length) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ATTACHMENTS_FORBIDDEN" });
      fail("PUBLIC_ATTACHMENTS_FORBIDDEN", "Public principals cannot attach blobs", 403);
    }
    const attachments = this.validateAttachmentIds(actor.id, attachmentIds);
    validateContent(text, dataJson, attachments.length);
    if (publicConversation && attachments.length) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ATTACHMENTS_FORBIDDEN" });
      fail("PUBLIC_ATTACHMENTS_FORBIDDEN", "Conversations with public principals are text-only", 403);
    }
    const canonical = JSON.stringify({ conversationId, body: text, data: dataJson, replyTo, attachments });
    const canonicalHash = createHash("sha256").update(canonical).digest("hex");
    const existing = this.db.prepare(`
      SELECT m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.author_id = ? AND m.client_message_id = ?
    `).get(actor.id, idempotencyKey);
    if (existing) {
      const priorCanonical = JSON.stringify({
        conversationId: existing.conversation_id,
        body: existing.body,
        data: existing.data_json,
        replyTo: existing.reply_to,
        attachments: this.messageAttachmentIds(existing.id)
      });
      const priorHash = createHash("sha256").update(priorCanonical).digest("hex");
      if (priorHash !== canonicalHash) fail("IDEMPOTENCY_CONFLICT", "clientMessageId was reused with different content", 409);
      return this.publicMessage(existing, actor.id);
    }
    const publicRecipients = publicActor ? this.db.prepare(`
      SELECT cm.principal_id, p.kind, p.public_registered, p.public_address
      FROM conversation_members cm JOIN principals p ON p.id = cm.principal_id
      WHERE cm.conversation_id = ? AND cm.left_at IS NULL AND cm.principal_id != ?
    `).all(conversationId, actor.id) : [];
    if (publicActor) {
      const conversation = this.db.prepare("SELECT kind FROM conversations WHERE id = ?").get(conversationId);
      if (!conversation || conversation.kind !== "direct" || publicRecipients.length !== 1
        || publicRecipients[0].kind === "admin") {
        this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DIRECT_ONLY" });
        fail("PUBLIC_DIRECT_ONLY", "Public principals may send only in direct conversations", 403);
      }
      this.enforcePublicSendLimits(actor, conversationId, publicRecipients, text, dataJson, attachments);
    }
    if (replyTo) {
      const parent = this.db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(replyTo);
      if (!parent || parent.conversation_id !== conversationId) {
        fail("INVALID_REPLY_TARGET", "Reply target is not in this conversation");
      }
    }
    const messageId = `msg_${randomUUID()}`;
    const createdAt = nowIso();
    try {
      this.transaction(() => {
      const next = this.db.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?"
      ).get(conversationId);
      this.db.prepare(`
        INSERT INTO messages(id, conversation_id, seq, author_id, client_message_id,
          body, data_json, reply_to, created_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(messageId, conversationId, Number(next.seq), actor.id, idempotencyKey,
        text, dataJson, replyTo, createdAt);
      const attach = this.db.prepare(`
        INSERT INTO message_blobs(message_id, blob_id, ordinal) VALUES(?,?,?)
      `);
      attachments.forEach((blobId, ordinal) => attach.run(messageId, blobId, ordinal));
      const recipients = this.db.prepare(`
        SELECT principal_id FROM conversation_members
        WHERE conversation_id = ? AND left_at IS NULL AND principal_id != ?
      `).all(conversationId, actor.id);
      const insertDelivery = this.db.prepare(`
        INSERT INTO deliveries(id, message_id, recipient_id, state)
        VALUES(?,?,?,'pending')
      `);
        for (const recipient of recipients) {
          insertDelivery.run(`dlv_${randomUUID()}`, messageId, recipient.principal_id);
        }
      });
    } catch (error) {
      if (replyTo && String(error.message).includes("messages.author_id, messages.reply_to")) {
        const prior = this.db.prepare(`
          SELECT id FROM messages WHERE author_id = ? AND reply_to = ?
        `).get(actor.id, replyTo);
        fail("MESSAGE_ALREADY_ANSWERED", "This principal already replied to that message", 409,
          prior ? { messageId: prior.id } : undefined);
      }
      throw error;
    }
    return this.getMessage(actor, messageId);
  }

  getMessage(actor, messageId) {
    const row = this.messageRow(messageId);
    if (!row) fail("MESSAGE_NOT_FOUND", "Message was not found", 404);
    this.requireMembership(actor.id, row.conversation_id);
    return this.publicMessage(row, actor.id);
  }

  getMessageByClientId(actor, clientMessageId) {
    const key = compact(clientMessageId, 200);
    if (!key) fail("MESSAGE_NOT_FOUND", "Message was not found", 404);
    const row = this.db.prepare(`
      SELECT m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.author_id = ? AND m.client_message_id = ?
    `).get(actor.id, key);
    if (!row) fail("MESSAGE_NOT_FOUND", "Message was not found", 404);
    this.requireMembership(actor.id, row.conversation_id);
    return this.publicMessage(row, actor.id);
  }

  listMessages(actor, conversationId, { after = 0, limit = 100 } = {}) {
    conversationId = this.resolveConversationId(actor.id, conversationId);
    this.requireMembership(actor.id, conversationId);
    return this.db.prepare(`
      SELECT m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.conversation_id = ? AND m.seq > ?
      ORDER BY m.seq ASC LIMIT ?
    `).all(conversationId, Math.max(0, Number(after) || 0), boundedLimit(limit, 100))
      .map((row) => this.publicMessage(row, actor.id));
  }

  peekInbox(actor, { limit = 20, deliveryId = null, messageId = null, conversationId = null, now = new Date() } = {}) {
    if (conversationId) conversationId = this.resolveConversationId(actor.id, conversationId);
    const at = toDate(now).toISOString();
    const rows = this.db.prepare(`
      SELECT d.id AS delivery_id, d.state, d.attempts, d.offered_at,
             d.read_at, d.acknowledged_at, d.lease_expires_at, d.lease_token,
             m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      JOIN principals p ON p.id = m.author_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE d.recipient_id = ?
        AND (? IS NULL OR d.id = ?)
        AND (? IS NULL OR m.id = ?)
        AND (? IS NULL OR m.conversation_id = ?)
        AND (d.available_at IS NULL OR d.available_at <= ?)
        AND (d.state = 'pending' OR (d.state IN ('offered','read') AND d.lease_expires_at <= ?))
        AND (? = 0 OR c.kind = 'direct')
      ORDER BY m.created_at, m.seq LIMIT ?
    `).all(actor.id, deliveryId, deliveryId, messageId, messageId,
      conversationId, conversationId, at, at, this.isPublicPrincipal(actor) ? 1 : 0, boundedLimit(limit, 20));
    return rows.map((row) => this.publicInboxDelivery(row, actor.id));
  }

  claimInbox(actor, { limit = 20, deliveryId = null, messageId = null, conversationId = null, now = new Date() } = {}) {
    if (conversationId) conversationId = this.resolveConversationId(actor.id, conversationId);
    const at = toDate(now);
    const leaseExpiresAt = new Date(at.getTime() + this.leaseMs).toISOString();
    const publicViewer = this.isPublicPrincipal(actor) ? 1 : 0;
    const selected = this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT d.id FROM deliveries d
        JOIN messages m ON m.id = d.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE d.recipient_id = ?
          AND (? IS NULL OR d.id = ?)
          AND (? IS NULL OR m.id = ?)
          AND (? IS NULL OR m.conversation_id = ?)
          AND (d.available_at IS NULL OR d.available_at <= ?)
          AND (d.state = 'pending' OR (d.state IN ('offered','read') AND d.lease_expires_at <= ?))
          AND (? = 0 OR c.kind = 'direct')
        ORDER BY m.created_at, m.seq
        LIMIT ?
      `).all(actor.id, deliveryId, deliveryId, messageId, messageId, conversationId, conversationId,
        at.toISOString(), at.toISOString(), publicViewer, boundedLimit(limit, 20));
      const offer = this.db.prepare(`
        UPDATE deliveries SET state = 'offered', attempts = attempts + 1,
          offered_at = ?, lease_expires_at = ?, lease_token = ? WHERE id = ?
      `);
      for (const row of rows) offer.run(at.toISOString(), leaseExpiresAt, `lease_${randomUUID()}`, row.id);
      return rows.map((row) => row.id);
    });
    if (!selected.length) return [];
    const placeholders = selected.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT d.id AS delivery_id, d.state, d.attempts, d.offered_at,
             d.read_at, d.acknowledged_at, d.lease_expires_at, d.lease_token,
             m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      JOIN principals p ON p.id = m.author_id
      WHERE d.id IN (${placeholders})
      ORDER BY m.created_at, m.seq
    `).all(...selected).map((row) => this.publicInboxDelivery(row, actor.id));
  }

  markRead(actor, deliveryId, { leaseToken, now = new Date() } = {}) {
    const row = this.ownedDelivery(actor.id, deliveryId);
    if (row.state === "acknowledged") return this.publicDelivery(row);
    if (!["offered", "read"].includes(row.state)) fail("DELIVERY_NOT_OFFERED", "Delivery is not currently offered", 409);
    this.requireLease(row, leaseToken);
    this.db.prepare(`
      UPDATE deliveries SET state = 'read', read_at = COALESCE(read_at, ?)
      WHERE id = ?
    `).run(toDate(now).toISOString(), deliveryId);
    return this.publicDelivery(this.ownedDelivery(actor.id, deliveryId));
  }

  acknowledge(actor, deliveryId, { leaseToken, now = new Date() } = {}) {
    const row = this.ownedDelivery(actor.id, deliveryId);
    if (row.state === "acknowledged") return this.publicDelivery(row);
    if (!["offered", "read"].includes(row.state)) fail("DELIVERY_NOT_OFFERED", "Delivery is not currently offered", 409);
    this.requireLease(row, leaseToken);
    this.db.prepare(`
      UPDATE deliveries SET state = 'acknowledged',
        read_at = COALESCE(read_at, ?), acknowledged_at = ?, lease_expires_at = NULL,
        lease_token = NULL
      WHERE id = ?
    `).run(toDate(now).toISOString(), toDate(now).toISOString(), deliveryId);
    return this.publicDelivery(this.ownedDelivery(actor.id, deliveryId));
  }

  retryDelivery(actor, deliveryId, { availableAt = null, dead = false, reason = null, leaseToken } = {}) {
    const row = this.ownedDelivery(actor.id, deliveryId);
    if (row.state === "acknowledged") return this.publicDelivery(row);
    if (!["offered", "read"].includes(row.state)) fail("DELIVERY_NOT_OFFERED", "Delivery is not currently offered", 409);
    this.requireLease(row, leaseToken);
    if (dead) {
      this.db.prepare(`
        UPDATE deliveries SET state = 'dead', dead_reason = ?, lease_expires_at = NULL,
          lease_token = NULL
        WHERE id = ?
      `).run(compact(reason || "consumer-dead-letter", 500), deliveryId);
    } else {
      const at = availableAt ? toDate(availableAt).toISOString() : nowIso();
      this.db.prepare(`
        UPDATE deliveries SET state = 'pending', available_at = ?, lease_expires_at = NULL,
          lease_token = NULL
        WHERE id = ?
      `).run(at, deliveryId);
    }
    return this.publicDelivery(this.ownedDelivery(actor.id, deliveryId));
  }

  createDraft(actor, {
    conversationId, clientDraftId, body = "", data = null, replyTo = null, attachmentIds = []
  } = {}) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DRAFTS_FORBIDDEN" });
      fail("PUBLIC_DRAFTS_FORBIDDEN", "Public principals cannot create drafts", 403);
    }
    conversationId = this.resolveConversationId(actor.id, conversationId);
    this.requireMembership(actor.id, conversationId);
    const publicConversation = this.publicConversationState(conversationId);
    const text = String(body || "");
    const dataJson = data == null ? null : JSON.stringify(data);
    const attachments = this.validateAttachmentIds(actor.id, attachmentIds);
    validateContent(text, dataJson, attachments.length);
    if (publicConversation && attachments.length) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_ATTACHMENTS_FORBIDDEN" });
      fail("PUBLIC_ATTACHMENTS_FORBIDDEN", "Conversations with public principals are text-only", 403);
    }
    if (replyTo) this.validateReplyTarget(conversationId, replyTo);
    const idempotencyKey = compact(clientDraftId, 200);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "clientDraftId is required");
    const canonical = JSON.stringify({ conversationId, body: text, data: dataJson, replyTo, attachments });
    const existing = this.db.prepare(`
      SELECT * FROM drafts WHERE author_id = ? AND client_draft_id = ?
    `).get(actor.id, idempotencyKey);
    if (existing) {
      const priorCanonical = JSON.stringify({
        conversationId: existing.conversation_id,
        body: existing.body,
        data: existing.data_json,
        replyTo: existing.reply_to,
        attachments: this.draftAttachmentIds(existing.id)
      });
      if (createHash("sha256").update(priorCanonical).digest("hex")
        !== createHash("sha256").update(canonical).digest("hex")) {
        fail("IDEMPOTENCY_CONFLICT", "clientDraftId was reused with different content", 409);
      }
      return this.publicDraft(existing);
    }
    const id = `draft_${randomUUID()}`;
    const at = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO drafts(id, author_id, conversation_id, body, data_json, reply_to,
          created_at, updated_at, client_draft_id)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(id, actor.id, conversationId, text, dataJson, replyTo, at, at, idempotencyKey);
      const attach = this.db.prepare(`
        INSERT INTO draft_blobs(draft_id, blob_id, ordinal) VALUES(?,?,?)
      `);
      attachments.forEach((blobId, ordinal) => attach.run(id, blobId, ordinal));
    });
    return this.getDraft(actor, id);
  }

  listDrafts(actor, { limit = 50 } = {}) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DRAFTS_FORBIDDEN" });
      fail("PUBLIC_DRAFTS_FORBIDDEN", "Public principals cannot access drafts", 403);
    }
    return this.db.prepare(`
      SELECT * FROM drafts WHERE author_id = ? ORDER BY updated_at DESC LIMIT ?
    `).all(actor.id, boundedLimit(limit, 50)).map((row) => this.publicDraft(row));
  }

  getDraft(actor, draftId) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DRAFTS_FORBIDDEN" });
      fail("PUBLIC_DRAFTS_FORBIDDEN", "Public principals cannot access drafts", 403);
    }
    const row = this.db.prepare("SELECT * FROM drafts WHERE id = ? AND author_id = ?")
      .get(draftId, actor.id);
    if (!row) fail("DRAFT_NOT_FOUND", "Draft was not found", 404);
    return this.publicDraft(row);
  }

  sendDraft(actor, draftId) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DRAFTS_FORBIDDEN" });
      fail("PUBLIC_DRAFTS_FORBIDDEN", "Public principals cannot send drafts", 403);
    }
    const draft = this.getDraft(actor, draftId);
    const message = this.sendMessage(actor, {
      conversationId: draft.conversationId,
      clientMessageId: `draft:${draft.id}`,
      body: draft.body,
      data: draft.data,
      replyTo: draft.replyTo,
      attachmentIds: draft.attachments.map((attachment) => attachment.id)
    });
    this.db.prepare("DELETE FROM drafts WHERE id = ? AND author_id = ?").run(draftId, actor.id);
    return message;
  }

  discardDraft(actor, draftId) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_DRAFTS_FORBIDDEN" });
      fail("PUBLIC_DRAFTS_FORBIDDEN", "Public principals cannot access drafts", 403);
    }
    const draft = this.getDraft(actor, draftId);
    this.db.prepare("DELETE FROM drafts WHERE id = ? AND author_id = ?").run(draftId, actor.id);
    return { ...draft, discarded: true };
  }

  validateReplyTarget(conversationId, replyTo) {
    const parent = this.db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(replyTo);
    if (!parent || parent.conversation_id !== conversationId) {
      fail("INVALID_REPLY_TARGET", "Reply target is not in this conversation");
    }
  }

  createBlob(actor, { bytes, name = "attachment", mimeType = "application/octet-stream", metadata = null } = {}) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BLOBS_FORBIDDEN" });
      fail("PUBLIC_BLOBS_FORBIDDEN", "Public principals cannot upload blobs", 403);
    }
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
    if (content.length > BLOB_LIMIT_BYTES) {
      fail("BLOB_TOO_LARGE", `Attachment exceeds ${BLOB_LIMIT_BYTES} bytes`, 413);
    }
    const metadataJson = metadata == null ? null : JSON.stringify(metadata);
    if (Buffer.byteLength(metadataJson || "") > DATA_LIMIT_BYTES) {
      fail("DATA_TOO_LARGE", `Attachment metadata exceeds ${DATA_LIMIT_BYTES} bytes`, 413);
    }
    const id = `blob_${randomUUID()}`;
    const storageKey = `${id}.bin`;
    const finalPath = path.join(this.blobDir, storageKey);
    const temporaryPath = path.join(this.blobDir, `.${storageKey}.${randomUUID()}.tmp`);
    const record = {
      id,
      ownerId: actor.id,
      name: safeFilename(name),
      mimeType: compact(mimeType || "application/octet-stream", 200) || "application/octet-stream",
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      storageKey,
      metadataJson,
      createdAt: nowIso()
    };
    try {
      writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
      const fd = openSync(temporaryPath, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporaryPath, finalPath);
      this.db.prepare(`
        INSERT INTO blobs(id, owner_id, name, mime_type, size_bytes, sha256,
          storage_key, metadata_json, created_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(record.id, record.ownerId, record.name, record.mimeType, record.sizeBytes,
        record.sha256, record.storageKey, record.metadataJson, record.createdAt);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      try { unlinkSync(finalPath); } catch {}
      throw error;
    }
    return publicBlobRecord({
      id: record.id,
      name: record.name,
      mime_type: record.mimeType,
      size_bytes: record.sizeBytes,
      sha256: record.sha256,
      metadata_json: record.metadataJson,
      created_at: record.createdAt
    });
  }

  readBlob(actor, blobId) {
    if (this.isPublicPrincipal(actor)) {
      this.recordSecurityEvent("public_rejection", actor.id, null, { code: "PUBLIC_BLOBS_FORBIDDEN" });
      fail("PUBLIC_BLOBS_FORBIDDEN", "Public principals cannot read blobs", 403);
    }
    const row = this.db.prepare("SELECT * FROM blobs WHERE id = ?").get(blobId);
    if (!row || !this.canReadBlob(actor, row)) fail("BLOB_NOT_FOUND", "Attachment was not found", 404);
    return { ...publicBlobRecord(row), bytes: readFileSync(path.join(this.blobDir, row.storage_key)) };
  }

  canReadBlob(actor, row) {
    if (actor.kind === "admin" || row.owner_id === actor.id) return true;
    const attachedMessage = this.db.prepare(`
      SELECT 1 FROM message_blobs mb
      JOIN messages m ON m.id = mb.message_id
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
      WHERE mb.blob_id = ? AND cm.principal_id = ? AND cm.left_at IS NULL
      LIMIT 1
    `).get(row.id, actor.id);
    return Boolean(attachedMessage);
  }

  validateAttachmentIds(ownerId, values) {
    const ids = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (ids.length > 20) fail("TOO_MANY_ATTACHMENTS", "A message may include at most 20 attachments");
    if (!ids.length) return ids;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT id FROM blobs WHERE owner_id = ? AND id IN (${placeholders})
    `).all(ownerId, ...ids);
    if (rows.length !== ids.length) {
      fail("INVALID_ATTACHMENT", "Attachments must exist and be owned by the authenticated principal");
    }
    return ids;
  }

  messageAttachmentIds(messageId) {
    return this.db.prepare(`
      SELECT blob_id FROM message_blobs WHERE message_id = ? ORDER BY ordinal
    `).all(messageId).map((row) => row.blob_id);
  }

  draftAttachmentIds(draftId) {
    return this.db.prepare(`
      SELECT blob_id FROM draft_blobs WHERE draft_id = ? ORDER BY ordinal
    `).all(draftId).map((row) => row.blob_id);
  }

  attachmentsFor(kind, id) {
    const relation = kind === "draft" ? "draft_blobs" : "message_blobs";
    const ownerColumn = kind === "draft" ? "draft_id" : "message_id";
    return this.db.prepare(`
      SELECT b.* FROM ${relation} r JOIN blobs b ON b.id = r.blob_id
      WHERE r.${ownerColumn} = ? ORDER BY r.ordinal
    `).all(id).map(publicBlobRecord);
  }

  receipts(actor, messageId) {
    const message = this.messageRow(messageId);
    if (!message) fail("MESSAGE_NOT_FOUND", "Message was not found", 404);
    if (message.author_id !== actor.id && actor.kind !== "admin") {
      fail("AUTHOR_REQUIRED", "Only the author may inspect delivery receipts", 403);
    }
    return this.db.prepare(`
      SELECT d.id, d.state, d.attempts, d.offered_at, d.read_at,
             d.acknowledged_at, d.lease_expires_at,
             p.id AS recipient_id, p.handle AS recipient_handle, p.public_address AS recipient_address,
             p.display_name AS recipient_display_name, p.kind AS recipient_kind
      FROM deliveries d JOIN principals p ON p.id = d.recipient_id
      WHERE d.message_id = ? ORDER BY p.handle
    `).all(messageId).map((row) => ({
      id: row.id,
      state: row.state,
      attempts: Number(row.attempts),
      offeredAt: row.offered_at,
      readAt: row.read_at,
      acknowledgedAt: row.acknowledged_at,
      leaseExpiresAt: row.lease_expires_at,
      recipient: this.isPublicPrincipal(actor)
        ? { address: row.recipient_address, displayName: row.recipient_display_name, kind: row.recipient_kind }
        : {
          id: row.recipient_id,
          handle: row.recipient_handle,
          ...(row.recipient_address ? { address: row.recipient_address } : {}),
          displayName: row.recipient_display_name,
          kind: row.recipient_kind
        }
    }));
  }

  hasClaimable(actor, { now = new Date() } = {}) {
    const row = this.db.prepare(`
      SELECT 1 FROM deliveries
      JOIN messages m ON m.id = deliveries.message_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE recipient_id = ?
        AND (available_at IS NULL OR available_at <= ?)
        AND (state = 'pending' OR (state IN ('offered','read') AND lease_expires_at <= ?))
        AND (? = 0 OR c.kind = 'direct')
      LIMIT 1
    `).get(actor.id, toDate(now).toISOString(), toDate(now).toISOString(),
      this.isPublicPrincipal(actor) ? 1 : 0);
    return Boolean(row);
  }

  requireMembership(principalId, conversationId) {
    const row = this.db.prepare(`
      SELECT c.kind, p.public_registered AS viewer_public_registered
      FROM conversation_members cm
      JOIN conversations c ON c.id = cm.conversation_id
      JOIN principals p ON p.id = cm.principal_id
      WHERE cm.conversation_id = ? AND cm.principal_id = ? AND cm.left_at IS NULL
    `).get(conversationId, principalId);
    if (!row || (row.viewer_public_registered && row.kind !== "direct")) {
      fail("CONVERSATION_NOT_FOUND", "Conversation was not found", 404);
    }
  }

  messageRow(messageId) {
    return this.db.prepare(`
      SELECT m.*, p.handle AS author_handle, p.public_address AS author_address,
             p.public_registered AS author_public_registered,
             p.display_name AS author_display_name, p.kind AS author_kind
      FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.id = ?
    `).get(messageId);
  }

  ownedDelivery(principalId, deliveryId) {
    const row = this.db.prepare(`
      SELECT d.* FROM deliveries d WHERE d.id = ? AND d.recipient_id = ?
    `).get(deliveryId, principalId);
    if (!row) fail("DELIVERY_NOT_FOUND", "Delivery was not found", 404);
    return row;
  }

  requireLease(row, leaseToken) {
    const supplied = String(leaseToken || "");
    if (!row.lease_token || supplied !== row.lease_token) {
      fail("DELIVERY_LEASE_REQUIRED", "The current delivery lease token is required", 409);
    }
  }

  publicDelivery(row) {
    return {
      id: row.id,
      messageId: row.message_id,
      state: row.state,
      attempts: Number(row.attempts),
      offeredAt: row.offered_at,
      readAt: row.read_at,
      acknowledgedAt: row.acknowledged_at,
      leaseExpiresAt: row.lease_expires_at,
      ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
      availableAt: row.available_at || null,
      deadReason: row.dead_reason || null
    };
  }

  publicInboxDelivery(row, viewerId) {
    return {
      id: row.delivery_id,
      state: row.state,
      attempts: Number(row.attempts),
      offeredAt: row.offered_at,
      leaseExpiresAt: row.lease_expires_at,
      ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
      redelivery: Number(row.attempts) > 1,
      message: this.publicMessage(row, viewerId)
    };
  }

  publicMessage(row, viewerId) {
    const publicViewer = Boolean(this.db.prepare(
      "SELECT public_registered FROM principals WHERE id = ?"
    ).get(viewerId)?.public_registered);
    const delivery = this.db.prepare(`
      SELECT * FROM deliveries WHERE message_id = ? AND recipient_id = ?
    `).get(row.id, viewerId);
    const replyIds = this.db.prepare(`
      SELECT id FROM messages WHERE reply_to = ? ORDER BY created_at, seq
    `).all(row.id).map((item) => item.id);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: Number(row.seq),
      author: publicViewer
        ? { address: row.author_address, displayName: row.author_display_name, kind: row.author_kind }
        : {
          id: row.author_id,
          handle: row.author_handle,
          ...(row.author_address ? { address: row.author_address } : {}),
          displayName: row.author_display_name,
          kind: row.author_kind
        },
      body: row.body,
      ...(row.data_json ? { data: JSON.parse(row.data_json) } : {}),
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
      replyIds,
      ...(delivery ? { delivery: this.publicDelivery(delivery) } : {}),
      attachments: this.attachmentsFor("message", row.id),
      createdAt: row.created_at,
      authoredByMe: row.author_id === viewerId
    };
  }

  publicDraft(row) {
    return {
      id: row.id,
      clientDraftId: row.client_draft_id || null,
      conversationId: row.conversation_id,
      body: row.body,
      ...(row.data_json ? { data: JSON.parse(row.data_json) } : {}),
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
      attachments: this.attachmentsFor("draft", row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

function publicPrincipal(row) {
  return {
    id: row.id,
    handle: row.handle,
    ...(row.public_address ? { address: row.public_address } : {}),
    displayName: row.display_name,
    kind: row.kind,
    createdAt: row.created_at,
    ...(row.public_registered != null ? { publicRegistered: Boolean(row.public_registered) } : {}),
    ...(row.public_discoverable != null ? { publicDiscoverable: Boolean(row.public_discoverable) } : {}),
    ...(row.retired_at ? { retiredAt: row.retired_at } : {})
  };
}

function publicProfile(principal) {
  return {
    address: principal.address,
    displayName: principal.displayName,
    kind: principal.kind,
    ...(principal.publicDiscoverable != null ? { discoverable: Boolean(principal.publicDiscoverable) } : {})
  };
}

function publicCredential(row) {
  return {
    id: row.id,
    principalId: row.principal_id,
    tokenHint: row.token_hint,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
    expiresAt: row.expires_at || null
  };
}

function publicBlobRecord(row) {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) } : {}),
    createdAt: row.created_at,
    downloadPath: `/v1/blobs/${encodeURIComponent(row.id)}`
  };
}

function validateContent(text, dataJson, attachmentCount = 0) {
  if (!String(text || "").trim() && !dataJson && !attachmentCount) {
    fail("MESSAGE_CONTENT_REQUIRED", "Message body, data, or an attachment is required");
  }
  if (Buffer.byteLength(String(text || "")) + Buffer.byteLength(dataJson || "") > MESSAGE_LIMIT_BYTES) {
    fail("MESSAGE_TOO_LARGE", `Message exceeds ${MESSAGE_LIMIT_BYTES} bytes`, 413);
  }
  if (Buffer.byteLength(dataJson || "") > DATA_LIMIT_BYTES) {
    fail("DATA_TOO_LARGE", `Structured data exceeds ${DATA_LIMIT_BYTES} bytes`, 413);
  }
}

function safeFilename(value) {
  const name = path.basename(String(value || "attachment")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "attachment").slice(0, 255);
}

function normalizeHandle(value) {
  const handle = String(value || "").trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) fail("INVALID_HANDLE", "Handle must match [a-z0-9][a-z0-9._-]{0,63}");
  return handle;
}

function normalizePublicAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  if (!/^x\d{12}$/.test(address)) fail("INVALID_PUBLIC_ADDRESS", "Public address must match x followed by 12 digits");
  return address;
}

function validatePublicDisplayName(value) {
  if (typeof value !== "string") fail("INVALID_DISPLAY_NAME", "displayName is required");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) fail("INVALID_DISPLAY_NAME", "displayName must be 1 to 120 characters");
  return name;
}

function validateInviteCode(value) {
  const code = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) fail("INVALID_INVITE", "Invite code is invalid or expired", 400);
  return code;
}

function boundedInviteTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > MAX_PUBLIC_INVITE_TTL_MS) {
    fail("INVALID_INVITE_EXPIRY", "Invite expiry must be between 1 minute and 30 days");
  }
  return Math.floor(ttl);
}

function utcDayStart(value) {
  const date = toDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function boundedLimit(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) fail("INVALID_TIME", "Timestamp is invalid");
  return date;
}
