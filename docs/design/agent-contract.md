# Agent Contract — external agent integration

## 1. Status and scope

**PROPOSED / NOT IMPLEMENTED — Phase 11.0 design.** API names, types, states and
storage changes below are implementation targets, not currently available features.
The [current execution pipeline](../architecture/execution-pipeline.md) remains
authoritative for implemented Repository Explorer behavior.

Phases 11.1a–11.1d implement identity, registry, external-run, blocked Invocation
admission and an authenticated loopback HTTP API, documented in the current pipeline.
Generic remote execution and approval below remain proposed. Deployment metadata does not
provision an executor or verify isolation. Capability decisions are preliminary and
cannot authorize execution until actual arguments/resources are independently bound.

Phase 11.2a implements only the narrow operator-attested resource-free eligibility
and reauthorization foundation described in [external authorization](../architecture/external-authorization.md).
READY can now represent that supported case. Phase 11.2b adds the implemented
[executor polling/claim/lease foundation](../architecture/executor-protocol.md).
Phase 11.2c implements a fixed health_ping isolated runner, atomic start, SQLite
ledger and durable result ACKs. Phase 11.2d implements continuity checks and
operator findings that retain uncertainty; result import remains deferred. Phase 11.3
implements one exact external approval and isolated demo WRITE path, documented in
[external approvals](../architecture/external-approvals.md). Generic handlers and
SDK below remain **PROPOSED / NOT IMPLEMENTED**; the narrower implemented routes
are documented in the architecture, not the illustrative target API below.

**Developer owns intelligence. Foundry owns execution.** Here, execution means
capabilities delegated through Foundry's enforced boundary, not everything an agent
can do on its host. Bring your own agent and tools without adopting Foundry's model
loop. The developer retains reasoning, planning, model selection, memory, context,
process lifecycle and recovery of internal reasoning state.

MVP: explicit registration, immutable versions and submitted manifests, static
operator grants, authenticated external runs, durable Invocations, outbound isolated
Remote Executors, invocation-bound human approvals and a reconciliation History API.
Initially allow only one active Invocation per external run. Provide an API and
TypeScript SDK; no separate microservice is required for each component.

Non-goals: hosted agents, microVM hosting, general orchestration, generic checkpoints,
automatic reasoning recovery, dynamic `CAPABILITY_REQUEST`, MCP, concurrent
Invocations within a run, a policy DSL, automatic write retries, rollback and
exactly-once side effects. Do not replace the working reference harness.

## 2. Architecture overview

The developer agent sends a delegated request to an authenticated API. A central
`InvocationService` validates ownership, manifest, arguments, grants and policy,
then commits the Invocation and any approval request. An eligible executor polls
Foundry, claims an assignment and obtains online start authorization before calling
its locally installed handler. It reports the outcome; the agent reconciles by ID
or history. PostgreSQL is authoritative throughout.

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Developer agent + agent SDK | Reasoning; stable request keys; request/status/history calls | Operator grants, approval decisions, privileged handler credentials |
| Foundry API + InvocationService | Authentication, authorization, lifecycle, audit, approval, assignment and start fencing | External model loop or an invented agent checkpoint |
| PostgreSQL | Durable identities, revisions, grants, requests, transitions and received evidence | Physical transaction with a remote side effect |
| Remote Executor + executor SDK | Authenticated outbound polling; durable local ledger; isolated handler dispatch; result redelivery | Deciding its own grants or approval requirements |
| Operator | Registration authority, deployment trust, capability grants, approval and reconciliation | Implicit proof that a submitted handler is harmless |

Use database-backed polling for MVP. Redis may later provide wake-ups but must not
become authoritative or carry executable handler code. The existing BullMQ queue
continues delivering `{ taskRunId }` only for the reference harness; remote
Invocations do not enter its Repository Explorer worker.

## 3. Trust and threat model

Trust the authorized operator and executor host administrator to provision and
maintain the declared isolation. Treat agent reasoning and agent-supplied arguments,
descriptions, schemas and risk labels as untrusted. Treat tool outputs as data, not
instructions or authorization. Assume authenticated TLS transport and functioning
durable PostgreSQL and executor storage; neither authentication nor a signed report
proves that the host honestly performed an action.

Separate operator, agent and executor credentials. Agent credentials cannot call
grant, approval, start or result-reporting endpoints. Executor credentials are bound
to a deployment and cannot create grants or impersonate agent requests. An agent may
submit a candidate manifest but cannot activate its own protected capabilities.

