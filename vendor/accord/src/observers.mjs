// SPDX-License-Identifier: MIT
// Portable adapters follow Tessera's Codex/Claude transcript state conventions.
import fs from "node:fs/promises";
import { join, basename } from "node:path";
import { hash } from "./common.mjs";
import { redact, staleSessionMs } from "./session-awareness.mjs";
const content = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((x) => ["text", "input_text", "output_text"].includes(x.type))
          .map((x) => x.text ?? "")
          .join("\n")
      : "";
const injected = (s) => /^(?:<|# AGENTS\.md instructions)/.test(s.trim());
export function parseTranscript(
  source,
  lines,
  { externalId, title, location = "", now = Date.now() } = {},
) {
  let state = "unknown",
    progressAt = 0;
  const events = [];
  let parentSession; const fileId=externalId;
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    let message = "",
      kind = "",
      p = row.payload ?? {},
      timestamp = Date.parse(row.timestamp ?? "");
    if (source === "codex") {
      if (row.type === "session_meta") {
        externalId = p.id ?? p.session_id ?? externalId;
        location = p.cwd ?? location;
        const parent=p.source?.subagent?.thread_spawn?.parent_thread_id;
        if(typeof parent==='string')parentSession={source,externalId:parent};
        if(p.source?.subagent?.other==='guardian')return {source,externalId,excluded:true};
      }
      if (row.type === "turn_context") location = p.cwd ?? location;
      if (row.type === "event_msg") {
        if (p.type === "task_started") state = "working";
        if (p.type === "task_complete") state = "done";
        if (p.type === "turn_aborted") state = "cancelled";
        if (p.type === "user_message") {
          message = p.message ?? "";
          kind = "user";
          if(!injected(message))state = "working";
        }
        if (p.type === "agent_message") {
          message = p.message ?? "";
          kind = "assistant";
        }
      }
      if (row.type === "response_item") {
        if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
          message = content(p.content);
          kind = p.role;
          if (p.role === "user" && !injected(message)) state = "working";
          if (p.role === "assistant" && p.phase === "final_answer")
            state = "done";
        }
        if (
          ["function_call", "custom_tool_call", "local_shell_call"].includes(
            p.type,
          )
        ) {
          message = `Tool: ${p.name ?? "shell"}`;
          kind = "tool";
          state = /request_user_input/.test(p.name ?? "")
            ? "waiting"
            : "working";
        }
        if (
          ["function_call_output", "custom_tool_call_output"].includes(p.type)
        ) {
          kind = "tool-result";
          message = typeof p.output === "string" ? p.output.slice(-2000) : "";
        }
      }
    } else if (source === "claude") {
      location = row.cwd ?? location;
      if(fileId?.startsWith('agent-') && row.sessionId) {
        parentSession={source,externalId:row.sessionId};externalId=row.sessionId+'/'+fileId;
      } else externalId = row.sessionId ?? externalId;
      if (row.type === "custom-title") title = row.customTitle ?? title;
      if (
        ["user", "assistant"].includes(row.type) &&
        (!row.isSidechain || parentSession) &&
        !row.isMeta
      ) {
        kind = row.type;
        message = content(row.message?.content);
        if(kind==='user'&&message&&injected(message))continue;
        state =
          row.type === "user"
            ? "working"
            : row.message?.stop_reason === "end_turn"
              ? "done"
              : "working";
        const tools = Array.isArray(row.message?.content)
          ? row.message.content.filter((b) => b.type === "tool_use")
          : [];
        if (tools.length) {
          kind = "tool";
          message = tools.map((t) => `Tool: ${t.name}`).join("\n");
          if (tools.some((t) => t.name === "AskUserQuestion"))
            state = "waiting";
        }
      }
    }
    if (message && !injected(message)) {
      if (kind === "user" && !title)
        title = message.replace(/\s+/g, " ").slice(0, 120);
      events.push({
        key: hash(line),
        kind,
        text: redact(message).slice(-4000),
      });
      if (Number.isFinite(timestamp) && timestamp <= now)
        progressAt = Math.max(progressAt, timestamp);
    }
  }
  return {
    source,
    externalId,
    ...(parentSession?{parentSession}:{}),
    title: title ?? `${source} session`,
    location,
    state,
    progressAt: progressAt || null,
    events: events.slice(-30),
  };
}
async function filesUnder(root, { depth = 6, limit = 2000 } = {}) {
  const found = [];
  async function walk(dir, n) {
    if (n < 0 || found.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path, n - 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) found.push(path);
      if (found.length >= limit) break;
    }
  }
  await walk(root, depth);
  return found;
}
export class TranscriptObserver {
  constructor({ awareness, roots, now = Date.now }) {
    this.awareness = awareness;
    this.roots = roots;
    this.now = now;
    this.fingerprints = new Map();
    this.busy = false;
    this.actor = { id: "admin", role: "admin" };
  }
  async scan() {
    if (this.busy) return;
    this.busy = true;
    let imported = 0,
      failed = 0;
    try {
      for (const root of this.roots) {
        if (
          !["codex", "claude"].includes(root.source) ||
          root.enabled === false
        )
          continue;
        if (root.private === true) {
          if (
            this.awareness.db
              .prepare("SELECT private FROM source_privacy WHERE source=?")
              .get(root.source)?.private !== 1
          )
            this.awareness.privacy(this.actor, {
              source: root.source,
              private: true,
              key: `observer-private:${root.source}:${this.now()}`,
            });
          continue;
        }
        if (
          this.awareness.db
            .prepare("SELECT private FROM source_privacy WHERE source=?")
            .get(root.source)?.private === 1
        )
          continue;
        const known=this.awareness.db.prepare('SELECT external_id FROM session_views WHERE source=? AND hidden=0').all(root.source).map(r=>r.external_id).filter(Boolean);
        for (const path of await filesUnder(root.path)) {
          const stat = await fs.stat(path).catch(() => null);
          const old=stat&&this.now()-stat.mtimeMs>(root.lookbackMs??staleSessionMs);
          if (
            !stat ||
            old&&!known.some(id=>basename(path,'.jsonl').endsWith(id))
          )
            continue;
          const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
          if (this.fingerprints.get(path) === fingerprint) continue;
          let handle;
          try {
            handle = await fs.open(path, "r");
            const head = Buffer.alloc(Math.min(stat.size, 65536)),
              tail = Buffer.alloc(Math.min(stat.size, 256 * 1024));
            await handle.read(head, 0, head.length, 0);
            const start = stat.size - tail.length;
            await handle.read(tail, 0, tail.length, start);
            const tailText = tail.toString("utf8"),
              lines = [
                ...head.toString("utf8").split("\n").slice(0, -1),
                ...(start > 0
                  ? tailText.slice(tailText.indexOf("\n") + 1)
                  : tailText
                )
                  .split("\n")
                  .slice(0, -1),
              ];
            const report = parseTranscript(root.source, lines, {
              externalId: basename(path, ".jsonl"),
              now: this.now(),
            });
            if (!report.externalId) continue;
            if(report.excluded){
              this.awareness.hideInternal(root.source,report.externalId);
              this.fingerprints.set(path,fingerprint);
              continue;
            }
            if(old){this.fingerprints.set(path,fingerprint);continue;}
            // Receipt time is distinct from the source's last meaningful event time.
            this.awareness.report(this.actor, {
              ...report,
              key: `observe:${hash(path + fingerprint)}`,
              private: root.private === true,
              sourceProgressAt: report.progressAt,
            });
            this.fingerprints.set(path, fingerprint);
            imported++;
          } catch {
            failed++; /* Partial files and unavailable sources are retried on the next scan. */
          } finally {
            await handle?.close();
          }
        }
      }
      return { imported, failed };
    } finally {
      this.busy = false;
    }
  }
}
