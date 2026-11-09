# External human approvals and controlled WRITE — Phase 11.3

Implemented for **one** fixed `write_demo_receipt({})` tool. This is separate from
reference TaskRun approvals, BullMQ resume and AgentRuntime. No queue/model work is
introduced. Generic filesystem writes, DELETE and EXTERNAL_WRITE remain disabled.
[External authorization](external-authorization.md) owns grants/snapshots;
[executor protocol](executor-protocol.md) owns isolation, starts and result delivery.

## Exact approval and lifecycle

Admission requires a sealed tool revision named `write_demo_receipt`, handler
`write_demo_receipt.v1`, declared/reviewed WRITE, exact empty schema/arguments, an
explicit grant for the output resource and trusted demo binding. It creates, in the
same transaction, PENDING_APPROVAL Invocation, immutable authorization snapshot,
ExternalApprovalRequest and admission event. A manifest label alone is insufficient.
Other unsupported sensitive tools remain blocked; this is not general approval support.

The immutable approval identity contains Invocation/owner/agent/version, canonical
argument/request digests, tool/manifest revision, grant/policy, deployment/environment,
binding/revision/artifact, exact resource, target filename, content digest, risk and
expiry. Request digest is a confirmation of the exact action, not a bearer permit.

| Record/state | Meaning |
| --- | --- |
| PENDING_APPROVAL | Request exists; no decision, claim or execution is permitted |
| APPROVED approval / READY Invocation | Operator approved the exact action; start still requires live reauthorization |
| REJECTED approval / REVOKED Invocation | Immutable rejection; cannot start; a changed decision cannot overwrite it |
| EXPIRED / INVALIDATED approval view | Expiry or current authorization no longer permits execution; no automatic renewal |
| CONSUMED approval / START_AUTHORIZED Invocation | Exact decision consumed with one committed start; not proof of physical execution |

`ExternalApprovalDecision` is immutable and records principal, exact credential,
time, request key/digest, decision and reason. `ExternalApprovalConsumption` is a
separate immutable link to ExecutorStart. Polling and claiming never consume approval.
A same-key/identical decision retry returns the original record. Different content,
actor/credential or competing APPROVE/REJECT conflicts. One decision per request is
DB-enforced. Rejecting an expired still-pending request is allowed; approving it is not.

Expiry defaults to 15 minutes from admission, capped by binding and original agent
credential expiry. Trusted server composition can shorten the TTL (minimum one second,
maximum 15 minutes); HTTP clients cannot choose it. Before start, grant/binding
revocation, deployment changes, requester/executor credential revocation, decision
operator credential expiry/revocation/scope removal, or snapshot mismatch invalidates
eligibility. These checks never rewrite historical approval. Revocation after start
commit cannot retract an issued permit or guarantee cancellation of physical effects.

There is no approval-edit/renew endpoint. A previous approval never authorizes a new
Invocation, different inputs or artifact. To withdraw authority after APPROVE, use
existing trusted grant/binding/credential revocation; do not overwrite the decision.
Invalid unclaimed READY records may remain stored READY with INVALIDATED/EXPIRED
approval view and executionAllowed=false; automatic pre-start cleanup is not added.
Claim reconciliation can close invalid pre-start claims. This availability limitation
must not be bypassed by resetting state or recycling an uncertain Invocation.

## Authenticated operator CLI

Only OPERATOR with explicit `operator:approve`, belonging to the Invocation's owner,
may inspect or decide. Agent and executor credentials cannot use it. No public
approval HTTP route, credential issuance endpoint or new dashboard is added.

A trusted administrator issues the operator credential using the existing
TrustedCredentialIssuer. Keep the token in a protected 0600/0400 file, never an argument:

```bash
export FOUNDRY_OPERATOR_CREDENTIAL_FILE=/secure/path/operator-token
npm run external-approvals -- inspect INVOCATION_ID
```

Inspect shows exact arguments, resource, target, deterministic content, WRITE risk,
authorization identity, expiry, requestDigest and current eligibility. Review these
before deciding; do not treat canDecide as permission for an executor to start.

```bash
npm run external-approvals -- decide INVOCATION_ID \
  --request-digest DIGEST_FROM_INSPECTION \
  --request-key operator-decision-001 \
  --decision APPROVE \
  --reason "Reviewed exact demo receipt and dedicated output resource"
```

Use `--decision REJECT` for rejection. Preserve the request key for a lost-response
retry. Decisions do not create capabilities. Operators need no agent/executor scope.
The CLI uses authenticated services and normal transactions, not unauthenticated DB
state edits. It prints operator-only audit data; do not put credentials in reasons.

Agent-owned Invocation HTTP receipts/GET add a safe approval summary when present:
ID, status, decision, expiry/consumption time and executionAllowed=false. Agent history
includes approval identity/event classification, never private operator reasons,
credentials, the confirmation digest or raw approval snapshots. Existing pagination
and ownership checks remain. Unrelated READ_ONLY DTOs remain unchanged.

## Atomic start and lock order

Operations serialize on the ExternalRun row. They lock relevant requester/executor/
operator credentials in sorted ID order, then principals, Invocation and pinned
policy/deployment/binding rows. The same rows coordinate revocation. DB UTC time is
sampled after waits. Operator inspection is read-only; decisions/state/events commit
together. Claim/start reauthorization checks the immutable approval and live decision
actor, not merely a READY flag. Unsupported sensitive profiles cannot use this path.