Sensitive handlers must run outside the agent's privilege boundary. Require separate
OS/container privileges as appropriate, agent-inaccessible secrets, protected handler
and dependency code, restricted filesystem mounts and network destinations, and no
agent access to the executor ledger, Docker socket or deployment control plane.
Separate processes sharing the same writable code, credentials and protected files
are insufficient. The SDK/CLI can check prerequisites and simplify provisioning;
it cannot establish isolation by importing a library. Deployment approval records
operator-attested isolation and artifact identity, not cryptographic attestation.

Out of guarantee: malicious host administrator/executor, compromised underlying OS,
agent actions using resources independently available outside Foundry, semantic
correctness of handlers and irreversible effects already started. READ_ONLY can
still disclose secrets, consume resources or call an incorrectly labelled handler.
Limit the resources available to the agent itself if bypass prevention is required.

## 4. Core domain concepts

All records carry an owner/tenant boundary, including a single-owner pilot. IDs are
references, never authorization. The server derives caller identity from credentials.

| Concept | Proposed durable meaning |
| --- | --- |
| Principal / Credential | Separate operator, agent and executor subjects; credential hash, scopes, expiry/revocation and subject binding. Never store plaintext bearer secrets in history. |
| Agent / AgentVersion | Stable owner-scoped identity; immutable external integration configuration and exact manifest bindings. Reusing a version identity with different content is rejected; a new version may change configuration. External versions need no provider, model, system prompt or Foundry maxSteps. |
| ToolManifest / tool revision | Immutable validated data: tool identity, bounded input/output schemas, handler ID, artifact digest, declared effects, resources and limits. No uploaded JS closures. Operator-reviewed classification is distinct from the submitted label. |
| ExecutorDeployment | Owner, environment, executor identity, installed manifest/tool revisions and artifact digests, resource mappings, isolation/trust tier and enabled/revoked state. Agent cannot modify handler installation. |
| CapabilityGrant | Mutable/revocable authorization binding agent/version, exact tool revision, deployment/environment, permitted resource constraints, reviewed profile, limits and policy revision. A manifest is not a grant. |
| External Run / TaskRun | Correlation container pinned to an external AgentVersion and owner, with task metadata and agent-reported completion. Not a tool lifecycle, model conversation or checkpoint. |
| Invocation | Stable ID/key, immutable canonical request and digest, run/agent/version/tool/deployment bindings, authorization snapshots, current state, assignment generation, timestamps, result evidence and uncertainty reason. |
| InvocationApproval | One decision bound to one Invocation and its exact authorization fingerprint; operator identity, decision time/expiry, decision and start consumption. No `resumeMessages` or runtimeStep. |
| Invocation event | Append-only transition/report with actor, provenance, server sequence and time. State and event commit together. |

Registration is hybrid: an operator or scoped registration credential explicitly
creates the Agent; an agent/SDK may submit immutable manifest candidates under it.
Foundry validates syntax, revision conflicts and deployment bindings; an operator
reviews classification and issues grants independently. New revisions never inherit
grants implicitly. Regranting creates a new grant identity; it does not reactivate
old denied, revoked or expired Invocations.

Proposed persistence adaptation: add an explicit REFERENCE/EXTERNAL integration
discriminator and separate external configuration from reference-only fields.
External runs do not require a Foundry-local workspace path. Do not put fake values
in required provider/model fields. Concrete schema/migration work belongs to 11.1.

An external run opens RUNNING without a reference worker lease. It remains open
while Invocations are pending or uncertain; an individual approval wait belongs to
the Invocation. An authenticated agent can request completion only with no active
or UNKNOWN Invocation. COMPLETED means the run was closed and delegated operations
are resolved, not independently verified task semantics. An operator may abandon
the run as FAILED, preserving UNKNOWN evidence; abandonment does not cancel effects.
Abandonment atomically revokes pre-start Invocations and fences their claims; any
start-authorized unresolved operation becomes UNKNOWN. Serialize closure against
start authorization using the same run lock. Closed runs accept history/result
reconciliation but no new Invocation or start, and late results do not reopen them.

## 5. Invocation lifecycle

These are proposed Invocation states, not additions to today's `ExecutionStatus`
by this document. Persist REQUESTED first, then evaluate policy in the acceptance
transaction; an external observer may first see its resulting state.

