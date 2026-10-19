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
approval decisions. Summaries omit large payloads, but raw Steps contain more
data: not all R2 diagnostics are exposed as dedicated timeline fields. R3 outcomes
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

Important implementation discrepancy: `isReadOnlyRepositoryRun` allows the named
Repository Explorer with ALLOW reads **and a REQUIRE_APPROVAL create_file
exception**. Delete-capable versions are rejected even if deletion was never
used, so current default Explorer versions do not qualify. Do not infer broad
write-retry safety from the function/error naming. Eligible recovery uses stale
state checks; the unsafe `failStaleExecution` branch uses an unconditional run
update, so concurrent recovery/heartbeat hardening is not complete.

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

Agent Contract / BYOA / bring-your-own-tools is **PROPOSED / NOT IMPLEMENTED**.
Its public interfaces and guarantees are not defined by this document. Create
`docs/design/agent-contract.md` only when that design is explicitly undertaken.
Dedicated subsystem architecture documents should be extracted from this map
only when justified, with links instead of duplicated explanations.