Start additionally requires exact active session/claim/generation, unexpired lease,
matching protected artifact/resource and no prior possible-start evidence. Approval
must be APPROVE, unexpired, unconsumed and bound to the exact authorization digest.
In one transaction Foundry inserts ExecutorStart, consumes approval, writes claim
start marker, START_AUTHORIZED state and consumption/start events. Deferred DB
constraints and unique indexes reject partial/duplicate commits. Identical repeated
start requests return the old identity with startAllowed=false. Claim/lease expiry
before any possible start may allow a new generation of the same unconsumed request;
a possible start never permits reassignment or a second write.

## Trusted output resource and isolated handler

`TrustedResourceBindings.approveDemoOutput` is trusted local administration requiring
grant:manage. It binds exact tool/deployment/revision/artifact, ledger and a resource
ID `foundry:demo-output:<UUID>` under mode DEMO_RECEIPT_WRITE_V1. Execution profile is
`docker-demo-receipt-v1`. The grant must explicitly include this exact resource; no
wildcards, agent paths, aliases or arbitrary content are supported.

The output is a new, dedicated named Docker volume, never a project/application
workspace. Trusted provisioning creates its root as UID0:GID10001, mode 01770 and a
UID0:GID10001 mode0440 single-link regular `.foundry-resource.json` file:

```json
{"version":1,"profile":"docker-demo-receipt-v1","resourceId":"foundry:demo-output:<UUID>"}
```

The sticky root prevents UID10001 from replacing the root-owned marker. The agent
has neither this volume, the ledger, executor secret nor Docker/host control.
Do not clone a marker into a new resource or reinitialize retained output silently.
The host administrator and mapping/provisioning remain trusted; this is not attestation.

The executor secret config adds executionProfile and outputResource to the existing
identity. WRITE ledger identity includes both, preserving READ_ONLY identity format.
The trusted host launcher JSON additionally sets `profile`, `outputVolume` and
`outputResource`. All three volumes must be distinct. Only WRITE gets the third RW
mount `/demo-output`; READ_ONLY keeps exactly its original two mounts. Rootfs remains
read-only, UID/GID10001, no capabilities, no-new-privileges and original resource/
network limits. All protected named mounts use volume-nocopy, preserving provisioned
ownership instead of Docker copying image directory metadata into empty storage.

Startup verifies the bundled handler's SHA-256 and protected volume marker before
claiming. The start response identifies the same profile/resource/target. The handler
opens the fixed directory with O_DIRECTORY|O_NOFOLLOW, verifies UID/GID/mode and marker
through that directory FD, and creates `receipt-<InvocationID>.txt` through its stable
`/proc/self/fd` directory reference. Invocation IDs allow only bounded ASCII identifiers.
O_CREAT|O_EXCL|O_NOFOLLOW forbids overwrite and leaf symlink traversal. New files use
0600; file and directory are fsynced. There is no shell, delete, arbitrary path/content
or network call in this handler. Errors remain conservatively UNKNOWN.

The standalone bundled `write-demo-receipt.js` includes its fixed helper code; its
actual bytes are the approved artifact. No caller-selected modules are loaded.
START_INTENT precedes the handler; a bounded deterministic report is stored locally
before submission. Report metadata binds exact Invocation, resource, filename and
content hash. It is validated in the service and DB, but remains EXECUTOR_REPORTED.

## Verification, failures and operations

The test verifier runs in a separate network-less process with a read-only output
mount. It checks regular-file existence, exact expected content, directory listing,
rootfs changes, one authorized start and one approval consumption. Test evidence JSON
retains the operator decision, start/history and file observations after disposable
resources are removed. This is independent test postcondition evidence, **not** an
independently verified production Invocation status or complete remote attestation.

A file may remain after a crash before durable result persistence. Even correct bytes
do not prove the original Invocation's full completion; UNKNOWN stays active and no
handler retry occurs. Lost ACK resends only the persisted report. Revoked executor
credentials retain pending results and require the existing operator investigation,
not a new credential bypass. Ledger continuity/replaced-volume quarantine is unchanged.
Follow the [recovery runbooks](../operations/executor-recovery.md) for preservation.

```bash
npm run build:executor
node scripts/build-executor-test.mjs
docker build -f executor/Dockerfile --target executor -t agent-foundry-executor:11.3 .
docker build -f executor/Dockerfile --target private-api -t agent-foundry-private-api:11.3 .
# Test instrumentation only; never deploy this target as the production executor.
docker build -f executor/Dockerfile --target write-fault-test -t agent-foundry-write-fault:11.3 .
node scripts/test-external-write.mjs approved
```

Other test modes: unapproved, rejected, grant-revoked, binding-revoked, wrong-resource,
overwrite, symlink, before-handler, after-intent, after-write, lost-ack,
credential-revoked. All create isolated PostgreSQL/networks/credentials/volumes and
remove only their own resources. Test OPERATOR CLI decisions simulate the human role;
they are not evidence of a person manually reviewing a live deployment. SIGKILL
boundaries use a test-only instrumented entry point paused at an exact runtime hook,
then killed by the Docker host. Production main has no fault-selection interface.
The real fixed artifact, runtime, authorization, storage and isolation are exercised.

Deploy migration `20261112000000_external_write_approvals` explicitly before upgraded
API/CLI/executor code. It adds dedicated immutable request/decision/consumption tables,
nullable resource/event metadata and scoped resource/result guards. No new Invocation
state is needed. Issue approval-scoped credentials explicitly. Existing v2 READ_ONLY
ledgers remain unchanged; existing installations never gain WRITE by default. Provision
a new reviewed WRITE deployment/binding, dedicated ledger, protected secret and output
volumes using the tested topology. Existing services/DBs are never upgraded automatically.