| State | Meaning |
| --- | --- |
| REQUESTED | Valid owned request recorded; authorization not yet resolved. |
| PENDING_APPROVAL | Authorized in principle, exact action awaits human decision. |
| READY | Currently authorized and approval, if needed, is durable; eligible for claim, not execution permission. |
| CLAIMED | Assigned to one deployment session/generation under a short lease; handler must not execute yet. |
| START_AUTHORIZED | Online reauthorization committed and approval consumed; execution may now have happened. Not proof the handler actually started. |
| RUNNING | Executor durably recorded start intent and reported handler start; this remains executor evidence. |
| SUCCEEDED | Authenticated executor reported contract success; verification is a separate evidence field. |
| FAILED | Conclusive reported failure with no ambiguous effect, e.g. validated pre-effect rejection. Not a generic timeout/exception bucket. |
| DENIED | Policy or human denied before start. |
| REVOKED | Applicable authorization/deployment was revoked before start authorization. |
| EXPIRED | Request/approval deadline expired before start authorization. |
| UNKNOWN | Execution might have occurred; no conclusive outcome. No automatic redispatch. |

| From | Trigger and required guard | To / atomic effect |
| --- | --- | --- |
| REQUESTED | Valid grant, profile and exact resource constraints | READY or PENDING_APPROVAL; append authorization decision |
| REQUESTED | Unknown tool, missing grant or policy denial | DENIED; record reason, no dispatch |
| PENDING_APPROVAL | Scoped operator approves exact unexpired fingerprint and grant remains valid | READY; persist decision and event |
| PENDING_APPROVAL | Human denies | DENIED; no executor action |
| READY | Matching authenticated deployment claims; no competing live assignment | CLAIMED; allocate generation/session and lease |
| CLAIMED | Lease expires, no start authorization was committed | READY; fence old generation before any reassignment |
| CLAIMED | Online start transaction revalidates all bindings, policy, approval, lease and open run | START_AUTHORIZED; consume approval and commit non-reassignable start boundary |
| START_AUTHORIZED | Matching executor reports durable local start | RUNNING; append reported start |
| START_AUTHORIZED / RUNNING | Authenticated conclusive result for current start identity | SUCCEEDED or FAILED; store result and provenance |
| READY / CLAIMED | Conclusive trusted pre-start rejection, with no start authorization committed | FAILED; preserve rejection evidence and fence assignment |
| START_AUTHORIZED / RUNNING | Start/result deadline or session loss without conclusive outcome | UNKNOWN; retain assignment/start identity |
| UNKNOWN | Authenticated late conclusive result or scoped operator reconciliation with evidence | SUCCEEDED or FAILED; preserve uncertainty history |
| REQUESTED / PENDING_APPROVAL / READY / CLAIMED | Grant, credential/deployment authorization revoked, or deadline expires | REVOKED or EXPIRED; invalidate unstarted assignment |

FAILED requires positive evidence of a known failed outcome/no effect under the
reviewed handler contract. A thrown exception after entry, partial write, timeout
or uncertain downstream response is UNKNOWN unless conclusive evidence resolves
it. A known partial outcome is recorded explicitly in evidence; do not call an
unresolved operation FAILED merely to release the run. No terminal status triggers
an automatic new write attempt.

SUCCEEDED, FAILED, DENIED, REVOKED and EXPIRED are scheduling-terminal. Repeated
identical reports are acknowledged without transitions; conflicting terminal
reports are rejected and audited, not last-write-wins. UNKNOWN is quiescent but
unresolved, may accept late reconciliation and **continues holding the active slot**.
An operator's abandonment closes the run without inventing an outcome. Contradictory
later evidence creates an audit discrepancy for manual review, not silent rewriting.

Invalid transitions include PENDING_APPROVAL -> RUNNING, DENIED -> READY, UNKNOWN
-> READY, any post-start reassignment and reuse of a consumed approval. Changes to
arguments/revision/deployment require a new request and, when applicable, approval.
If the pinned authorization fingerprint changes before start, fail closed as
REVOKED rather than silently substituting a new policy or approval.

Serialize request admission under the external run row: at most one Invocation in
REQUESTED, PENDING_APPROVAL, READY, CLAIMED, START_AUTHORIZED, RUNNING or UNKNOWN.
Use a database-enforced constraint/transaction, not SDK discipline. An identical
idempotent submission returns its existing Invocation before this admission check.
The schema uses independent Invocation IDs, allowing future concurrency without
coupling identity to run sequence.

## 6. Remote execution protocol

### Acceptance and idempotency

The caller persists a key before sending. Scope uniqueness to the tuple
`(owner, agent, run, idempotencyKey)`. The immutable fingerprint includes validated canonical arguments,
tool/manifest revision, deployment/environment and agent version; exclude generated
timestamps and server-derived current grant state. Do not alter arguments on retry.
Reject non-JSON/unknown fields and invalid schema input before acceptance.

Commit request, key/fingerprint, authorization snapshot, state and events atomically.
Return success only after commit. Same key and payload returns the same Invocation,
even after a lost response; same key with different payload returns 409. Invalid
authentication, ownership, syntax or oversized payload returns an error without
creating an Invocation. Valid owned but unauthorized requests produce an auditable
DENIED Invocation. A receipt is not execution success. Request-key idempotency
does not deduplicate business operations submitted under new keys.

