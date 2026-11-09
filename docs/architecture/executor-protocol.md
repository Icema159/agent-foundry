# Isolated executor protocol — Phases 11.2b–11.3

Implemented: authenticated polling, durable pre-start claims/leases, a narrowly
pinned Docker `health_ping({})` executor, atomic online start authorization, local
SQLite start/result ledger and durable result acknowledgements. Phase 11.2d adds anchored ledger continuity,
pre-poll evidence correlation and authenticated operator findings.
Phase 11.3 adds one human-approved WRITE receipt path; generic WRITE, DESTRUCTIVE
and EXTERNAL_WRITE remain disabled. See [external approvals](external-approvals.md)
for its exact resource, approval, result and deployment contract.
Polls, claims, eligibility checks and agent-facing receipts **never** grant execution.
Only the first committed executor-only start response may return `startAllowed: true`.

The [authorization foundation](external-authorization.md) owns resource interpretation,
grants and immutable request snapshots. The reference worker, BullMQ, AgentRuntime,
approvals, recovery and R1/R2/R3 are unchanged and do not process these claims.

## Authentication and HTTP contract

The existing loopback external API hosts a separate `/api/v1/executor` namespace.
Each request authenticates a Bearer credential anew. Only EXECUTOR principals with
a real matching owner/deployment may use it. Agent and operator credentials are
rejected. Executor credentials cannot use agent, registry, grant or approval APIs.
Identity and deployment are server-derived, never accepted in request bodies.

Explicit scopes are `executor:claim`, `executor:lease`, `executor:session`,
`executor:start` and `executor:report`. Existing credentials
do not acquire them. A trusted administrator must issue a suitably scoped credential;
there is no public issuance or administrative endpoint. The fixed runtime requires all five.
The existing `executor:identify` scope alone provides no protocol access.

| Endpoint | Scope | Request / response |
| --- | --- | --- |
| POST /api/v1/executor/poll | executor:claim | `{ "limit": 10 }` or `{}`; up to 10 safe offers, no claim created |
| POST /api/v1/executor/claims | executor:claim | `{ "invocationId": "…", "requestKey": "…" }`; committed claim receipt |
| GET /api/v1/executor/claims/:id | executor:lease | Claim receipt and current eligibility flag |
| POST /api/v1/executor/claims/:id/renew | executor:lease | `{ "generation": 1 }`; updated deadline |
| POST /api/v1/executor/claims/:id/release | executor:lease | `{ "generation": 1 }`; safe pre-start release |

All POST bodies require JSON. Existing limits remain: 64 KiB request, 128 KiB
response, strict fields and IDs, 401 authentication, 403 role/scope, 404 inaccessible
records, 400 validation, 405 methods and 415 content type. Lifecycle failures use
409 with stable codes such as NOT_CLAIMABLE, STALE_CLAIM, LEASE_EXPIRED,
AUTHORIZATION_INVALID, CLAIM_KEY_CONFLICT or START_BOUNDARY_UNRESOLVED.

Offers contain Invocation/run/version/tool identity only. Receipts contain claim ID,
Invocation/run/deployment, generation, status, deadline and timestamps. Claim responses contain no arguments, handler code, privileged payload, raw
credentials, credential IDs, policy snapshots or usable start tokens. A claim ID plus generation is fencing metadata,
not standalone authentication. General Invocation history adds only the actual
claim ID/generation/deadline for protocol events; unrelated DTOs are unchanged.

## Durable state and idempotency

`ExecutorClaim` records owner, deployment, Invocation/run, claiming principal and
exact credential, request key, pinned authorization digest, generation, deadline,
status and closure. It is separate from TaskRun leases. States are ACTIVE, RELEASED,
EXPIRED and REVOKED. An ACTIVE claim puts the Invocation in CLAIMED.

One active claim per Invocation is enforced by a partial unique index. Generation
is positive, monotonically allocated under the Invocation/run lock and unique per
Invocation. Claims cannot be deleted, identities/generations cannot be edited, and
closed claims cannot be reopened. Request keys are unique per owner/executor
principal and bound to the exact Invocation and claiming credential.

