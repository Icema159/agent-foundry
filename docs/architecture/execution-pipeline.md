# Current execution architecture

Scope: implemented Repository Explorer pipeline, including R1–R3. This is a
component/decision map, not a replacement for [README setup and usage](../../README.md).
Source code is authoritative; future designs are **PROPOSED / NOT IMPLEMENTED**.

## 1. High-level flow

```text
npm run agent -- [postcondition flags] "task"
  -> CLI parses input and resolves Agent / concrete AgentVersion
  -> PostgreSQL: create Task + PENDING TaskRun
  -> BullMQ/Redis: deliver { taskRunId }
  -> worker loads execution from PostgreSQL and claims RUNNING ownership
  -> heartbeat + AgentRuntime (original instructions/task or approval context)
       -> ContextBudgetGuard -> ModelProvider -> model response
            tool call -> registry validation -> permission policy
              ALLOW -> executor -> ToolResultLimiter -> conversation -> next call
              REQUIRE_APPROVAL -> persist exact action + conversation
                -> WAITING_FOR_APPROVAL; release lease; stop heartbeat
                -> human APPROVED / DENIED -> PENDING + enqueue same taskRunId
                -> worker claims -> consume decision -> resume conversation
              DENY / runtime error -> structured failure
            final answer -> requested postconditions checked
              pass (or no conditions) -> COMPLETED
              unmet + safe + unused correction + steps remain
                -> persist correction marker -> append feedback -> next call
              otherwise -> FAILED
  -> PostgreSQL: ordered Steps, terminal result, Task + TaskRun status

Separate recovery command:
  stale RUNNING -> eligibility/limit check -> PENDING + enqueue same taskRunId
    -> whole-run restart, NOT step-level or conversation resume
  unsafe / recovery limit exceeded -> FAILED
```

## 2. Submission, identity and durable records

[`src/cli.ts`](../../src/cli.ts) receives CLI arguments; npm compiles it and runs
the JavaScript entry point. [`parseTaskInput`](../../src/cli/task-input.ts)
extracts explicit `--expect-created-file` / `--expect-deleted-file` conditions.
The CLI selects the workspace, provider/model and version and constructs the
Repository Explorer definition; it does not run the model.

[`submitTask`](../../src/queue/task-submission.ts) resolves identity, creates
records, then enqueues. [`PrismaExecutionStore`](../../src/persistence/prisma-execution-store.ts)
implements the database operations behind the
[`ExecutionStore` contract](../../src/persistence/execution-store.ts).
[`prisma/schema.prisma`](../../prisma/schema.prisma) defines:

- `Agent`: named agent identity; `AgentVersion`: persisted instructions,
  provider/model, maxSteps and tool policies. A run references a concrete version.
- `Task`: prompt, workspace and requested postconditions; `TaskRun`: execution
  status, ownership/heartbeat, recovery count, final answer and failure fields.
- `Step`: uniquely ordered `(taskRunId, sequence)` history; `Approval`: exact
  arguments, conversation, runtimeStep, decision and consumption marker.

Task and initial PENDING TaskRun creation share a database transaction. Existing
AgentVersions are reused without updating their configuration; only a conflicting
provider/model is explicitly rejected. Other supplied version fields are not
compared. Use a new version for changed instructions/policies; do not assume
complete configuration-conflict validation exists.

[`BullTaskRunQueue`](../../src/queue/agent-task-queue.ts) sends only `{ taskRunId }`
to `agent-task-execution`, with job `attempts: 1`. Redis is transport so workers
reload authoritative state rather than trusting duplicated queue configuration.
Database writes and enqueue are **not atomic**: an enqueue failure can leave a
PENDING run. There is no transactional outbox or automatic pending-run repair.

## 3. Worker, lease and runtime ownership

[`src/worker.ts`](../../src/worker.ts) creates the queue worker, provider factory,
repository tools and sandbox. Its configured concurrency is 1 and
`maxStalledCount` is 0; Foundry, not hidden queue retries, owns recovery policy.

[`processTaskRun`](../../src/workers/task-run-processor.ts) loads the PENDING run,
claims it RUNNING with a worker UUID, builds the runtime, then starts
`ExecutionHeartbeat`. Claim, heartbeat, Step writes, approval consumption and
terminal writes use database ownership checks. Step sequencing continues from
the latest persisted sequence. Heartbeat remains active during execution and
verification, and stops before suspension/terminal persistence.

