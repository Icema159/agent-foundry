# External Invocation authorization — Phase 11.2a

Implemented: the resource-free READ_ONLY foundation and one controlled demo WRITE
binding with exact external approvals. Generic resource interpretation, arbitrary
handlers, DELETE and EXTERNAL_WRITE remain disabled. See [external approvals](external-approvals.md)
for the authoritative WRITE binding, lifecycle and atomic consumption contract.
The [executor protocol](executor-protocol.md) owns isolated runtime delivery.
The [execution pipeline](execution-pipeline.md#11-current-integration-versus-future-contract)
owns the surrounding identity, registry, API and history contract.

## Supported trust boundary

`TrustedResourceBindings.approveResourceFree` is a trusted local operator operation
requiring `grant:manage`. It is not exposed through HTTP. The operator explicitly
attests that a pinned handler artifact in an exact deployment is resource-free and
READ_ONLY. A manifest's READ_ONLY label and an empty schema alone never suffice.

The original READ_ONLY binding mode is `RESOURCE_FREE_READ_ONLY_V1`. Its exact input
schema is `{ "type": "object", "properties": {}, "additionalProperties": false }`
and its validated arguments must be `{}`. No paths, URLs, aliases, selectors,
encoded targets, optional parameters or generic resource resolver are supported.
The grant must explicitly allow the reserved resource `foundry:resource-free:v1`;
grant ownership, agent version, tool record and deployment still constrain that name.

The operator-approved record pins the tool record/digest, deployment identity and
environment digest, a SHA-256 handler artifact digest, positive binding revision,
approving principal and expiry. The artifact digest is operator attestation, **not**
proof of installed code or execution isolation. Mode 1 trusts the operator and host
administrator. The fixed 11.2c runner additionally verifies its local protected
artifact and Docker profile, without claiming independent host attestation. Its
optional execution profile/ledger identity are included in new snapshots; old
metadata-only snapshot fingerprints remain unchanged.

Bindings are immutable except monotonic revocation. Only one non-revoked binding
may exist per tool/deployment; revoke an expired binding before publishing another
revision. Agents cannot approve, replace or revoke bindings.

## Admission decisions

`InvocationService.acceptInvocation` preserves canonical request arguments,
fingerprints, idempotency and the single-active Invocation constraint. A same-key
replay returns its original receipt even if a binding is subsequently published or
revoked; it does not rerun authorization or upgrade the earlier request.

| Conditions | Persisted outcome |
| --- | --- |
| Missing/revoked/mismatched grant | DENIED / CAPABILITY_NOT_GRANTED |
| No supported active, unexpired trusted binding | REQUESTED / RESOURCE_BINDING_UNVERIFIED |
| Supported binding but reserved resource absent from grant | DENIED / RESOURCE_NOT_GRANTED |
| Trusted resource-free binding, matching grant and READ_ONLY reviewed profile | READY / RESOURCE_AUTHORIZED |
| Same supported binding but grant reviewed as WRITE, DESTRUCTIVE or EXTERNAL_WRITE | PENDING_APPROVAL / APPROVAL_REQUIRED |

Non-READ_ONLY declared tools cannot obtain the resource-free binding type. Unsupported tools stay
REQUESTED with RESOURCE_BINDING_UNVERIFIED when granted; their persisted execution
policy is REQUIRE_APPROVAL. Phase 11.3 supports only the separately reviewed write_demo_receipt WRITE mode,
which has a dedicated approval/consumption path. Other sensitive requests stay
blocked. Cancellation remains limited to the original blocked
REQUESTED state. READY, PENDING_APPROVAL and UNKNOWN retain the active run slot.

READY records an admission-time eligibility decision; it does not guarantee that
authorization remains current. Eligibility inspection cannot authorize execution.
All existing public Invocation DTOs retain `executionAllowed: false`.

## Durable evidence and policy revisions

An eligible or approval-required supported request gets one immutable
`InvocationAuthorization` snapshot in the same transaction as its Invocation and
AUTHORIZATION_DECISION event. The snapshot/digest binds Invocation/run/owner/agent,
external version/digest, canonical argument digest and unchanged request fingerprint,
tool/manifest revision and digests, handler ID, deployment/environment, exact grant
and policy digest, binding revision/artifact/expiry, original requester credential,
resource, execution policy and effective expiry.

A CapabilityGrant ID is its immutable policy revision. Policy field edits and
undoing revocation are rejected by PostgreSQL; changed policy requires a new grant.
Binding and snapshot revisions also have database immutability guards. Authorization
events identify the request fingerprint, grant/policy, binding revision and snapshot
digest. This metadata is internal; existing public DTOs omit snapshots, credential
identity, argument fingerprints and raw arguments. Existing retention/redaction
limitations for persisted arguments remain unchanged.

## Transactional checks and future start contract

Admission takes locks in this order: run, requester credential/principal, exact
grant, deployment, binding. Credential, grant and binding revocation UPDATEs contend
on the same rows. Time is sampled from PostgreSQL after lock acquisition, explicitly
in UTC. Revocation committed first prevents a fresh eligible decision; one committed
after admission invalidates subsequent reauthorization. Credential state is checked
again after potentially waiting on policy locks. Snapshot/event/state commit together.

`InvocationService.inspectStartEligibility` is an internal, agent-scoped inspection
using the original requester credential, never an HTTP start endpoint. It locks the
run and Invocation and calls the reusable transactional `recheckPinnedAuthorization`
guard with the expected snapshot digest. The guard rereads and locks current
credential/principal, grant, deployment and binding state, requires an open READY
Invocation and the same snapshot, checks scope, expiry, owner/agent, resource and
policy. Its result always contains `startAllowed: false` and it writes no start event.
Changing bindings/grants does not refresh old snapshots. Inspection with a different
requester credential is fail-closed, even for another credential of the same agent.

The 11.2b protocol also calls the guard for the exact current pre-start CLAIMED
generation. This policy check does not itself validate a lease as start permission;
the protocol separately fences claimant identity and deadlines and never starts a
handler. The agent-facing inspection remains READY-only.

Phase 11.2c reuses the guard inside the executor-only atomic start transaction,
requiring the exact current session, claim/generation, unexpired lease and approved
health artifact/ledger installation. It commits START_AUTHORIZED before permission
is returned. The guard itself **still** always returns `startAllowed: false`; only
the owning transaction may authorize this fixed READ_ONLY path. WRITE uses the separately bound external approval consumption; READ_ONLY does not
consume an approval. See [start, ledger and result semantics](executor-protocol.md#atomic-start-and-result-api)
for the authoritative protocol. Start commit orders revocation against new
authorization, not the first physical handler instruction. No exactly-once or remote
cancellation guarantee is made.

## Resource-state and remaining limitations

This resource-free mode avoids remote path/URL interpretation entirely. A future
executor must still ensure the actual handler/artifact is the pinned one, cannot be
modified by the agent, and has only operator-approved privileges. Future filesystem
or network models need trusted local resource resolution, symlink/traversal/network
checks and any necessary resource-version preconditions immediately before use.
Those TOCTOU checks cannot be replaced by the current control-plane snapshot.

The new migration is additive and tested only in dedicated test databases. Deploy
it before running new API code; running services are not automatically restarted or
upgraded. Main Foundry database migration remains an explicit operator action.
