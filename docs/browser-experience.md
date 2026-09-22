# The LLooM browser experience

LLooM chooses and operates vendor recipes. Recipe vendors own model execution, backend tuning, and distributed execution contracts. The dashboard presents the hardware, installation, readiness, and serving decisions that belong to LLooM.

## First run

After installing the CLI from the repository, run `lloom` in an interactive terminal. With no installed configuration, a loopback setup server opens a browser. Choose Chat & write, Code, Images, or Voice; review the compatible recipe and installation details; then choose **Set up my AI**.

The setup page uses the bundled recipe library. Unsupported hardware or workloads produce an explicit explanation. Unknown download sizes, credentials, or license information stay unknown. A recipe metadata license does not cover the model weights.

Installation runs as a background job in the setup process. Refreshing the page resumes its progress. Keep the terminal open. A failed bootstrap can retry only the exact, unchanged configuration created by that session, within the original 30-minute review window. After a process restart, use `lloom bootstrap --apply --yes` or the installed dashboard to continue. Setup never silently replaces another configuration.

After installation, LLooM starts the gateway and checks a chat request through its normal inference API. Health alone does not mean the model is ready. Media recipes require checking their actual output; the page identifies that remaining step.

`lloom --no-browser`, `lloom onboard`, and `lloom up --go` preserve the CLI paths. JSON, offline, and explicit recipe flags do not unexpectedly launch a browser. `lloom ui` opens an installed gateway.

## Daily use

- **Live** shows clients, gateway nodes, models, and observed traffic. A luminous gateway connects client cards to model rows grouped by physical machine. Active requests drive the light trails. Follow activity focuses the scene on serving models. Detailed topology retains the diagnostic canvas and its manual camera controls. Both views honor reduced motion.
- **Models** searches and filters the actual gateway catalog. The inspector offers Load, Warm up, Unload, readiness policy, and a small chat trial. Runtime details remain available in a disclosure.
- **Add model** reviews a vendor recipe or custom model reference before starting a background installation. Plan IDs bind the reviewed input, recipe/backend catalog, and configuration version. Concurrent or stale changes fail visibly. Custom Hugging Face imports require an immutable commit link and publish only after staged acquisition verification. Downloads remain reusable. The new installation API does not accept arbitrary config paths or shell commands.
- **Machines** shows configured physical nodes and their individual memory readings. Memory is never presented as one interchangeable pool. Distributed model execution requires a compatible vendor recipe.
- **Clients** supplies the gateway base URL, exact model IDs, an example request, and CLI integration commands. Admin credentials do not belong in client applications.
- **Settings** retains the advanced recipe, backend, runtime, and setup tools.

Readiness policies express intent: **Auto** loads on demand, **Prefer ready** uses the existing idle residency reconciler, and **Always ready** prevents automatic eviction. All loading still passes through memory admission. Changing readiness does not restart a model or interrupt active work. The API returns a pending job while the current admission completes; the page reports completion or failure. Queued residency starts recheck the saved policy, and pending hard pins protect eviction victims. Use Load when you want to start a cold model immediately.

### Memory protection

Admission counts live host memory use, including other applications, even when the policy specifies only a reserve or an absolute budget. Model estimates are planning inputs, not allocation limits.

Memory protection is enabled by default. A newly started backend is checked before launch and monitored during loading and warmup. If available memory reaches the hard reserve or host utilization reaches the ceiling, LLooM aborts that load, cleans up its processes, and reports the failed threshold. Ordinary Load, forced starts, and disabling automatic eviction do not disable this protection. Automatic retries are blocked until a manual retry or gateway restart. Suspend a model to keep it blocked across restarts.

The installed config accepts `runtimePolicy.memorySafety` with `mode`, `minAvailableMemoryGb`, `maxMemoryUtilization` (a fraction), and `pollIntervalMs`. The normal mode is `"enforce"`. The default ceiling is 90%; the host reserve can impose a stricter limit. Sampling is a userspace safeguard, not a kernel-enforced allocation quota: a backend can allocate between samples.

For deliberate manual experiments, `"mode": "yolo"` disables memory admission and the hard load guard. It leaves authentication, runtime ownership, and maintenance gates in place. The dashboard displays a persistent YOLO warning. Restore `"enforce"` before normal operation; YOLO can exhaust the host's memory.

## Local security

First-run setup binds only to loopback and uses a random session token passed through the URL fragment. It removes the fragment immediately and keeps the token in that tab's session storage. Setup rejects foreign origins, alternate authorities, oversized bodies, and unreviewed apply inputs. Configuration publication cannot overwrite a file created concurrently.

The installed dashboard rejects cross-origin management requests and DNS-rebound loopback authorities. Its page cannot be framed. Remote management writes require both explicit remote-admin enablement and a configured admin key; inference keys alone cannot authorize them. Inference compatibility is unchanged. Local same-user processes remain inside the local trust boundary.

Installation jobs and reviewed plan IDs live in the gateway process. Browser refresh is supported; a gateway restart requires a fresh plan. Existing installer stage state and downloaded files support subsequent retries. The config mutation store detects concurrent writes but is not a cross-process transaction lock.

## Remaining product work

The repository is still the distribution source; a signed single-command installer and published npm package are not part of this change. Nearby discovery and approval-based pairing between independently installed gateways need an authenticated node identity protocol. The Machines page does not invent peers or automatically grant access. Existing configured federation remains available through the CLI and gateway.