This fences database mutations, not arbitrary external side effects. Heartbeat
errors are retained and surfaced by `stop()`; they do not immediately interrupt
an in-flight model/tool call. Exceptions outside normalized runtime failures
(including runtime construction, persistence or heartbeat errors) can leave a
run RUNNING for later inspection/recovery. Do not claim every thrown error
automatically becomes a persisted FAILED result.

## 4. Model/tool loop and capability boundary

[`AgentRuntime.run`](../../src/runtime/agent-runtime.ts) starts with system
instructions and the user task, or clones approval resume messages. Each model
iteration consumes the existing maxSteps budget (CLI definitions currently use
8). Tool responses preserve matching assistant/tool message structure and call
IDs. The original task is not dropped when tools run.

[`ModelProvider`](../../src/model/types.ts) is the normalized model contract;
[`ModelProviderFactory`](../../src/model/model-provider-factory.ts) chooses
[`OllamaProvider`](../../src/model/ollama-provider.ts) or
[`OpenAIProvider`](../../src/model/openai-provider.ts) using persisted identity.
Adapters translate requests and normalize one tool call or a final answer,
usage and provider errors. Credentials stay environment-only. No automatic
provider routing/fallback exists.

[`ToolRegistry`](../../src/tools/tool-registry.ts) owns schemas, validators,
executors and read-only metadata. For Foundry-managed calls the runtime checks
existence, validates arguments and enforces the AgentVersion policy; unspecified
tools default to DENY. Schema exposure excludes denied tools but is not itself
the authorization boundary. Calling `ToolRegistry.execute` directly does not
enforce AgentVersion permissions: application execution must use the runtime.

[`RepositoryTools`](../../src/tools/repository-tools.ts) supplies `list_files`,
`search_files`, `read_file`, `create_file` and `delete_file`. Reads run in the host
Node process with workspace/path checks; only writes use the sandbox. The three
read operations are explicitly read-only. Unknown metadata is conservative,
not an assumption of safety. The current CLI allows reads and requires approval
for creation/deletion; reasoning instructions live separately in
[`repository-explorer.ts`](../../src/agents/repository-explorer.ts).

## 5. Approval suspension is not recovery

For REQUIRE_APPROVAL, the runtime returns the validated proposal and messages
ending in its assistant tool call, without executing it.
`waitForApproval` transactionally creates Approval + APPROVAL_REQUIRED Step,
changes Task/TaskRun to WAITING_FOR_APPROVAL and clears ownership/heartbeat.
No worker remains blocked waiting for a person.

[`decideApprovalAndEnqueue`](../../src/approvals/approval-service.ts), called by
[`approval-cli.ts`](../../src/approval-cli.ts) or the dashboard, records APPROVED
or DENIED, returns the same run to PENDING, then enqueues its ID. This is another
non-atomic DB/queue boundary. The next worker loads the unconsumed decision and
`claimApprovalAction` marks it consumed under the current lease **before** action
execution. APPROVED executes the stored exact arguments once through this
consumption path; DENIED executes nothing and appends TOOL_APPROVAL_DENIED.

Conversation continues at `runtimeStep + 1`, without replaying earlier calls or
resetting maxSteps. Crash windows between decision consumption, filesystem effect
and result persistence remain: consumption is not an exactly-once guarantee.

## 6. Sandbox and side effects

[`DockerSandbox.execute`](../../src/sandbox/docker-sandbox.ts) runs the fixed
[`tool-runner`](../../src/sandbox/tool-runner.ts), not arbitrary model-generated
shell. The [`image`](../../sandbox/Dockerfile) uses a non-root user; invocations
disable network, drop capabilities, set no-new-privileges and read-only container
root, and impose timeout/resource limits. The workspace bind mount is writable.

Host checks and runner checks restrict targets to the workspace. Creation uses
exclusive `wx` (no overwrite); deletion accepts one regular non-symlink file,
not a directory or recursive operation. The writable mount deliberately changes
the real workspace: it is not a disposable copy or a general secure BYOA sandbox.
Approval authorizes arguments, not a frozen filesystem snapshot. Filesystem
mutation and PostgreSQL result persistence are not one transaction.

## 7. Context protection (R1/R2)

