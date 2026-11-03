# HTTP contract

All routes require a bearer credential except the board's static assets and
the minimal `/.well-known/accord` descriptor. The
coordinator and driver bind only `127.0.0.1`. On macOS and Linux the coordinator also
listens on `accord.sock` in the private data directory, and `endpoints.json` names it
as `local`; local clients use that and never fall back to TCP. Host and Origin are checked; no CORS
access is enabled. A JSON request body is limited to 32 KiB. Redirects are never
followed by the client. Errors are `{error:{code,message}}` with HTTP status.

Authenticated worker responses, including errors after authentication, also carry
`inboxPending: N` when inbox deliveries are pending. Zero is omitted.
A failed count yields `inboxPending: "unknown"`; clients should check their inbox.
The hint never acknowledges a delivery and adds no client request. Discovery and
operator responses do not inherit worker mail. Driver-only operations and local
commands that never contact the coordinator cannot supply this hint.

Every coordinator mutation requires a `key` (1–128 characters). Keys are unique
per actor across operations. A retry with the same serialized payload returns
the original response. A different payload or operation with that key returns
`KEY_REUSED`. Use a fresh key for a new attempt, task, renewal, or checkpoint.
Errors are not memoized. A retried claim returns its current status; a closed
claim never returns its old resource credential.

| Method | Route | Body or result |
| --- | --- | --- |
| GET | `/health` | Authenticated leadership health |
| GET | `/v1/me` | Authenticated `{id,role}` |
| GET | `/v1/board?after=0` | Current tasks, claims, hold, admission state, up to 500 events, cursor and hasMore |
| POST | `/v1/tasks` | `{key,title,input,expectedHash,dependency?,maxAttempts?}` → `{taskId}` |
| POST | `/v1/claim` | `{key,taskId?,leaseMs?}` → claim, task, driver URL; resourceToken only when active |
| GET | `/v1/claims/{id}` | Owner-only claim status, task and active resource credential |
| POST | `/v1/claims/{id}/checkpoint` | `{key,note}`; current owner only |
| POST | `/v1/claims/{id}/renew` | `{key,leaseMs}`; cannot revive an expired attempt |
| POST | `/v1/claims/{id}/finish` | `{key,receiptId}` → verified and releasing; success follows release confirmation |
| POST | `/v1/tasks/{id}/cancel` | `{key}`; admin only; requested and confirmed cancellation are distinct |
| POST | `/v1/steer` | `{key,paused:boolean}`; admin only |

If taskId is omitted, claim selects the oldest eligible queued task. The service
does not grant ownership to a mere observer. A busy task/resource returns 409.
Only `succeeded` unblocks dependencies. Dependencies must refer to preexisting
tasks and cannot be edited, preventing cycles in this initial API.

The task's expectedHash is a lower-case SHA-256 digest. `input` is at most 8,000
characters; checkpoint notes are at most 4,000. Tasks are immutable after submit
apart from their lifecycle, checkpoint and result. This release has a 5,000-task
limit, 100,000 accepted-command limit, and 100,000-artifact limit. History is not
pruned. It is a bounded database, not a long-lived retention service.

## Driver API

Workers receive only the resource credential for their current claim. It is an
HMAC derived from the coordinator's private secret and claim ID; the driver stores
its hash. Board and event responses never include credentials.

`POST /v1/artifacts` accepts `{key,content}` using that resource credential. It
validates the active grant and atomically stores UTF-8 content and a receipt.
The same key within one claim returns the original receipt for identical content;
different content is rejected. A revoked credential cannot replay even this
write route. Content is limited to 8,000 characters.

The coordinator separately holds the driver's control credential. Control routes:

| Route | Contract |
| --- | --- |
| GET `/control/status` | Driver instance, bound authority, highest epoch/generation, active claim |
| POST `/control/activate` | `{instance,authority,epoch,generation,claimId,credentialHash}` |
| POST `/control/revoke` | `{instance,authority,epoch,generation,claimId}` |
| GET `/control/receipts/{id}` | Receipt metadata for acceptance validation |
| GET `/control/artifacts/{id}` | Stored artifact content |
| GET `/control/audit` | Ordered driver grant, revoke, restart, and write records |