### Poll, claim and exact start boundary

1. Executor authenticates outbound over TLS and polls/long-polls its deployment.
   An offer is not permission to execute. Claim uses a database compare-and-set;
   one current session/generation owns the unstarted assignment.
2. Before requesting start, executor commits a local durable PREPARED record keyed
   by Invocation ID with request digest, assignment generation and deployment.
   The ledger is outside agent-writable storage. Mismatched duplicate data stops
   execution and raises an audit error.
3. Executor flushes START_REQUESTED locally, then calls `authorizeStart`. Foundry
   transactionally locks/rechecks the Invocation and applicable grant/deployment
   revocation records, credential validity, lease generation, run openness, exact
   input/resource binding, limits, policy revision and unexpired approval. It
   commits START_AUTHORIZED and consumes approval together. Revocation operations
   take the same locks/check epochs, giving a database-ordered race outcome.
4. **That commit is the revocation/start linearization point.** A revocation
   committed first blocks start. One committed afterward cannot guarantee stopping
   the handler, even if its first physical instruction has not run. There is no
   atomic transaction between this authorization and the remote effect. Describe
   this as start authorization, never proof of physical start.
5. Only the original live attempt receiving a valid start response proceeds: it
   durably writes START_INTENT before invoking the pinned local handler and reports
   start. The opaque start permit is bound server-side to Invocation, input digest,
   agent/version, tool revision, grant/policy epoch, deployment, session and
   generation, with a short start deadline. It is not an offline authorization.
   SDK dispatch checks these bindings, deadline and ledger under an exclusive lock.
6. A repeated `authorizeStart` request returns committed status, **not a new
   executable permit**. Lost start response, process restart with START_REQUESTED
   or START_INTENT, expired start permit, or uncertain local state must not call the
   handler again. Reconcile Foundry state; if start was committed without a known
   result, retain UNKNOWN. This intentionally sacrifices availability even when
   no side effect actually happened. If Foundry proves start was never committed,
   an unstarted claim may expire and be offered with a new generation.

The executor must serialize duplicate deliveries locally and never run two handler
attempts for one Invocation. A deployment needs one authoritative durable ledger;
do not share a deployment across independent runners with separate ledgers. An
executor restart creates a new session; pre-start claims can be fenced, but started
operations are never reassigned. Ledger loss/corruption quarantines the deployment;
it is not an empty ledger permitting replay. Fencing protects Foundry state and
cooperating executors, not an already-running external system ignoring the token.

### Results, acknowledgement and reconciliation

After handler return, commit the result/report digest to the local ledger before
delivery. Report identity includes Invocation ID, start identity/generation and
deployment; server authenticates that binding, validates size/schema and commits
state plus event before ACK. A result may arrive before its start-report event;
the committed start authorization is still required. Caller timeout is not cancel.

Retry identical status/result delivery safely; acknowledge an identical persisted
report again, reject conflicting bodies, and never invoke a handler to regenerate
a missing result. Retain unacknowledged local reports across restarts. If Foundry
is unavailable after execution, keep the report and retry delivery only. An
oversized/invalid report does not establish failure; retain bounded error/digest
evidence and leave outcome UNKNOWN until an acceptable report/reconciliation.

Accept late evidence from the same start identity after a timeout, including after
run abandonment, without reopening execution or changing the original audit trail.
Credentials still must be valid: a revoked executor requires an operator-authorized
reconciliation credential/path, not an authentication bypass. Revocation does not
erase evidence. Independent verification, if available, records verifier identity,
method, evidence and time separately; MVP defaults to NOT_VERIFIED.

## 7. Security and execution policies

| Reviewed profile | Default after an exact capability grant |
| --- | --- |
| READ_ONLY | ALLOW within explicit resources and limits |
| WRITE | REQUIRE_APPROVAL |
| DESTRUCTIVE | REQUIRE_APPROVAL |
| EXTERNAL_WRITE | REQUIRE_APPROVAL |
| UNKNOWN / unreviewed | DENY |

No grant means DENY regardless of profile. Multiple applicable effect categories
use the most restrictive requirement; a read flag cannot downgrade a write.
Classification must be operator-reviewed against handler/deployment capabilities,
not accepted from an agent's label. MVP grants contain simple allowlisted resource
IDs, environment, permitted parameter ranges and fixed limits, not executable
policy expressions. Resolve resource aliases inside the trusted deployment, with
runtime path/network checks; names supplied by an agent are not proof of scope.