R1 resolves `FOUNDRY_OLLAMA_NUM_CTX` once per OllamaProvider (default 16384,
positive safe decimal integer). That same `contextWindowTokens` is sent on every
`/api/chat` request as `options.num_ctx` and supplied to the guard; no duplicate
context-window configuration is maintained in the runtime.

R2 configuration is read once per runtime by
[`context-protection-config.ts`](../../src/runtime/context-protection-config.ts):
tool-result limit 8000 UTF-8 JSON bytes (minimum 512), output reserve 2048 tokens,
safety margin 1024 tokens. Corresponding variables and usage are in README.
Configuration is process-local, not pinned in AgentVersion; a new worker/runtime
after approval can use changed environment settings.

[`ToolResultLimiter`](../../src/runtime/tool-result-limiter.ts) centrally limits
model-visible results, including approved resumes. Small results are unchanged;
oversized reads yield structured TOOL_RESULT_TOO_LARGE feedback requesting a
smaller portion, not silently truncated content. `read_file` supports optional
1-based `startLine` / `maxLines`, but still reads the file into memory first.
Oversized write/unknown-tool output yields TOOL_RESULT_OUTPUT_OMITTED, not an
execution failure or instruction to retry. Actual results remain durable evidence
with size-only `outputLimit` diagnostics; storage size/redaction is not addressed.

[`ContextBudgetGuard`](../../src/runtime/context-budget-guard.ts) runs before
every model call, including correction and approval continuation. Input budget
is `max(0, contextWindow - output reserve - safety margin)`. Estimate = UTF-8 bytes
of the entire normalized JSON request + 512 + 96/message + 64/tool, including
instructions, task, history and schemas. Exceeding it returns
CONTEXT_BUDGET_EXCEEDED before provider invocation; no messages are silently
removed/summarized. It is conservative, not an exact tokenizer or hard guarantee.
OpenAI exposes no limit and skips this guard; result limiting still applies.
Reserves do not impose an output-generation token cap.

## 8. Verification and one bounded correction (R3)

The processor supplies a `FinalAnswerVerifier` callback to the same runtime.
[`TaskPostconditionVerifier.verify`](../../src/verification/task-postconditions.ts)
checks explicit file_created/file_deleted conditions: successful tool evidence
for the normalized path **and** a safely verified regular file/absence. It does
not check arbitrary semantic correctness or file content equality. Evidence is
reloaded across approval segments and currently searched across the TaskRun.

A FINAL_ANSWER Step may be an unverified candidate. With conditions, the runtime
emits `completed` only after verification passes; without conditions, normal final
answer behavior remains. A failed check can continue only if:

- no correction was already used and maxSteps still has room;
- there was no denied approval and all returned results prove read-only execution;
- all recorded calls have matching results, and verification itself did not throw.

Unknown/legacy result metadata and returned write results fail closed, even if a
write did not explicitly claim success. Before continuing, the processor commits
a lease-protected POSTCONDITION_CHECK with `correctionAttempt: 1` and
`correctionOutcome: STARTED`. This Step is the durable allowance, reloaded from
the whole history; no separate counter column/migration is needed.

The runtime appends the candidate assistant answer and structured
POSTCONDITION_UNMET user feedback (conditions/evidence, not a prescribed tool).
It continues the **same** loop, task and budget. Any sensitive call obtains a new
approval through section 5, whose stored conversation includes correction feedback.
Resume does not grant another correction. The next final answer is verified:
SUCCEEDED or FAILED is recorded; an unmet final check retains
TASK_POSTCONDITION_FAILED. Other runtime failures retain their own codes and
record failed correction without claiming verification was reached.

## 9. Terminal state, history and observability

`processTaskRun` maps runtime traces to MODEL_CALL, TOOL_CALL, TOOL_RESULT,
FINAL_ANSWER and RUNTIME_FAILURE Steps; it also writes POSTCONDITION_CHECK.
Model-call completion updates duration/provider/usage on its existing Step.
Approval Steps are written by persistence transactions. `started`, `step` and
`completed` runtime notifications are not separate persisted Step kinds.

`finishExecution` transactionally sets Task/TaskRun COMPLETED or FAILED, saves
the answer/failure and completion time, and clears ownership. WAITING_FOR_APPROVAL
is a nonterminal suspension, not success. BullMQ job success is not equivalent to
TaskRun success: the job may return a runtime `failed` or waiting status.

