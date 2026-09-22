// Runs inside the dashboard's existing script, sharing its authenticated API
// helpers and observed state. It never invents topology or hardware readings.
export const presenceScript = String.raw`
    let presenceView = "live";
    let presenceImport = null;
    let presencePlanVersion = 0;
    let presenceLastFocus = null;
    let presenceBusy = false;
    let presenceRenderKey = "";
    let presenceMachineKey = "";
    let presenceInstallTimer = null;
    let presenceInstallSeen = null;
    const presencePolicyNames = { auto:"Automatic", preferred:"Prefer instant replies", always:"Keep ready" };
    function presenceNotice(message, error = false) {
      const toast = $("#presence-toast");
      toast.querySelector("span").textContent = message;
      toast.dataset.error = String(error);
      toast.hidden = false;
    }
    function presenceSetView(name) {
      if (!["live","models","machines","clients","settings"].includes(name)) name = "live";
      presenceView = name;
      document.querySelectorAll(".presence-nav [data-view]").forEach(button => {
        if (button.dataset.view === name) button.setAttribute("aria-current","page");
        else button.removeAttribute("aria-current");
      });
      document.querySelectorAll("[data-presence-panel]").forEach(panel => panel.hidden = panel.dataset.presencePanel !== name);
      for (const id of ["models","machines","clients"]) $("#view-" + id).hidden = id !== name;
      $(".operations-dock").open = name === "settings";
      closeModelInspector(); closeNodeInspector();
      if (name === "clients") presenceLoadIntegrations();
      try { history.replaceState(null,"","#" + name); } catch {}
      renderPresence();
      window.scrollTo({top:0,behavior:"instant"});
    }
    function presenceRuntime(model) {
      return model.runtime ? state.status?.runtimeManager?.runtimes?.[model.runtime] : null;
    }
    function presencePolicy(runtime) {
      return runtime?.keepWarm ? "always" : runtime?.preferredWarm ? "preferred" : "auto";
    }
    function presenceModelResident(model) {
      const rt=presenceRuntime(model),usage=rt?.memoryUsage;
      if(!rt?.healthy)return false;
      if(usage?.residencyKnown&&Array.isArray(usage.loadedModelIds))return usage.loadedModelIds.some(id=>id===model.id||id===model.upstreamModel);
      return false;
    }
    function presenceModelLabel(model) {
      const runtime = presenceRuntime(model);
      if (model.alias) return "Route";
      if (!model.runtime) return model.federated ? "Shared model" : "External provider";
      if (runtime?.maintenance) return "Paused";
      const transition={starting:"Getting ready",warming:"Getting ready",queued:"Waiting for room",stopping:"Freeing memory",draining:"Finishing work",failed:"Needs attention",unreachable:"Unavailable",disabled:"Disabled"}[runtime?.status];
      if(transition)return transition;
      if (runtime?.activeRequests > 0 && runtime?.healthy) return "Serving";
      if (presenceModelResident(model)) return "Ready to use";
      return "Starts when needed";
    }
    function renderPresenceModels() {
      const search = $("#presence-search").value.trim().toLowerCase();
      const kind = $("#presence-kind").value;
      const models = (state.physicalModels || []).filter(model =>
        (!search || (model.name + " " + model.id).toLowerCase().includes(search)) &&
        (!kind || (model.kind || "chat").startsWith(kind))
      ).sort((a,b) => Number(Boolean(b.runtime)) - Number(Boolean(a.runtime)) || Number(Boolean(presenceRuntime(b)?.healthy)) - Number(Boolean(presenceRuntime(a)?.healthy)));
      $("#presence-model-count").textContent = models.length + (models.length === 1 ? " model" : " models");
      const key = JSON.stringify(models.map(model => {const rt=presenceRuntime(model);return [model.id,model.name,model.kind,model.contextWindow,model.runtime,presenceModelLabel(model),rt?.memoryGb,rt?.node,rt?.keepWarm,rt?.preferredWarm];}));
      if (key === presenceRenderKey) return;
      presenceRenderKey = key;
      $("#presence-models").innerHTML = models.map(model => {
        const rt = presenceRuntime(model), policy = presencePolicy(rt);
        const location = rt?.node || (model.targets || []).map(t => t.node).filter(Boolean).join(", ") || (model.runtime ? "This machine" : "Upstream");
        return '<article class="presence-card"><div class="presence-card-top"><span class="presence-eyebrow">' + escapeHtml(({chat:"Chat & code",audio_speech:"Speech",audio_transcription:"Transcription",audio_generation:"Music & audio",embedding:"Embeddings",image:"Images",video:"Video"})[model.kind] || model.kind || "Chat") + '</span><span class="presence-status" data-ready="' + String(Boolean(rt?.healthy || rt?.activeRequests)) + '">' + escapeHtml(presenceModelLabel(model)) + '</span></div><h3>' + escapeHtml(model.name || model.id) + '</h3><p>' + escapeHtml(model.id) + '</p><dl><dt>Runs on</dt><dd>' + escapeHtml(location) + '</dd><dt>Memory estimate</dt><dd>' + (rt?.memoryGb != null ? escapeHtml(rt.memoryGb) + ' GB' : 'Not reported') + '</dd><dt>Availability</dt><dd>' + escapeHtml(rt ? presencePolicyNames[policy] : 'Managed upstream') + '</dd></dl><div class="actions"><button type="button" data-presence-model="' + escapeHtml(model.id) + '">Manage model</button></div></article>';
      }).join("") || '<div class="empty">' + (state.models.length ? 'No models match these filters.' : 'No configured models yet. Add a model to get started.') + '</div>';
    }
    function renderPresenceMachines() {
      const nodes = Object.values(state.status?.cluster?.nodes || {});
      const rows = nodes.length ? nodes : (state.topologySummary?.host ? [{id:"local",name:"This machine",local:true,telemetry:state.topologySummary.host}] : []);
      const key=JSON.stringify(rows.map(node=>[node.id,node.name,node.local,node.reachable,node.profile?.cpuBrand,node.telemetry?.memory?.usedBytes,node.telemetry?.memory?.availableBytes,node.telemetry?.memory?.totalBytes]));
      if(key===presenceMachineKey)return;
      presenceMachineKey=key;
      $("#presence-machines").innerHTML = rows.map(node => {
        const memory = node.telemetry?.memory || {};
        const total = Number(memory.totalBytes);
        const available = Number(memory.availableBytes);
        const used = Number.isFinite(available) ? total - available : Number(memory.usedBytes);
        const hasMemory = total > 0 && Number.isFinite(used);
        return '<article class="presence-card"><div class="presence-card-top"><span class="presence-eyebrow">' + (node.local ? 'This machine' : 'Configured peer') + '</span><span class="presence-status" data-ready="' + String(node.reachable !== false) + '">' + (node.reachable === false ? 'Unavailable' : 'Connected') + '</span></div><h3>' + escapeHtml(node.name || node.id) + '</h3><p>' + escapeHtml(node.profile?.cpuBrand || node.telemetry?.cpu?.model || node.profile?.platformId || 'Hardware details unavailable') + '</p>' + (hasMemory ? '<div class="presence-memory" aria-label="' + escapeHtml(formatBytes(used) + ' of ' + formatBytes(total) + ' memory used') + '"><span style="width:' + Math.max(0,Math.min(100,used/total*100)) + '%"></span></div><p>' + escapeHtml(formatBytes(Number.isFinite(available) ? available : used)) + (Number.isFinite(available) ? ' available / ' : ' used / ') + escapeHtml(formatBytes(total)) + '</p>' : '<p>Memory reading unavailable</p>') + '<div class="actions"><button type="button" data-presence-node="' + escapeHtml(node.id) + '"' + (state.status?.cluster?.nodes?.[node.id] ? '' : ' disabled') + '>Machine details</button></div></article>';
      }).join("") || '<div class="empty">Waiting for hardware telemetry.</div>';
    }
    function presenceClientExample() {
      const model = $("#presence-client-model").value;
      const selected=(state.physicalModels||[]).find(m=>m.id===model),kind=selected?.kind||'chat';
      const templates={chat:['/v1/chat/completions',{model,messages:[{role:'user',content:'Hello'}]}],embedding:['/v1/embeddings',{model,input:'Text to search'}],image:['/v1/images/generations',{model,prompt:'A quiet mountain lake'}],audio_speech:['/v1/audio/speech',{model,input:'Hello there',voice:'default'}],audio_generation:['/v1/audio/generations',{model,prompt:'Gentle piano'}],video:['/v1/videos/generations',{model,prompt:'A quiet mountain lake'}]};
      if(kind==='audio_transcription'){$("#presence-client-example").textContent="POST "+endpoint+"/v1/audio/transcriptions\nAuthorization: Bearer YOUR_LLOOM_KEY\nMultipart form: model="+model+", file=YOUR_AUDIO_FILE";return;}
      const [route,body]=templates[kind]||templates.chat;
      $("#presence-client-example").textContent = "POST " + endpoint + route + "\nContent-Type: application/json\nAuthorization: Bearer YOUR_LLOOM_KEY\n\n" + JSON.stringify(body,null,2);
    }
    function renderPresenceClients() {
      $("#presence-client-url").value = endpoint + "/v1";
      const select = $("#presence-client-model"), selected = select.value;
      const models = state.physicalModels || [];
      const key = models.map(m=>m.id).join("\n");
      if (select.dataset.models !== key) {
        select.innerHTML = models.map(m=>'<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name || m.id) + '</option>').join("");
        if (models.some(m=>m.id === selected)) select.value = selected;
        select.dataset.models = key;
      }
      $("#presence-client-auth").textContent = state.security?.authRequired ? "Use a configured inference key. Keep your admin key out of client applications." : "This loopback gateway allows local clients without a key. Remote access requires authenticated configuration.";
      presenceClientExample();
    }
    function renderPresence() {
      if (!$("#presence-models")) return;
      const safety = state.status?.runtimeManager?.memorySafety;
      const warning = $("#presence-memory-safety");
      if(warning) warning.hidden = safety?.mode !== "yolo";
      renderPresenceModels(); renderPresenceMachines(); renderPresenceClients(); renderPresencePolicy();
    }
    function renderPresencePolicy() {
      const model = state.physicalModels.find(m=>m.id === state.selectedModelId);
      const runtime = model && presenceRuntime(model);
      if(model) $("#model-inspector-state span:last-child").textContent=presenceModelLabel(model);
      $("#presence-policy").hidden = !model;
      $("#presence-trial").hidden = !model || (model.kind || "chat") !== "chat";
      for (const button of document.querySelectorAll("[data-residency]")) {
        button.disabled = presenceBusy || !runtime || runtime.enabled === false || runtime.management === "external" || runtime.remote === true || Boolean(runtime.maintenance);
        button.setAttribute("aria-pressed",String(Boolean(runtime) && presencePolicy(runtime) === button.dataset.residency));
      }
      const managed=runtime&&runtime.enabled!==false&&runtime.management!=="external"&&!runtime.remote&&!runtime.distributed&&!runtime.maintenance;
      const transitioning=runtime&&['starting','warming','queued','draining','stopping'].includes(runtime.status);
      for(const id of ['model-start','model-stop'])$("#"+id).disabled=presenceBusy||!managed||transitioning;
      $("#model-start").textContent=transitioning?"Getting ready…":"Make ready now";
      $("#model-stop").disabled||=Boolean(runtime?.activeRequests||runtime?.queuedRequests||runtime?.keepWarm);
      $("#presence-send").disabled=presenceBusy||Boolean(runtime?.maintenance)||runtime?.enabled===false;
      $("#presence-availability").textContent=!runtime?"Available through your connected provider.":runtime.maintenance?"Paused. This model is protected from starting.":transitioning?"LLooM is getting this ready for you.":runtime.status==='failed'?"This model needs attention. Open details to see what happened.":"Just use it. LLooM prepares this automatically when your app asks.";
      $("#presence-policy-hint").textContent = !runtime?"Your provider manages availability.":presencePolicy(runtime)==="always"?"Kept ready for quick replies. Choose Automatic if you want LLooM to reclaim its memory.":presencePolicy(runtime)==="preferred"?"Stays ready when there is room. LLooM makes space when another model needs it.":"Recommended: LLooM gets this ready when needed. Your downloaded files stay on disk.";
      $("#presence-model-error").textContent=runtime?.lastError||"";
    }
    async function presenceLoadIntegrations() {
      try {
        const manifest = await getJson("/gateway/integrations");
        $("#presence-integrations").innerHTML = (manifest.clients || []).map(client=>'<details><summary>' + escapeHtml(client.name || client.id) + '</summary><pre>' + escapeHtml("lloom integrate " + client.id) + '</pre><p class="muted">Preview first. Add --apply --yes only after reviewing the generated configuration.</p></details>').join("") || "No client profiles available.";
      } catch(error) { $("#presence-integrations").textContent = error.message; }
    }
    function presenceInvalidatePlan() {
      presenceImport = null; presencePlanVersion++;
      $("#presence-add-review").hidden = true; $("#presence-add-apply").hidden = true;
      $("#presence-add-plan").hidden = false;
    }
    function presenceOpenAdd() {
      presenceLastFocus = document.activeElement;
      presenceInvalidatePlan();
      $("#presence-add-error").textContent = "";
      const selected = state.library?.selected;
      $("#presence-recommendation").innerHTML = selected
        ? '<div class="presence-card"><span class="presence-eyebrow">Recommended for this hardware</span><h3>' + escapeHtml(selected.name || selected.recipeId) + '</h3><p>' + escapeHtml((selected.reasons || []).join(" · ") || "Matched by the local recipe library.") + '</p><button type="button" id="presence-use-recipe">Review recommended setup</button></div>'
        : '<p class="muted">No compatible recipe recommendation is available yet.</p>';
      $("#presence-add").hidden = false; $("#presence-model-ref").focus();
    }
    function presenceCloseAdd() {
      if (presenceBusy) return;
      $("#presence-add").hidden = true; presenceLastFocus?.focus();
    }
    async function presenceReviewRecipe() {
      const selected = state.library?.selected;
      if (!selected) return;
      const recipeId = selected.recipeId;
      const version = presencePlanVersion;
      const plan = await postJson("/gateway/installations/plan",{recipeId});
      if(version!==presencePlanVersion)return;
      presenceImport = {planId:plan.planId};
      presenceShowPlan(plan);
    }
    function presenceShowPlan(plan) {
      $("#presence-plan-json").textContent = JSON.stringify(plan.details || plan,null,2);
      $("#presence-plan-summary").textContent = plan.summary || "Review the packages, model files, and configuration this installation will use.";
      $("#presence-add-review").hidden = false;
      $("#presence-add-apply").hidden = plan.ok === false;
      $("#presence-add-plan").hidden = plan.ok !== false;
    }
    async function presenceRun(button, action) {
      if (presenceBusy) return;
      presenceBusy = true;
      if (button) button.disabled = true;
      renderPresencePolicy();
      try { return await action(); }
      catch(error) { presenceNotice(error.message,true); $("#presence-add-error").textContent = error.message; }
      finally { presenceBusy = false; if(button) button.disabled=false; renderPresencePolicy(); }
    }
    async function presencePollInstallation() {
      clearTimeout(presenceInstallTimer);
      try {
        const {job}=await getJson("/gateway/installations");
        if(!job)return;
        if(job.status==="running") {
          presenceNotice(job.detail);
          presenceInstallTimer=setTimeout(presencePollInstallation,1500);
        } else if(presenceInstallSeen!==job.id) {
          presenceInstallSeen=job.id;
          presenceNotice(job.error || job.detail,job.status==="failed");
          await refresh();
        }
      } catch(error) { presenceNotice("Could not read installation progress: "+error.message,true); }
    }
    // Keep the model inspector available from every view, rather than clipping
    // it when the canvas is hidden.
    document.body.append($("#model-inspector"),$("#node-inspector"));
    const inspectorBody=$("#model-inspector .model-inspector-body");
    const availability=document.createElement("p");availability.id="presence-availability";availability.className="presence-availability";inspectorBody.prepend(availability);
    const policy = document.createElement("section");policy.id = "presence-policy";
    policy.innerHTML = '<h3>When should this stay ready?</h3><div class="presence-readiness">' + Object.entries(presencePolicyNames).map(([id,name])=>'<button type="button" data-residency="' + id + '" aria-pressed="false">' + name + '</button>').join("") + '</div><p id="presence-policy-hint" class="muted"></p>';
    const trial = document.createElement("section");trial.id = "presence-trial"; trial.className = "presence-trial";
    trial.innerHTML = '<label for="presence-prompt">Ask anything</label><textarea id="presence-prompt" placeholder="What can I help you with?" maxlength="8000"></textarea><button id="presence-send" class="primary" type="button">Send message</button><pre id="presence-answer" aria-live="polite"></pre>';
    inspectorBody.append(trial);
    const connect=document.createElement("button");connect.type="button";connect.id="presence-connect";connect.textContent="Connect an app";inspectorBody.append(connect);
    connect.addEventListener("click",()=>{const id=state.selectedModelId;presenceSetView("clients");if([...$("#presence-client-model").options].some(option=>option.value===id))$("#presence-client-model").value=id;presenceClientExample();});
    const technical=document.createElement("details");technical.className="presence-advanced";
    technical.innerHTML='<summary>Options & details</summary><p id="presence-model-error" role="status"></p>';
    technical.append(policy,$("#model-inspector .model-inspector-actions"),$("#model-inspector-details"),$("#model-inspector-tags"));inspectorBody.append(technical);
    $("#model-start").textContent="Make ready now";$("#model-warm").remove();$("#model-stop").textContent="Free up memory";
    const oldRenderModels = renderModels;
    renderModels = function() { oldRenderModels(); renderPresence(); };
    const oldRenderInspector = renderModelInspector;
    renderModelInspector = function() { oldRenderInspector(); renderPresencePolicy(); };
    const oldShowOutput = showOutput;
    showOutput = function(value) { oldShowOutput(value); presenceNotice(value?.error?.message || value?.error || "Operation complete. Details are in Settings.",Boolean(value?.error)); };
    const keyField = $("#api-key").closest("label");
    keyField.style.cssText = "";
    const settingsHeader = document.createElement("div"); settingsHeader.className="presence-heading";
    settingsHeader.innerHTML='<div><h2>Settings &amp; details.</h2><p>Authentication, recipes, runtimes, and installation plans.</p></div>';
    $(".operations-content").prepend(settingsHeader,keyField);
    $("#api-key").addEventListener("change",()=>{ sessionStorage.setItem("lloom_api_key",$("#api-key").value.trim()); localStorage.removeItem("lloom_api_key"); refresh(); });
    $(".presence-nav").addEventListener("click",event=>{const button=event.target.closest("[data-view]"); if(button) presenceSetView(button.dataset.view);});
    $("#presence-toast button").addEventListener("click",()=>$("#presence-toast").hidden=true);
    $("#presence-search").addEventListener("input",()=>renderPresenceModels());
    $("#presence-kind").addEventListener("change",()=>renderPresenceModels());
    $("#presence-client-model").addEventListener("change",presenceClientExample);
    $("#presence-copy-url").addEventListener("click",event=>presenceRun(event.currentTarget,async()=>{await navigator.clipboard.writeText(endpoint+"/v1");presenceNotice("Gateway URL copied.");}));
    $("#presence-copy-example").addEventListener("click",event=>presenceRun(event.currentTarget,async()=>{await navigator.clipboard.writeText($("#presence-client-example").textContent);presenceNotice("Example request copied. Replace the key placeholder in your client.");}));
    $("#presence-add-close").addEventListener("click",presenceCloseAdd);
    $("#presence-add-form").addEventListener("input",presenceInvalidatePlan);
    $("#presence-add-form").addEventListener("submit",event=>{
      event.preventDefault(); const button=$("#presence-add-plan");
      presenceRun(button,async()=>{
        const version=presencePlanVersion;
        const input={modelRef:$("#presence-model-ref").value.trim(),backend:$("#presence-model-backend").value.trim()||undefined,name:$("#presence-model-name").value.trim()||undefined};
        const plan=await postJson("/gateway/installations/plan",input);
        if(version!==presencePlanVersion)return;
        presenceImport={planId:plan.planId}; presenceShowPlan(plan);
      });
    });
    $("#presence-add-apply").addEventListener("click",event=>presenceRun(event.currentTarget,async()=>{
      if(!presenceImport || !ensureAdminKeyIfNeeded()) return;
      await postJson("/gateway/installations",{...presenceImport,yes:true});
      presenceBusy=false; presenceCloseAdd(); presencePollInstallation();
    }));
    document.addEventListener("click",event=>{
      const add=event.target.closest("[data-add-model]");
      if(add) presenceOpenAdd();
      const model=event.target.closest("[data-presence-model]");
      if(model) {openModelInspector(model.dataset.presenceModel);$("#model-inspector-close").focus();}
      const machine=event.target.closest("[data-presence-node]");
      if(machine) openNodeInspector(machine.dataset.presenceNode);
      if(event.target.closest("#presence-use-recipe")) presenceRun(event.target.closest("button"),presenceReviewRecipe);
      const residency=event.target.closest("[data-residency]");
      if(residency) presenceRun(residency,async()=>{
        const model=state.physicalModels.find(m=>m.id===state.selectedModelId);
        if(!model?.runtime || !ensureAdminKeyIfNeeded()) return;
        const path="/gateway/runtimes/"+encodeURIComponent(model.runtime)+"/residency";
        const accepted=await postJson(path,{policy:residency.dataset.residency,yes:true});
        presenceNotice("Preference saved. LLooM will take care of it.");
        const poll=async()=>{
          try {
            const {job}=await getJson(path);
            if(!job || job.id!==accepted.id)return;
            if(job.status==='pending'){setTimeout(poll,1500);return;}
            await refresh();
            presenceNotice(job.status==='failed'?"Could not update availability: "+job.error:job.policy==='auto'?"LLooM will prepare this when your app needs it.":"Availability updated: "+presencePolicyNames[job.policy]+".",job.status==='failed');
          }catch(error){presenceNotice("Could not check readiness: "+error.message,true);}
        };
        setTimeout(poll,500);
      });
    });
    // Capture legacy runtime actions once, add bounded busy/error handling, and
    // keep preparation behind the normal admission and safety checks.
    document.addEventListener("click",event=>{
      const button=event.target.closest("button[data-runtime]");
      if(!button) return;
      event.stopImmediatePropagation();
      if(button.disabled || !button.dataset.runtime || !ensureAdminKeyIfNeeded()) return;
      presenceRun(button,async()=>{
        const load=button.dataset.action==="start";
        const action=load?"admit":button.dataset.action;
        const result=await postJson("/gateway/runtimes/"+encodeURIComponent(button.dataset.runtime)+"/"+action,load?{apply:true,yes:true,force:false,warmup:true}:{});
        oldShowOutput(result);await refresh();presenceNotice(load?"Ready for your apps.":"Memory released. The model stays installed.");
      });
    },true);
    $("#presence-send").addEventListener("click",event=>presenceRun(event.currentTarget,async()=>{
      const prompt=$("#presence-prompt").value.trim(), model=state.selectedModelId;
      if(!prompt || !model) return;
      $("#presence-answer").textContent="Waiting for "+model+"…";
      try {
        const result=await postJson("/v1/chat/completions",{model,messages:[{role:"user",content:prompt}],max_tokens:256,stream:false});
        $("#presence-answer").textContent=result.choices?.[0]?.message?.content || "No text response returned.";
      } catch(error) { $("#presence-answer").textContent=error.message; throw error; }
    }));
    document.addEventListener("keydown",event=>{
      if(event.key==="Escape") {presenceCloseAdd();closeModelInspector();closeNodeInspector();}
      const dialog=!$("#presence-add").hidden?$("#presence-add .presence-dialog"):null;
      if(event.key==="Tab" && dialog) {
        const items=[...dialog.querySelectorAll('button:not([disabled]),input,select,textarea,summary')].filter(el=>el.getClientRects().length);
        const first=items[0],last=items.at(-1);
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
      }
    });
    presenceSetView(location.hash.slice(1));
    presencePollInstallation();
`;
