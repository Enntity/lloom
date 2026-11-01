// SPDX-License-Identifier: MIT
// Product status is an observation, never a resource grant or proof of release.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { hash, requireThat } from "./common.mjs";
const execute = promisify(execFile);
export function shrugObservation(status) {
  requireThat(
    typeof status.release_id === "string" && Array.isArray(status.ranks),
    "PRODUCT_RESPONSE",
    "Invalid Shrug status",
  );
  const ranks = status.ranks.map((r) => ({
    rank: r.rank,
    host: r.host,
    container: r.container,
    status: r.container_status,
  }));
  const unknown =
    ranks.length === 0 ||
    ranks.some(
      (r) =>
        ![
          "running",
          "exited",
          "dead",
          "created",
          "paused",
          "restarting",
        ].includes(r.status),
    );
  const healthy =
    !unknown &&
    status.engine_healthy === true &&
    ranks.every((r) => r.status === "running");
  // A healthy resident service is idle, not an agent stuck doing unfinished work.
  return {
    title: `Shrug: ${status.release_id}`.slice(0, 200),
    state: unknown ? "unknown" : healthy ? "idle" : "blocked",
    detail: JSON.stringify({
      release: status.release_id,
      model: status.model_id,
      engineHealthy: status.engine_healthy === true,
      ranks,
      gateway: status.gateway?.requests,
    }).slice(0, 4000),
  };
}
export class ProductObservers {
  constructor({ awareness, configs = [], run = execute, now = Date.now }) {
    requireThat(
      Array.isArray(configs) && configs.length <= 16,
      "PRODUCT_CONFIG",
      "At most 16 product adapters",
    );
    this.awareness = awareness;
    this.configs = configs;
    this.run = run;
    this.now = now;
    this.next = new Map();
    this.last = new Map();
    for (const c of configs)
      requireThat(
        /^[a-z][a-z0-9-]{0,50}$/.test(c.id) &&
          ["shrug", "json"].includes(c.type) &&
          isAbsolute(c.command) &&
          (!c.args ||
            (Array.isArray(c.args) &&
              c.args.every((a) => typeof a === "string"))),
        "PRODUCT_CONFIG",
        "Adapters need a stable id, absolute executable and argument array",
      );
  }
  async scan() {
    for (const c of this.configs) {
      if (c.enabled === false || this.now() < (this.next.get(c.id) ?? 0))
        continue;
      this.next.set(c.id, this.now() + 30000);
      const source = `product:${c.id}`;
      if (
        this.awareness.db
          .prepare("SELECT private FROM source_privacy WHERE source=?")
          .get(source)?.private === 1
      )
        continue;
      let observation;
      try {
        const { stdout } = await this.run(
          c.command,
          c.type === "shrug" ? ["--json", "status"] : (c.args ?? []),
          {
            encoding: "utf8",
            timeout: 20000,
            killSignal: "SIGKILL",
            maxBuffer: 256 * 1024,
            windowsHide: true,
            shell: false,
          },
        );
        const value = JSON.parse(stdout);
        observation = c.type === "shrug" ? shrugObservation(value) : value;
        requireThat(
          typeof observation.title === "string" &&
            typeof observation.state === "string",
          "PRODUCT_RESPONSE",
          "Invalid product observation",
        );
        observation = {
          title: observation.title,
          state: observation.state,
          detail: observation.detail ?? "",
          location: c.resource ?? "",
        };
      } catch {
        observation = {
          title: c.id,
          state: "unknown",
          detail:
            "Product status unavailable; resource ownership remains unchanged",
          location: c.resource ?? "",
        };
      }
      const fingerprint = hash(JSON.stringify(observation));
      if (this.last.get(c.id) === fingerprint) continue;
      this.awareness.report(
        { id: "admin", role: "admin" },
        {
          key: `product:${c.id}:${fingerprint}`,
          source,
          externalId: c.id,
          ...observation,
        },
      );
      this.last.set(c.id, fingerprint);
    }
  }
}