[`PrismaRunReader`](../../src/observability/prisma-run-reader.ts) and
[`RunQueryService`](../../src/observability/run-query.ts) reconstruct run details
for [`run-cli.ts`](../../src/run-cli.ts) and
[`dashboard.ts`](../../src/dashboard.ts). The
[`dashboard server`](../../src/dashboard/server.ts) exposes runs, details and
approval decisions. Summaries omit large payloads. R2 context-budget failures expose
available persisted numeric fields through optional `timeline.contextBudget`;
oversized read results expose `TOOL_RESULT_TOO_LARGE` and optional byte counts
through `timeline.toolResultLimit`, alongside the tool name. Missing/invalid
metrics are omitted, not defaulted. These diagnostic projections never include
raw prompts or tool content. Raw Steps still contain more data. The dashboard
shows these diagnostics, provides exact-text Final Answer clipboard copying, and
keeps desktop navigation visible with independently scrolling content. R3 outcomes
are visible in postcondition messages. [`EvalRunner`](../../src/evals/runner.ts)
submits ordinary runs and scores persisted outcomes; eval timeout does not cancel
the underlying run.

## 10. Whole-run recovery and current limitations

[`recover.ts`](../../src/recover.ts) invokes
[`recoverStaleRuns`](../../src/recovery/recover-stale-runs.ts) using database
heartbeats (defaults: 30s lease timeout, 2 recoveries). It is an explicit command,
not a periodic service automatically started by the worker. Only stale RUNNING
runs are scanned, never approval waits or completed runs. Eligible runs increment
recoveryCount, retain history, return to PENDING and are enqueued for a fresh
conversation. This is neither step-level resume nor R3 correction.

`isReadOnlyRepositoryRun` is capability-based and strictly read-only: only the
named Repository Explorer with ALLOW for `list_files`, `search_files` and
`read_file`, plus any DENY policies, qualifies. `create_file` and `delete_file`
with ALLOW or REQUIRE_APPROVAL, and unknown executable capabilities, are
ineligible even if never used. The former approval-gated creation exception is
removed; current write-capable default Explorer versions do not qualify. A custom
`canRecover` callback may veto recovery, never broaden this allowlist.

For a stale, ineligible run, `failStaleExecution` rechecks RUNNING and heartbeat
inside a transaction. Its conditional update also matches the observed worker
ID, heartbeat and recovery count. If another worker/state transition or heartbeat
wins, no failure or Step is written and the scanner reports `skipped`. The
eligible requeue and recovery-limit paths use the same observed-lease fencing.
On confirmed unsafe abandonment, Task and TaskRun become FAILED with
`RECOVERY_NOT_SAFE`, ownership/heartbeat are cleared, and an ordered
RUNTIME_FAILURE Step preserves the former worker ID and a diagnostic visible
through existing run details. Previous Steps and approvals are retained, and
recoveryCount is not incremented. No agent/tool execution is restarted.

FAILED describes abandoned orchestration, not the outcome of prior side effects.
It neither rolls back filesystem changes nor cancels an in-flight sandbox/model
operation. In particular, a consumed approval without TOOL_RESULT remains
ambiguous; it is not evidence that the action failed or permission to repeat it.
Approval suspension/resume (section 5) is unchanged: WAITING_FOR_APPROVAL and
PENDING runs are not stale-scan candidates, approved unconsumed actions resume
normally, consumed approvals stay unavailable, and new sensitive calls still
require their own approval. R3 correction is separate and unchanged.

Database transitions and enqueue remain non-atomic. If recovery delivery throws,
the error propagates to the recovery caller without overwriting PENDING or a
newly claimed execution. If no job was delivered, a PENDING run may require manual
delivery reconciliation; this phase does not add an outbox or delivery retry.

The system has no exactly-once side-effect guarantee, generic write idempotency,
step checkpoints, transactional enqueue, automatic provider fallback, model-call
cancellation on lease loss, production multi-tenant security or general external
agent/tool registration. These are limitations, not permission to implement them
incidentally. Preserve existing restrictions and scope future changes explicitly.

## 11. Current integration versus future contract

Today CLI and worker know Repository Explorer and its concrete tools. The model
chooses reasoning/tool requests; Foundry owns delivery, state, managed execution,
authorization, isolation, verification and observability. Provider-agnostic model
calls do not make the whole platform agent-agnostic.