Bind approval to Invocation ID, canonical validated arguments/digest, agent/version,
tool/manifest revision, deployment/artifact, environment/resource scope, grant and
policy revision, limits and expiry. Show the exact bounded action to the human;
approve/deny must authenticate an authorized operator. Consumption occurs only at
the start transaction. Approval cannot transfer to another invocation, refresh a
revoked grant or authorize changed arguments. Resource contents may change after
approval; tool-specific preconditions are needed for snapshot-sensitive operations.

Enforce request/schema complexity, result, timeout, concurrency and rate limits at
the API/service and executor. Default deny network destinations and filesystem
resources not explicitly provisioned. Handler execution must not accept arbitrary
shell/code merely because the input schema is valid. Stop/timeout is best effort;
neither timeout nor local process termination proves downstream work stopped.

Keep handler secrets in the isolated executor's secret store/environment, referenced
by operator-controlled bindings, never model arguments/manifests/results/history.
Reject credential-bearing API fields; redact logs and limit payload access. Redaction
cannot detect every secret accidentally placed in arbitrary text: owners remain
responsible for submitted data. Encrypt sensitive stored payloads, define retention,
and preserve idempotency/audit tombstones when removing content. On unknown policy,
missing isolation approval, DB outage or stale authorization: do not start.

## 8. Public API / TypeScript SDK contract

