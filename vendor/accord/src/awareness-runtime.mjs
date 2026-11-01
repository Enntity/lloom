// SPDX-License-Identifier: MIT
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { requireThat } from "./common.mjs";
import { join } from "node:path";
import { ProductObservers } from "./product-observers.mjs";
import { TranscriptObserver } from "./observers.mjs";
import { SessionSummaries, modelSummarizer } from "./session-summaries.mjs";

// Optional adapters reload independently of ownership. Invalid adapter settings
// disable observations and expose a diagnostic; they cannot stop lease recovery.
export function awarenessRuntime(data, awareness) {
  const path = join(data, "awareness.json");
  let signature,
    observer,
    products,
    summaries,
    closed = false,
    busy = false,
    activeState = "ready";
  let status = {
    state: "starting",
    summaryEnabled: false,
    sources: [],
    products: [],
    lastScan: null,
  };
  function configure() {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}";
    if (raw === signature) return;
    observer = products = summaries = null;
    if (raw.length > 1024 * 1024) throw Error("Adapter config too large");
    const config = JSON.parse(raw);
    if (config.private)
      for (const row of awareness.db
        .prepare("SELECT DISTINCT source FROM session_views")
        .all()) {
        awareness.privacy(
          { id: "admin", role: "admin" },
          { source: row.source, private: true, key: randomUUID() },
        );
      }
    const roots = config.private ? [] : (config.roots ?? []);
    if (!Array.isArray(roots) || roots.length > 16)
      throw Error("Invalid roots");
    observer = new TranscriptObserver({ awareness, roots });
    products = new ProductObservers({
      awareness,
      configs: config.private ? [] : (config.products ?? []),
    });
    const key = config.summary?.keyFile
      ? readFileSync(config.summary.keyFile, "utf8").trim()
      : undefined;
    const complete = config.private
      ? null
      : modelSummarizer(config.summary, key);
    summaries = new SessionSummaries({ awareness, complete });
    activeState = config.private ? "private" : "ready";
    status = {
      ...status,
      state: activeState,
      summaryEnabled: !!complete,
      sources: roots.map((r) => r.source),
      products: products.configs.map((p) => p.id),
    };
    signature = raw;
  }
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      configure();
      const scan = await observer?.scan();
      await products?.scan();
      await summaries?.tick();
      status = { ...status, state: activeState, lastScan: Date.now(), scan };
    } catch {
      status = { ...status, state: "adapter-error", summaryEnabled: false };
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 10000);
  void tick();
  return {
    configureSummary(actor, args) {
      requireThat(actor.role==='admin','FORBIDDEN','Operator required',403);
      const config=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
      if(args.ifAbsent===true&&config.summary)return {configured:true,existing:true};
      if(args.enabled===false)config.summary=null;
      else {
        requireThat(typeof args.url==='string'&&typeof args.model==='string'&&args.model.length>0&&args.model.length<=200,'INVALID_INPUT','Summary endpoint and model required',400);
        const next={url:args.url,model:args.model,...(config.summary?.keyFile?{keyFile:config.summary.keyFile}:{})};
        modelSummarizer(next); // Validate before changing a working configuration.
        if(args.key!==undefined){
          requireThat(typeof args.key==='string'&&args.key.length<=8192,'INVALID_INPUT','Invalid provider key',400);
          const keyFile=join(data,'summary-provider.key'),temporary=keyFile+'.tmp-'+randomUUID();
          writeFileSync(temporary,args.key,{mode:0o600,flag:'wx'});renameSync(temporary,keyFile);next.keyFile=keyFile;
        }
        config.summary=next;
      }
      const temporary=path+'.tmp-'+randomUUID();
      writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,path);
      // Reload on the observation loop; outstanding old results still require current revisions.
      return {configured:true,enabled:!!config.summary};
    },
    status: () => ({ ...status }),
    async close() {
      closed = true;
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