Phases 11.1a–11.1d add local identity/registry, external-run and authenticated HTTP
control-plane foundations; external tool execution and general BYOA remain **NOT IMPLEMENTED**.
[`agent-contract.md`](../design/agent-contract.md) documents the proposed design.

[`identity.ts`](../../src/identity/identity.ts) defines operator, agent and executor
principals, scoped opaque random credentials (SHA-256 verifier only), expiry and
revocation. Trusted in-process administration/issuance is a bootstrap boundary,
not a public or authenticated API. No credentials or operators are auto-created.
`CredentialAuthenticator` derives immutable contexts from stored credentials;
registry operations call `authorize` to recheck current credential state, scopes
and principal binding. `requireScope` / `requireOwner` alone check only the
snapshot. Revocation is not transactionally serialized with an already in-flight
registry operation. Never trust context fields from a client request.

[`AgentRegistry`](../../src/identity/agent-registry.ts) derives owner from context,
permits operators to register EXTERNAL identities and restricts agent reads to its
bound external agent. Executors have no registry permission. The initial migration
assigns all pre-existing agents to `foundry-local-owner` as REFERENCE without
changing IDs or run relationships. Names remain globally unique for compatibility:
the same name cannot be registered by another owner, but lookup is owner-scoped.
`repository-explorer` is reserved for the existing local harness. Reference CLI
resolution is constrained to the local owner and REFERENCE type.

Executor `deploymentId` is currently an opaque trusted-administrator-supplied
binding, not evidence that a deployment exists, belongs to an owner, or is isolated.
External runs are stored separately from reference TaskRun records. Reference
load/claim/heartbeat additionally reject `ext_` IDs; stale recovery queries only
reference TaskRun records. No external worker heartbeat is required.
Existing dashboard endpoints remain local-only and unauthenticated.

Phase 11.1b adds [`ExternalRegistry`](../../src/registry/external-registry.ts),
separate external versions, manifests/tool revisions, inert deployment metadata and
operator-managed grants. External versions do not require reference model fields.
Publishing the same identity/content is idempotent; conflicting content is rejected.
Canonical fingerprints use sorted JSON object keys, preserve array order and use
SHA-256. Version config is limited to 64 KiB and JSON nesting depth 8. Tool revisions
are scoped to their immutable manifest, and grants bind the exact tool record ID.
Manifest publication and sealing occur transactionally; database triggers reject
updates/deletes and prevent inserting tools after sealing. Privileged DB clients are
trusted and could directly insert a malformed sealed manifest; use the service.

[`validation.ts`](../../src/registry/validation.ts) accepts 1–32 unique named tools,
positive revisions and the four declared effect categories. Its bounded input-schema
subset permits `type`, `description`, object `properties`, `required`,
`additionalProperties: false`, and array `items`; unsupported keywords are rejected.
The schema root must be an object, schema nesting is limited to 6 and each object to
64 properties. This validates the declaration, not future invocation arguments.
The agent-provided profile is untrusted: a separately scoped operator supplies the
reviewed profile and explicit non-wildcard resource IDs. A declared write cannot be
downgraded to READ_ONLY. Only one active grant per owner/version/tool/deployment is
permitted; revocation does not change published version/manifest records. New operator
scopes are `version:publish`, `manifest:publish`, `deployment:manage`, `grant:manage`
and `capability:check`; bound agent credentials may have the two publish scopes and
`capability:check`. Existing credentials do not acquire new scopes automatically.

`decide` returns DENY, ALLOW or REQUIRE_APPROVAL **with executionAllowed=false in all
cases**. It is preliminary authorization data: the requested resource is caller
provided and has not been derived from validated arguments. Future InvocationService
must validate arguments, independently bind resources, enforce current authorization
and approval, and serialize revocation against start before any dispatch. Grant and
credential revocation are not serialized against an in-flight 11.1b service operation.
Deployment metadata does not establish executor existence, artifact provenance or
isolation. No public API, external approvals, reference TaskRuns or tool dispatch were added.

Phase 11.1c adds [`InvocationService`](../../src/invocation/invocation-service.ts),
`ExternalRun`, `Invocation` and append-only `InvocationEvent`. External runs are
bound to an authenticated AGENT, owner and external version, without reference
model/workspace fields. Credentials require explicit `run:manage` or
`invocation:request` scopes; existing credentials do not inherit new scopes.