Persist the request key before submission. An identical retry returns the same
still-current authorized claim without another event or generation. Changed target
or credential gives CLAIM_KEY_CONFLICT. An expired, released or superseded request
key never creates a replacement claim. Use a new key only after reconciling a proven
pre-start release/expiration. Duplicate polls never reserve work.

`FOUNDRY_EXECUTOR_LEASE_MS` defaults to 30000 and accepts integer values from 1000
through 120000, read once at API startup. Empty/invalid values fail configuration.
Deadlines are capped by the executor credential and pinned requester/binding expiry.
Only the same principal AND exact credential can inspect/renew/release its claim.
Credential rotation does not transfer a claim. Superseded generations are rejected.
An identical release is acknowledged only while that released claim remains latest.

## Locking, reauthorization and reconciliation

Each operation locks the owner-scoped run first, then both actors' relevant
credential rows in sorted ID order, their principals in sorted order, the Invocation,
then grant, deployment and binding through `recheckPinnedAuthorization`. This avoids
cross-actor lock inversion and coordinates with row-locking revocations. UTC database
time is sampled after waits. Snapshot identity/arguments remain immutable.

Claim, renewal and reconciliation recheck the original requester credential and
the current pinned grant/binding. The claiming executor credential is also checked.
Renewal requires current unexpired fencing and authorization; elapsed leases cannot
be revived. Generation changes, state changes and their audit events commit together.
Two concurrent claims have one winner; the loser cannot overwrite assignment state.

Polling reconciles at most 10 existing claims, then checks at most 30 READY candidates
and returns up to 10 eligible offers. This is bounded polling, not a fairness or
production scheduling guarantee. Unclaimed READY records with stale authorization
are omitted and rejected at claim; their status is not automatically rewritten.

On expiry, disconnection or claimant credential revocation, a claim may return to
READY only if the Invocation is still CLAIMED, the exact active generation has no
start marker/history, the run is open and pinned authorization remains valid. The
old claim becomes EXPIRED or REVOKED; a later claim receives a larger generation.
Invalid underlying authorization instead makes the pre-start Invocation REVOKED.
Reconciliation survives process restart because it reads PostgreSQL exclusively.
There is no background scanner: progress requires subsequent polling/claim/lease
requests. Revocation may make operations unusable before their stored status changes.

UNKNOWN, post-start statuses or any recorded start evidence prevent automatic
release/reassignment. The `startAuthorizedAt` field may transition once from NULL only alongside an exact
immutable ExecutorStart record. Database claim guards
also reject recycling when start/uncertainty history exists. No timeout is recorded
as tool FAILED. Existing agent cancellation remains restricted to blocked REQUESTED
Invocations; it cannot manipulate claim state. No human approval transition is added.

## Fixed execution installation and isolation

For READ_ONLY, only operator-approved bindings with `execution: { profile: "docker-health-ping-v1",
ledgerId: "<UUID>" }` enable this path. `TrustedResourceBindings.approveResourceFree`
requires the exact `health_ping` / `health_ping.v1` revision and empty schema, and pins
the deployment, handler SHA-256 digest and ledger identity. Older bindings remain
metadata-only. Changing an installation requires a new reviewed binding, not editing
an immutable snapshot. A grant reviewed above READ_ONLY stays PENDING_APPROVAL and
cannot be claimed or started through the READ_ONLY path. The separate controlled
WRITE profile requires its own binding and exact approval; no general approval HTTP endpoint exists.

The supported local topology is a private Docker API container, isolated executor
network and separate DB network. The API container has **no published host port**.
Only API and executor join the executor network, an `--internal` bridge with
`com.docker.network.bridge.gateway_mode_ipv4=isolated`. The executor cannot reach
PostgreSQL or the Internet. A separate agent network can reach the API, never the
executor storage. The existing loopback server is not rebound or restarted.
Network-exposed deployments require HTTPS and protected routing; plain HTTP is
accepted by this runner only for the verified `http://foundry-api:3002` topology.