**PROPOSED illustrative target API; routes in this table and the SDK do not exist.**
The narrower implemented `/api/v1/external` routes and actual scopes are documented
in the [current pipeline](../architecture/execution-pipeline.md#11-current-integration-versus-future-contract). Every proposed operation
authenticates, checks owner and resource scope, validates size and records relevant
decisions. Caller-supplied tenant IDs cannot override credential ownership.

| Operation | Principal / minimum scope | Proposed behavior |
| --- | --- | --- |
| POST /v1/agents; POST /v1/agents/:id/versions | Operator or separate registry credential | Register identity; immutable version with conflict checks |
| POST /v1/agents/:id/manifests | Scoped agent or operator: manifest:submit | Validate/store immutable candidate; no capability activation |
| POST /v1/executor-deployments | Operator: deployment:manage | Pin artifacts, environment, isolation and executor identity |
| POST /v1/grants; POST /v1/grants/:id/revoke | Operator: grants:manage | Static exact grants; revoke with serialized epoch update |
| POST /v1/runs; POST /v1/runs/:id/close | Agent: run:write for bound AgentVersion | Idempotent open/close external correlation container; reject premature completion |
| POST /v1/runs/:id/invocations | Agent: invocation:request | Idempotent acceptance returning current Invocation, not synchronous tool output |
| GET /v1/invocations/:id | Agent owner, operator or assigned executor with status scope | State, evidence provenance and bounded authorized payload |
| POST /v1/invocation-approvals/:id/decision | Operator: approval:decide | Durable exact decision; idempotent same decision, conflicting decision rejected |
| POST /v1/executors/poll; POST /v1/invocations/:id/claim | Executor: delivery:claim, bound deployment | Long-poll offers and lease/generation claim |
| POST /v1/invocations/:id/authorize-start | Assigned executor: execution:start | Online serialized final authorization; one executable response |
| POST /v1/invocations/:id/start-report; POST /v1/invocations/:id/result | Assigned executor: execution:report | Idempotent authenticated evidence and commit-before-ACK |
| GET /v1/runs/:id/history?after=cursor&limit=n | Scoped owner: history:read | Stable ordered events, reconciliation data and pagination |
| POST /v1/invocations/:id/reconcile; POST /v1/runs/:id/abandon | Operator: execution:reconcile | Evidence-based resolution or explicit abandonment, never retry permission |

SDK request returns an Invocation handle, including PENDING_APPROVAL or DENIED.
`wait` polls status; client deadline only stops waiting. No HTTP request is held
open for a human decision. The developer reconnects with the saved key/run ID and
continues its own reasoning. A generic provider adapter or Foundry model messages
are unnecessary.

**PROPOSED agent-side pseudocode — not executable SDK documentation:**

```typescript
const client = new FoundryAgentClient({ credential: agentCredential });
const run = await client.runs.open({ agentVersionId, clientRunKey });
// Persist clientRunKey and requestKey in developer-owned durable state first.
const invocation = await client.invocations.request(run.id, {
  idempotencyKey: requestKey,
  toolRevisionId: "notes.create@1",
  executorDeploymentId: "notes-dev",
  arguments: { resourceId: "demo-notes", name: "summary.md", content: summary },
});
const outcome = await client.invocations.wait(invocation.id, { timeoutMs: 30_000 });
// PENDING_APPROVAL / UNKNOWN / client timeout are not successful execution.
// Reconnect through get/history; do not submit a fresh key to retry an unknown write.
const history = await client.history.list(run.id, { after: savedCursor });
```

**PROPOSED executor-side pseudocode — trusted, separately provisioned environment:**

```typescript
const executor = new FoundryExecutor({
  credential: executorCredential, deploymentId: "notes-dev",
  ledger: durableAgentInaccessibleLedger,
  handlers: pinnedOperatorInstalledHandlers,
});
await executor.pollAndServe();
// SDK must implement claim -> durable PREPARED/START_REQUESTED -> online start
// -> durable START_INTENT -> single local dispatch -> durable result -> report/ACK.
// On restart: deliver saved reports; never rerun START_REQUESTED/START_INTENT.
// Handler credentials/resource mounts are absent from the agent environment.
```

History returns stable IDs, exact authorized inputs/results where permitted and
bounded, or durable payload references/digests, plus authorization, approval,
assignment, uncertainty and provenance. Summaries alone cannot reconcile an action.
No chain of thought or model prompt is required. Order events with a server-assigned
per-run cursor allocated under a database run lock, committing transition and event
together; executor timestamps are informational, not a global physical ordering.
Enforce ownership on pagination and payload fetches, not only the first request.

## 9. Execution guarantees and limitations

All rows describe proposed guarantees conditional on their assumptions.

| Guarantee | Enforcer | Trust assumption | Failure boundary / limitation |
| --- | --- | --- | --- |
| Only authorized delegated requests dispatch | InvocationService + transactional grant checks + isolated executor | All protected access goes through the boundary | Cannot control independent agent/host access |
| Exact human decision precedes sensitive start | Approval store and atomic start consumption | Authorized operator and immutable bindings | Approval is not effect idempotency or resource snapshot |
| Accepted requests/history survive Foundry restart | PostgreSQL commit-before-response, atomic events | Durable available DB/backups | DB outage blocks acceptance/start; no claim of zero infrastructure loss |
| Same request key does not create another Invocation | Unique scoped key + fingerprint | Caller preserves key | New keys may repeat the same business action |
| Duplicate delivery does not authorize another attempt | DB generation/start fencing + exclusive durable executor ledger | Cooperative executor, intact shared deployment ledger | No atomic commit with remote effect; no exactly-once guarantee |
| Revocation blocks unstarted authorization | Shared DB locks/epochs at authorizeStart | Online trusted executor obeys permit/deadline | Start-authorized work may proceed after revocation; cancellation best effort |
| Ambiguous work is not automatically replayed | UNKNOWN and non-reassignable post-start state | No bypass/manual blind retry | May strand work that never actually started |
| Received result has authenticated provenance | Scoped reporting + start binding + durable ACK | Honest trusted executor/host | Reported success is not independent verification |
| Agent can reconcile after reconnect | Ownership-scoped History API and retained IDs | Retained history and developer-saved correlation | Does not restore reasoning memory/checkpoints |

## 10. Failure and recovery matrix

| Failure boundary | Durable evidence / response | Recovery allowed |
| --- | --- | --- |
| Agent crashes before acceptance response | Key may already resolve to accepted Invocation | Re-submit same key/payload or query history; developer restores reasoning |
| Agent crashes while approval/execution pending | Invocation outlives client; no new action implied | Reconnect; no automatic agent restart or fresh key |
| Executor crashes before start request commits | CLAIMED may expire; no Foundry start authorization | Fence old generation; reassignment allowed only when DB proves no start commit |
| Start commit succeeds, response is lost / executor dies before handler | START_AUTHORIZED; ledger START_REQUESTED; actual non-execution unproven remotely | UNKNOWN after deadline; no automatic dispatch, even if this loses an execution |
| Executor crashes during/after effect before local result commit | START_INTENT / RUNNING; no conclusive result | UNKNOWN; investigate resource/downstream evidence, never regenerate result by execution |
| Result saved locally, network or Foundry fails | Local result ledger, server may remain RUNNING/UNKNOWN | Retry report only; authenticated late result may resolve UNKNOWN |
| Result commits, ACK lost | Server terminal outcome and local unacknowledged report | Identical report returns same ACK; no handler execution |
| Grant revoked before start boundary | Pre-start state becomes REVOKED or authorizeStart rejects | No execution; approved decision does not override revocation |
| Revocation after start boundary | Start authorization already committed | Record revocation, best-effort stop; eventual result or UNKNOWN, no cancellation promise |
| Pre-start lease expires / duplicate poll | Assignment generation fenced under DB transaction | Reclaim only pre-start; old token cannot start/report as new generation |
| Started execution heartbeat expires | Start identity remains non-reassignable | UNKNOWN, not READY; no automatic write retry |
| Foundry restarts / DB temporarily unavailable | Committed states/events remain; uncommitted transaction absent | Resume polling/status/report delivery; start forbidden without successful DB authorization |
| Executor ledger is missing/corrupt | Cannot prove whether its handler already ran | Quarantine deployment, reconcile externally; never initialize-and-replay |

Timeout detection uses persisted deadlines and database time, not an in-memory
worker list. An idempotent scanner may expire pre-start claims or mark post-start
uncertainty; it must use conditional state/generation updates. It never invokes
handlers or restarts the external agent. MVP applies this conservative rule even
to remote READ_ONLY tools; a submitted label is not proof that retry is safe.

## 11. Integration with existing Foundry

These links reference inspected existing code, not implemented BYOA APIs.

| Existing source and entry point | Reuse / adaptation boundary |
| --- | --- |
| [schema.prisma](../../prisma/schema.prisma): AgentVersion, Task, TaskRun, Approval, Step | Reuse identity/history concepts; adapt ownership, integration kind and external configuration. Current required model/workspace fields and message-bound Approval cannot represent the contract unchanged. |
| [execution-store.ts](../../src/persistence/execution-store.ts): AgentDefinition, LoadedExecution, ExecutionStore | Keep reference runtime contract; introduce a focused Invocation store/service alongside it, not external fake RuntimeResult/model objects. |
| [prisma-execution-store.ts](../../src/persistence/prisma-execution-store.ts): resolveAgentVersion, claimExecution, appendStep, claimApprovalAction | Reuse transactional conditional-update patterns, not signatures. Current version conflict checking only covers provider/model; external registration needs complete immutable fingerprint checks. Current consumedAt guards decision consumption, not remote execution certainty. |
| [tool-registry.ts](../../src/tools/tool-registry.ts): ToolRegistry.execute | Existing local registry validates and executes but does not enforce permissions itself. Never expose it as the public endpoint; InvocationService must enforce all delegated authorization before remote dispatch. |
| [agent-runtime.ts](../../src/runtime/agent-runtime.ts): run, resumeApproval | Keep reference reasoning, permissions and conversation resume working. External approval does not enter this loop or store its messages. |
| [task-run-processor.ts](../../src/workers/task-run-processor.ts): processTaskRun | Keep reference leases, traces and R3 verification. Its process-local Step counter cannot allocate multi-writer external history; use transactional server cursor allocation. |
| [worker.ts](../../src/worker.ts), [agent-task-queue.ts](../../src/queue/agent-task-queue.ts): main, BullTaskRunQueue | Reference worker instantiates concrete RepositoryTools/provider and consumes only taskRunId. Leave it intact; external dispatch uses Invocation claims/polling, not an AgentRuntime job. |
| [approval-service.ts](../../src/approvals/approval-service.ts): decideApprovalAndEnqueue | Reference decision resumes same runtime through queue. New InvocationApproval instead makes the exact Invocation READY; no taskRunId enqueue or conversation replay. |
| [docker-sandbox.ts](../../src/sandbox/docker-sandbox.ts): DockerSandbox.execute | Existing fixed local file-tool isolation is useful precedent, not a generic remote executor or proof of developer-host isolation. Do not silently expand its trusted surface. |
| [task-postconditions.ts](../../src/verification/task-postconditions.ts): TaskPostconditionVerifier.verify | Local file evidence/workspace checks stay reference-specific. Remote executor success is NOT_VERIFIED absent a separately defined trusted verifier. |
| [recover-stale-runs.ts](../../src/recovery/recover-stale-runs.ts): recoverStaleRuns, isReadOnlyRepositoryRun | Preserve strict named read-only Explorer eligibility; explicitly exclude external runs from reference scanning/claims. Remote UNKNOWN is not whole-run recovery. |
| [server.ts](../../src/dashboard/server.ts): createDashboardServer; [prisma-run-reader.ts](../../src/observability/prisma-run-reader.ts): PrismaRunReader; [run-query.ts](../../src/observability/run-query.ts): RunQueryService | Current dashboard header/origin checks are not public identity; readers lack tenant scoping and project summaries. Add authenticated, scoped external API/read models, not public exposure of these endpoints/raw Steps. |

Keep R1/R2 context limits and R3's one durable correction unchanged for the reference
harness. External agent context/reasoning remains developer-owned; API payload
limits are not context budgeting. New external state must not accidentally satisfy
reference worker or recovery selectors. Database/queue non-atomicity remains a
documented reference limitation; DB-backed remote polling does not fix it globally.

The current architecture map correctly says BYOA is not implemented. Its section 11
still directs creation of this design when undertaken; that historical navigation
can be updated separately. No implementation/documentation guarantee is upgraded
merely by adding this proposal.

## 12. Phase 11 implementation roadmap

### 11.1 — Authenticated registry, durable Invocations, static grants and history

First vertical slice: principal/credential ownership and scopes, explicit external
integration records, immutable registrations/manifests, static reviewed grants,
idempotent open-run/request/status/history and atomic single-active admission.
Implement InvocationService and its store, not a new model provider. No live handler
dispatch yet; unsupported start/approval-required execution remains blocked and
clearly visible. Keep external records excluded from reference workers/recovery.

Acceptance tests: wrong owner/scope/revoked credential denied; full immutable version
conflicts rejected; manifest submission cannot self-grant; same key/same payload
deduplicates, changed payload conflicts; concurrent different keys admit only one
active Invocation; events and state commit together; restart/history and bounded
payload access preserve ownership. Reference suite remains passing.

### 11.2 — Outbound isolated executor with safe dispatch

Add deployment provisioning/attestation, authenticated polling, pre-start claims,
serialized revocation/start, fenced generations, durable ledger and result ACKs.
Initially dispatch only operator-reviewed READ_ONLY tools with restricted resources;
approval-required capabilities stay blocked until 11.3. Implement deadline scanning
and UNKNOWN reconciliation, not automatic re-execution.

Acceptance tests: start/revocation race, expired claims, duplicate deliveries,
concurrent local dispatch, lost start response, process crash at each ledger boundary,
late result and lost result ACK. Demonstrate protected credentials/code/resources
are inaccessible to the agent in the chosen deployment, and label residual trust.

### 11.3 — Invocation approvals and working write E2E

Add authenticated invocation-specific approval presentation/decisions and atomic
consumption bound to all authorization inputs. Exercise a harmless isolated write:
request -> approval -> claim/start -> executor report -> history/reconciliation.
Do not claim independent verification unless a separate verifier actually checks it.

Acceptance tests: human deny never dispatches; changed arguments/policy/deployment
invalidate approval; approval cannot be consumed twice or transferred; unknown write
never retries; each new sensitive Invocation requires its own approval. Real E2E
needs explicit human approval and persisted evidence. Only then is the full MVP
implemented; earlier slices must not advertise working write delegation.

Later, separately scoped: dynamic capability requests, MCP adapters, richer policies,
multiple active Invocations and hosting. None changes current MVP safety implicitly.

## 13. Open implementation details and recommended defaults

The architecture above is selected; these are bounded implementation choices.

| Detail | Recommended starting point / validation needed |
| --- | --- |
| Credential mechanism | Opaque high-entropy scoped bearer credentials over TLS, hash at rest, operator-controlled rotation; choose an established hash/constant-time verification implementation. No public exposure until auth/ownership tests pass. |
| Canonical fingerprint | Deterministic JSON object-key ordering, array-order preservation, UTF-8 and defined JSON number/string handling; cryptographic digest. Freeze algorithm version and test SDK/server vectors before interoperability. |
| Schema subset | Small documented JSON Schema subset with bounded depth/property count; reject unsupported keywords rather than pretending full validation. Finalize exact subset before manifest acceptance. |
| Payload defaults | Start with 64 KiB request, 256 KiB inline result, 100 events/page and 10 MiB run payload quota; configurable enforced ceilings, not current settings. Return size errors without rerunning effects. Durable artifact references can be added if needed. |
| Time defaults | 20 s long-poll, 30 s claim lease, 5 s start-permit deadline, operator-bounded handler timeout and 15 min approval expiry; use DB time for decisions. Tune using deployment tests; expiry after start means uncertainty, not replay. |
| Durable ledger | SQLite with transactional writes/flush and exclusive dispatch locking on deployment-owned persistent storage. Test crash durability on supported filesystems; never use an agent-writable temporary directory. |
| Retention | Pilot default 30 days for bounded inputs/results, retain request-key fingerprints and audit tombstones while retries are supported; do not purge UNKNOWN or unacknowledged evidence automatically. State retry horizon explicitly before deletion policy ships. |
| Storage shape | Prefer focused external configuration/Invocation tables plus explicit integration discriminator; select exact Prisma relations/indexes in 11.1. Preserve old records, enforce immutable fingerprints and owner-filtered foreign references. |

Residual risks: an honest but buggy handler can misclassify effects; a compromised
trusted executor can lie; approved mutable resources can change; new request keys
can intentionally duplicate business actions; and start authorization without result
can strand an Invocation indefinitely. These require operational reconciliation or
future tool-specific idempotency/verification, not broader safety claims. The first
implementation task should freeze authenticated registration and durable request
acceptance invariants with deterministic tests before adding remote dispatch.