Admission validates bounded JSON arguments against the published schema subset and
rejects obvious credential fields/tokens. This is not a general secret detector;
arguments can contain other sensitive data and are stored in the Invocation. Events
contain status/reason and principal ID, not argument payloads. The idempotency key is
unique per owner/run and fingerprinted with tool, deployment, requested grant and
canonical arguments; the run pins agent/version. A same-key replay returns its
original receipt before closure/grant/single-active checks, after fresh identity
verification; changed payload conflicts. PostgreSQL run row locks serialize
admission, cancellation and closure. A partial unique index enforces one active
invocation across REQUESTED, READY, PENDING_APPROVAL, CLAIMED, START_AUTHORIZED,
RUNNING and UNKNOWN. Events and state commit together; a DB sequence orders events
within a locked run, with gaps possible.

No matching active grant yields a durable DENIED receipt. A candidate grant yields
REQUESTED with `RESOURCE_BINDING_UNVERIFIED`, never READY: no caller-provided resource
establishes execution permission. An agent may cancel only this blocked REQUESTED
state to REVOKED and close a run only with no active/UNKNOWN invocation. No service
transitions to approval, claim, start, success, failure or UNKNOWN are enabled; the
enum reserves future states. UNKNOWN stays active and cannot be cancelled or retried.
Run COMPLETED means only that the developer closed orchestration with no unresolved
invocation; it does not assert that denied actions or the task itself succeeded.
No queue or executor is added. Credential/grant revocation is not
serialized with an in-flight admission. A future start boundary must transactionally
reauthorize and independently bind validated arguments to protected resources.

Phase 11.1d adds [`external-api/server.ts`](../../src/external-api/server.ts), a
separate versioned HTTP adapter around InvocationService. The entry point
[`external-api.ts`](../../src/external-api.ts) listens only on `127.0.0.1` (default
port 3002); network exposure requires TLS termination and protected proxy routing.
Never expose the unrelated unauthenticated dashboard as the external API.

Each request authenticates a Bearer credential anew, requires an AGENT principal
and appropriate `run:manage` or `invocation:request` scope; services recheck
current credentials and scope resources by owner plus bound agent. Malformed,
expired and revoked credentials get 401, wrong role/scope 403, inaccessible or
missing resources 404, validation errors 400, lifecycle conflicts 409, oversized
bodies 413 and unsupported content types 415. Responses use `{ error: { code,
message } }` and never expose database errors or stack traces. Submission returns
the same safe receipt for new requests and idempotent replays. Public DTOs omit raw
arguments, fingerprints, credential material, owner and principal IDs. Existing
stored Invocation arguments may still contain sensitive data: there is no complete
redaction/retention system. Authorized callers need their own submitted arguments
for retries; there is no raw argument retrieval endpoint.

Routes are `POST /api/v1/external/runs`, `GET /api/v1/external/runs/:id`,
`POST /api/v1/external/runs/:id/invocations`,
`GET /api/v1/external/invocations/:id`,
`POST /api/v1/external/invocations/:id/cancel`,
`GET /api/v1/external/runs/:id/history`, and
`POST /api/v1/external/runs/:id/close`. POST requests require JSON; cancel and close
accept `{}`. Request bodies are limited to 64 KiB, responses to 128 KiB and history
pages to 100 events. The decimal `after` cursor must belong to the same authorized
run; `nextCursor` is the last returned sequence and may be reused to poll for later
events even when `hasMore` is false. Gaps in global sequence numbers are normal.
Event status reflects the recorded transition; use GET invocation for current state.
History is reconciliation data, not an agent reasoning checkpoint. There is no
API for approvals, execution, credential issuance or grants.

Phase 11.2a adds operator-attested resource-free READ_ONLY eligibility and immutable
Invocation authorization evidence. Supported requests may reach READY or blocked
PENDING_APPROVAL; unverifiable resources retain RESOURCE_BINDING_UNVERIFIED. No
external execution or start endpoint is enabled, and public receipts still report
`executionAllowed: false`. See [external authorization](external-authorization.md)
for the exact supported schema, policy/revocation locks, start-time guard and limits.

Dedicated subsystem architecture documents should be extracted from this map
only when justified, with links instead of duplicated explanations.