`scripts/run-isolated-executor.mjs` validates actual Docker inspection before start:
UID/GID 10001, read-only root, dropped capabilities, no-new-privileges, bounded
memory/CPU/PIDs, no host port, only two named mounts (read-only `/secrets`, writable
`/ledger`), volume-nocopy on each protected mount, prescribed entry point, one internal isolated network with only the
private API peer. Runtime independently checks Linux/container identity, effective
capabilities, no-new-privileges and the read-only root. There is no host fallback.
The agent must have its own UID/container and secret volume, without Docker/host
control, executor files, ledger or credential. The executor has no agent/DB/model
secret, Docker socket, host mount, inbound listener or arbitrary handler loader.
The READ_ONLY fixed handler performs no I/O; the controller alone uses ledger and HTTP.

Mode 1 trusts the developer/host administrator and container runtime. Inspection and
a declared digest are **not remote attestation**. A malicious host or executor can
lie. Docker daemon/root access defeats this separation. Do not give it to the agent.

## Startup and runtime sessions

The trusted administrator provisions named volumes and an explicit initialized
ledger, using `/app/initialize.mjs` with its identity on stdin. Never initialize a
replacement ledger for an unresolved deployment. Runtime refuses missing, corrupt,
symlinked or identity-mismatched storage. `/secrets/config.json` is provisioned by the
administrator, owned by UID10001, readable only there, and mounted read-only:

```json
{
  "apiOrigin": "http://foundry-api:3002",
  "deploymentId": "<deployment>",
  "bindingId": "<binding>",
  "ledgerId": "<UUID>",
  "artifactDigest": "<SHA-256 of installed health-ping.js>",
  "credential": "<executor-only Bearer secret>",
  "once": false
}
```

The identity contains deploymentId, bindingId, ledgerId and artifactDigest. Provision
it with the initializer in that order; the ledger compares the exact installation.
The v2 ledger also stores a random continuity nonce, whose digest is anchored once
in PostgreSQL. Existing unanchored legacy installations cannot silently initialize
a new baseline; follow the recovery runbook below.
A live deployment uses **one authoritative ledger volume**, never independent copies.
The compiled fixed artifact is checked before session registration and before each
physical start. Code is baked into the image and read-only; agent input cannot select
another module. The trusted host validates image/profile before launch.

POST `/api/v1/executor/sessions` requires executor:session plus all runtime scopes.
It pins exact principal/credential, deployment, binding, artifact, ledger, profile
and expiry, under credential/deployment/binding locks. Session bodies additionally
require `ledgerProofDigest`, the v2 ledger incarnation fingerprint. WRITE sessions
also supply the exact outputResource; READ_ONLY cannot attach an output resource. It is not a
credential or independent host attestation. A fresh process registers a
new session key, monotonically advances generation and durably supersedes the old
session. An identical key returns its old identity, never reactivates it. A session
is authenticated cooperative-process fencing, not an independently attested process.
A stale session cannot obtain another claim/start. Existing post-start evidence is
retained and the original session may still report its result with its valid exact
credential; result delivery is not new permission to execute.

Poll/claim/renew/release bodies now optionally include `sessionId`; legacy metadata
clients remain compatible. The fixed runner always includes it. A claim is pinned
to that session; lease operations cannot substitute or omit it.

## Atomic start and result API

| Endpoint | Scope | Meaning |
| --- | --- | --- |
| POST /api/v1/executor/sessions | executor:session | Register pinned installation and supersede old session |
| POST /api/v1/executor/claims/:id/authorize-start | executor:start | Atomically authorize the exact current fixed-handler start |
| GET /api/v1/executor/claims/:id/start | executor:report | Inspect committed identity / authoritative pre-start fence; never permission |
| POST /api/v1/executor/starts/:id/results | executor:report | Commit exact SUCCEEDED fixed-handler metadata or explicit UNKNOWN, then ACK |