Control commands persist before acknowledgment. A same-generation activation is
idempotent only while that exact grant remains active; once revoked, that
generation cannot become active again. Revoke creates a tombstone even if the
matching activation has not arrived. A higher generation cannot replace an active
grant without release. A different driver instance or coordinator authority is
refused rather than silently adopted.

## Client example

```js
import { readFileSync } from 'node:fs';
import { AccordClient } from './src/client.mjs';

const client = new AccordClient('http://127.0.0.1:8787',
  readFileSync('.accord/agent-a.token', 'utf8').trim());
let claim = await client.claim();
while (claim.state === 'preparing') {
  await new Promise(resolve => setTimeout(resolve, 100));
  claim = await client.inspect(claim.id);
}
if (claim.state !== 'running') throw Error('Grant did not become active');
await client.checkpoint(claim.id, 'Input inspected; preparing the output.');
const receipt = await client.write(claim, claim.task.input.toUpperCase());
await client.finish(claim.id, receipt.id);
```

This sample assumes the task expects uppercase output. A real adapter chooses its
own work implementation and renews before its deadline. A driver receipt proves
an artifact was stored; the configured digest check proves only exact equality,
not general semantic quality.

## Bootstrap and discovery (0.2)

Migration 2 adds session, purpose-credential, and peer tables without altering
migration 1. Existing authority, claims, checkpoints and generations are retained.
The coordinator's startup adds bootstrap credentials to original preview data;
stop the old service before upgrading. The original actor credentials still work.

| Method | Route | Authorization and result |
| --- | --- | --- |
| GET | `/.well-known/accord` | No credential; only protocol and authority ID, while coordinator is healthy |
| POST | `/v1/sessions` | Enrollment credential; `{key,authority,label,harness,ttlMs?}` → distinct session, expiry, session credential |
| POST | `/v1/sessions/{id}/close` | Session owner or admin; `{key}` → closed; held resources still require confirmed release |
| GET | `/v1/bootstrap` | Worker/admin; identity, live host metadata, directly paired peers, durable board |
| GET | `/v1/host` | Discovery credential or worker/admin; host identity and current ownership metadata |
| GET | `/v1/network` | Worker/admin; local host plus direct peers, each observed or unknown |
| POST | `/v1/peers` | Admin; `{key,authority,url,credential}` pins a verified peer discovery connection |
| POST | `/v1/peers/remove` | Admin; `{key,authority}` removes that discovery connection |
| POST | `/v1/claims/{id}/artifact` | Active owning worker; `{key,content}` writes through the local driver |

The enrollment response is the only bootstrap response containing a session
credential. The service stores its hash; the value is derived from a private
secret and session ID, allowing idempotent enrollment retries. Closed or expired
sessions cannot be reactivated by replay. Session metadata on the board has no
credential. Discovery exposes no task input, checkpoint content, or peer secrets.

The proxy artifact endpoint allows one SSH forward for remote worker traffic.
The host authenticates the session and current claim before contacting its local
driver; the driver checks its current grant again. Revocation in flight remains
an unknown-release interval, not a claim that all external processes have stopped.

MCP exposes bootstrap, host, board, claim/wait/status, checkpoint, renewal, artifact
write and finish. Tool mutation keys are explicit. Tools do not return driver
credentials and cannot add peers, impersonate another session, or steer as admin.
A tool wait returns at most a preparing/running claim; inspect before effects.
The CLI/JS wait helper is bounded polling, not a durable fairness queue.

Peer addresses in this version are loopback HTTP origins, normally SSH forwards.
Host validation accepts loopback names with forwarded ports. Browser Origin must
match the request Host exactly, and CORS remains disabled. The public descriptor
is discovery metadata; trust comes from an explicitly pinned authority and the
separately provisioned credential, not merely seeing a UUID.