Start body: `{ sessionId, generation, requestKey, artifactDigest, ledgerId }`.
The transaction locks run, sorted actor credentials/principals, Invocation, policy,
deployment/binding and session. WRITE additionally locks/rechecks the decision actor
and consumes its exact approval atomically. It rechecks original requester credential, current
executor, immutable arguments/snapshot, grant, applicable READ_ONLY or controlled approved WRITE policy, exact
fixed revision, current installation/session, latest ACTIVE claim/generation,
unexpired lease and absence of any previous possible start. DB time is sampled after
waits. It atomically creates one immutable ExecutorStart, writes the claim marker,
START_AUTHORIZED state and event. A deferred DB constraint prevents partial commit.
Unique Invocation/claim keys prevent two starts. Only the original response grants
permission; identical retries return the same identity with **startAllowed:false**.
Changed request identity conflicts. A claim ID alone is never a start permit.

Start deadline is at most five seconds, capped by lease/authorization/credential/
session expiry. The executor checks it immediately before the handler. Result
reconciliation deadline is 30 seconds. Revocation serialized before start blocks it;
revocation or session replacement after start commit cannot retract the already
returned permit or guarantee cancellation of the physical instruction.

Result body: `{ sessionId, generation, outcome, reason, result? }`, bound through the
start to the exact original executor principal/credential/claim. Only fixed bounded health or exact approved demo receipt metadata may be SUCCEEDED. UNKNOWN accepts a small enumerated reason set, never
invented failure/output. Result, state and audit event commit in one transaction;
ACK is emitted afterward. Identical reports return the same persisted ACK. Valid
conflicting evidence is rejected and audited. Late known success may reconcile
UNKNOWN; no handler is rerun. A revoked grant does not erase post-start evidence,
but revoked/expired credentials cannot submit it. Operator investigation can record
an unverified finding while preserving UNKNOWN; result import remains disabled. Public history exposes only safe start/report identity,
status/reason and the allowlisted health JSON, marked `EXECUTOR_REPORTED`.

## Reliability and operator reconciliation

POST `/api/v1/executor/recovery` requires executor:report, the current session and
matching ledgerProofDigest. It exposes bounded, owner/deployment/binding-scoped
claim/start/report identity pages (100 records, stable claim ID cursor). Another
binding's cursor is rejected. The runner checks every local record including ACKED
against this inventory before recovering/polling, capped at 10,000 records. A new
incarnation, missing committed start/report, wrong generation/session/artifact or
invalid ACK quarantines startup. Missing local evidence for a fenced pre-start claim
without any start may be handled by existing pre-start reconciliation. No local
execution evidence is reconstructed automatically.

`OperatorReconciliation` and `npm run reconcile` require OPERATOR identity and
explicit operator:reconcile scope. Inspection is read-only; explicit refresh may
record execution uncertainty. Findings use an idempotency key and current event
sequence, exact Invocation-scoped references, actor/credential/time and append-only
records/events committed together. Concurrent incompatible findings are rejected.
They always preserve UNKNOWN, never independently verify a result, consume approval
or authorize retry. No operator HTTP/result-import endpoint exists. See the
[recovery runbooks](../operations/executor-recovery.md) for commands, revocation,
backup/legacy deployment procedures and limitations.

## Durable ledger and crash behavior

SQLite uses WAL, `synchronous=FULL`, explicit transactions and integrity checks.
PREPARED records claim/session/generation/artifact/request identity; START_REQUESTED
is durable **before** sending start HTTP. START_INTENT (with committed start ID) is
durable **before** invoking the fixed handler. A partial unique index prevents a
second possible start for an Invocation. Result JSON remains RESULT_PENDING until
the exact committed ACK is stored as ACKED. Repeated delivery resends reports only.

| Boundary | Reconnect behavior |
| --- | --- |
| PREPARED, no start request sent | Fence old session, release/reconcile pre-start claim; safe later generation |
| START_REQUESTED, no response | Inspect persisted start after fencing old process; committed start means UNKNOWN, never execute |
| No server start and authoritative old claim/session fence | ABANDONED; pre-start reconciliation may offer a fresh generation |
| START_INTENT, before/during handler or after return before local result | UNKNOWN; actual execution cannot be reconstructed |
| Local RESULT_PENDING | Resend identical report; never call handler |
| DB result committed, ACK lost | Same report receives same ACK; no second event/start |
| Lease/session/result deadline lost after possible start | On-demand polling reconciliation records UNKNOWN; never READY |
| Missing/corrupt ledger, unavailable reconciliation or contradictory evidence | Refuse new work; preserve storage/evidence for investigation |

Deterministic tests cover seven interruption boundaries. HTTP/PostgreSQL tests
cover lost start/result responses; separate child-process tests use actual SIGKILL
after START_INTENT and after durable result persistence, then reopen SQLite and
reconcile without replay. Docker tests replace a completed container using the same
ledger. These are not power-loss or physical-storage failure tests.

A process reopens and reconciles **all** unfinished ledger rows before polling new
work. Failed start/result HTTP causes process exit; restart is explicit and reconciles
first. No automatic handler retry exists. UNKNOWN stays active and prevents closing
the ExternalRun until authoritative evidence resolves it. Polling reconciliation is
bounded/on-demand, not a background scanner. No automatic agent restart is provided.

Durability assumes intact single authoritative storage, working fsync/block storage,
PostgreSQL durability and honest host time (deadline checks). SQLite FULL/WAL cannot
atomically commit the remote effect with either database. Host/volume loss, restored
old backups and power/storage failure are not proved safe by process-crash tests.
A handler returning before local result commit remains ambiguous. **No exactly-once
external side-effect guarantee is made.**

## Build, isolated verification and deployment

```bash
npm run build:executor
docker build -f executor/Dockerfile --target executor -t agent-foundry-executor:11.2d .
docker build -f executor/Dockerfile --target private-api -t agent-foundry-private-api:11.2d .
node scripts/test-isolated-executor.mjs normal
node scripts/test-isolated-executor.mjs before-start
node scripts/test-isolated-executor.mjs start-loss
node scripts/test-isolated-executor.mjs ack-loss
node scripts/test-isolated-executor.mjs revoked-result
```

The opt-in script creates a new isolated PostgreSQL container, applies migrations
only there, provisions test-only identities/secrets/ledger and private networks,
exercises real HTTP/handler/replacement/fail-closed checks, then removes only its own
containers/networks/volumes. Fault adapters exist only under tests and are never
loaded by production entry points. It does not read the main DATABASE_URL or credentials.
The fixture helper is test bootstrap, not a public registration/provisioning API.

After trusted production/local provisioning, launch with:
`node scripts/run-isolated-executor.mjs <trusted-installation.json>`.
That host-side JSON contains only name, image, network, apiContainer, secretsVolume
and ledgerVolume. It contains no credential. Reusing an unresolved ledger requires
reconciliation, never reinitialization. API secrets are mounted separately at
`/api-secrets/database-url`; the private API refuses non-isolated host execution.
Do not publish its port. The Docker test script is the executable local topology
example; it creates ephemeral test data rather than installing a live deployment.

Deploy migrations through `20261112000000_external_write_approvals` explicitly before upgraded
API code (`npm run prisma:migrate`, with the intended database configured). No live
migration or restart is automatic. The regular loopback entry point defaults actual
start execution to disabled; `FOUNDRY_ISOLATED_EXECUTION_ENABLED=true` is an explicit
trusted opt-in **only with the verified isolated topology**. The private Docker API
entry point opts in after its Linux checks. Existing bindings without an execution
profile remain metadata-only. Issue all five explicit executor scopes, approve the
health revision/artifact/ledger binding, provision protected storage, validate Docker
profile and only then launch. Keep the reference worker/BullMQ entirely separate.
