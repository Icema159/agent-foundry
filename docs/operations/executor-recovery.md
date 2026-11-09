# Isolated executor recovery — Phase 11.2d

Applies to fixed external health_ping and approved write_demo_receipt paths.
WRITE approval/resource specifics are owned by [external approvals](../architecture/external-approvals.md). The reference TaskRun worker,
BullMQ and R1/R2/R3 recovery are separate. See the owning
[executor protocol](../architecture/executor-protocol.md) for isolation and start semantics.

## Operator access and evidence

Use a newly issued, protected OPERATOR credential with explicit `operator:reconcile`.
Issuance is trusted administration (`TrustedCredentialIssuer.issue`), never a public
HTTP route. Existing operator credentials do not acquire the scope automatically.
Keep the token alone in a 0600/0400 file owned/readable by the intended operator.
Never put tokens in command arguments, logs, findings or evidence reference files.
`DATABASE_URL` must identify the intended database; these commands can record audit
state and must not be pointed at a test/live database by accident.

```bash
export FOUNDRY_OPERATOR_CREDENTIAL_FILE=/secure/path/operator-token
npm run reconcile -- inspect INVOCATION_ID
# Explicit bounded, evidence-based refresh; never executes a handler.
npm run reconcile -- refresh INVOCATION_ID
```

`inspect` is read-only. It returns owner/agent/run/deployment, current state, original
claim/session/credential identities, artifact, start/report digests, continuity anchor
and recent events/findings. It omits arguments, credential verifiers and raw results.
Each list is capped at 100 and counts/truncated are explicit. It is an investigation
summary, not a complete large-history export; older evidence may require a trusted,
owner/Invocation-scoped read-only DB investigation. Do not assume truncated evidence
is complete. `refresh` records UNKNOWN only when durable start evidence and the
lease/session/result deadline/credential state establish lost execution ownership;
it does not infer handler failure or success. No background scheduler is added.

Before touching storage, stop **only the affected executor** through the trusted host
administrator. Preserve its named volume and SQLite DB/WAL/SHM as a coherent set.
Never delete the files, rerun the initializer or use an empty replacement volume to
make startup pass. Docker root/administrator remains trusted; give none of this
access to the untrusted agent.

Offline export from the retained volume uses the restricted image and no network:

```bash
docker run --rm --network=none --user 10001:10001 --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=256m \
  --tmpfs /tmp:rw,noexec,nosuid,size=96m,uid=10001,gid=10001,mode=0700 \
  --mount type=volume,src=RETAINED_LEDGER_VOLUME,dst=/ledger,readonly,volume-nocopy \
  --entrypoint node agent-foundry-executor:11.3 /app/evidence.mjs \
  > /secure/path/ledger-evidence.json
```

The exporter copies the stopped source DB/WAL/SHM into a private temporary directory
(maximum 32 MiB source snapshot), leaving the original mount read-only. SQLite may
recover its WAL only in that disposable copy. It checks integrity and emits bounded identities,
states, report/ACK digests and an evidenceDigest. It never emits the continuity nonce,
credential or raw report payload. A damaged file may be unexportable: preserve it,
do not repair it in place. An export is **LOCAL_EXPORT_NOT_INDEPENDENTLY_VERIFIED**;
a digest proves neither host honesty nor independent handler success. A legacy
ledger can be exported but cannot silently become a new execution baseline.

To record an investigation, create an optional JSON reference file (not raw results):

```json
[{"kind":"START","id":"<start ID from inspection>"},
 {"kind":"LEDGER_EXPORT","id":"<evidenceDigest from export>"}]
```

```bash
npm run reconcile -- record INVOCATION_ID \
  --request-key investigation-001 \
  --basis-sequence SEQUENCE_FROM_LATEST_INSPECTION \
  --decision RECOVERY_BLOCKED \
  --reason "Original credential revoked; preserved result cannot be submitted" \
  --evidence-file /secure/path/evidence-references.json
```

Decisions are RETAIN_UNKNOWN, CONFLICTING_EVIDENCE or RECOVERY_BLOCKED. All are
unverified **findings**, not independently verified outcomes. State stays UNKNOWN,
execution/retry/result-import remain disabled, and the ExternalRun cannot close.
The event records finding identity/classification, not the operator's free-text reason
or local export in general agent history. Full reasons/references are operator-only.
Use new inspection/basis for a later finding. Identical request-key retries return the
same finding; changed content conflicts. Concurrent decisions with the same basis
have one winner. Evidence IDs must belong to this Invocation; a LEDGER_EXPORT digest
is explicitly an operator-supplied unverified reference, not an authenticated import.

## Runbooks

| Incident / symptoms | Evidence | Safe actions / expected state | Prohibited actions / unavoidable intervention |
| --- | --- | --- | --- |
| UNKNOWN / start without confirmed outcome | Inspect start, original actor/session, lease/deadline, reports/events; compare offline ledger | Refresh if still START_AUTHORIZED; record RETAIN_UNKNOWN or CONFLICTING_EVIDENCE. UNKNOWN remains active unless a valid original executor result supplies evidence | Do not infer failure from silence or success from START_INTENT. Never requeue, reset READY, replay the handler or mark successful manually |
| Executor process/container restart | Same deployment/binding/artifact, same initialized ledger incarnation; compare every local claim and committed start/report | Restart with the same protected secret/ledger volumes through the verified launcher. New session fences old one; inventory validation precedes polling; pending reports are resent, never handlers | Do not run separate copied ledgers concurrently. An unresolvable mismatch requires quarantine/operator investigation |
| Missing/corrupt ledger | Startup failure; retained files, backups, PostgreSQL start/report history | Stop affected executor, retain volume and coherent files, inspect offline; record RECOVERY_BLOCKED for unresolved starts. No work accepted | Never initialize over it, discard WAL/SHM, drop anchor or rebuild missing starts from incomplete history. Manual intervention required |
| Deployment replacement / old 11.2c installation | Active old credentials/bindings, sessions/start history, pending reports, retained volume | Fence/revoke the old executor and binding through trusted administration; preserve evidence. A **new** reviewed deployment/binding/ledger may accept genuinely new work. Old UNKNOWN stays blocked | Do not change old immutable IDs, repoint unresolved Invocation or resubmit its business action as a retry. Legacy v1 ledgers/history have no anchored v2 baseline; no automatic upgrade/reconstruction is provided |
| Credential revoked with RESULT_PENDING | Offline report digest/start/session, original credential revokedAt, server report/ACK | Revocation stays effective. If server already committed the report, inspect its authoritative status. If absent, refresh to UNKNOWN and record RECOVERY_BLOCKED, retaining the pending report. Operator import is deliberately unavailable | Do not un-revoke, use another executor credential, submit via operator scope, copy tokens to the agent, or fabricate SUCCEEDED. Further authenticated evidence-import design is required |
| Foundry API outage / lost ACK | Local START_REQUESTED/START_INTENT/RESULT_PENDING, server start and report after reconnect | Preserve volume; restore API then explicitly restart. A stored result is resent with original valid credential; identical committed report returns the same ACK. Uncertain start becomes UNKNOWN | Do not rerun to regenerate output. If binding/credential is revoked or continuity cannot be established, retain evidence and require operator intervention |
| Restored backup / stale ledger | Incarnation digest vs immutable anchor; local rows vs all server claims/starts/reports, exact generation/session/artifact and ACK identities | A coherent valid ledger may reconcile. Missing committed starts/reports, mismatched ACKs or new incarnation fail closed; record CONFLICTING_EVIDENCE/RECOVERY_BLOCKED | Never restore only the SQLite main file while discarding WAL. Do not reset continuity metadata, remove local ACKED rows, or rewrite PostgreSQL history to fit a backup |

For WRITE, a remaining receipt file (even with expected content) is not proof that
the original Invocation completed its protocol. Preserve the output volume together
with its ledger and server history. Never delete/overwrite a receipt to make a retry
pass. Lost result evidence stays UNKNOWN; existing findings cannot authorize another
write or consume a new approval.

## Continuity limits and deployment

The v2 ledger creates a random installation nonce; only its SHA-256 digest is anchored
once in PostgreSQL at the first session. An already-sessioned legacy binding without
an anchor is rejected (LEDGER_BASELINE_REQUIRED). Reinitializing the same ledgerId
creates a different nonce and is rejected, even when the file is valid SQLite.
A copied older snapshot retains its nonce but fails when authoritative DB starts or
reports are missing/contradicted locally. A snapshot indistinguishable from a lost
start response yields UNKNOWN, never automatic execution. A fenced pre-start claim
with no possible start may still be reclaimed without reconstructing local execution.

This is continuity checking by a cooperative trusted executor, not remote attestation.
No software can detect an identical historical snapshot when neither side has any
new observable evidence. Restoring/losing both PostgreSQL and ledger to matching old
states, malicious host tampering, physical power loss and storage fsync failures are
not covered guarantees. Retention must preserve anchor, starts, reports and local
ACKED rows; do not prune them independently. Recovery is capped at 10,000 local/server
claim records per installation; capacity overflow fails closed pending operator work.

Apply migration `20261111000000_executor_reconciliation` explicitly to the intended
DB before upgraded API/runtime code. It adds immutable ExecutorLedgerAnchor,
append-only OperatorFinding, atomic finding-event checks and an Invocation event index;
no new lifecycle state is added. Rebuild the current 11.3 images. Existing v1 ledgers are
not automatically edited: retain/export and replace the deployment under the procedure
above. Provision a new OPERATOR credential for the reconciliation scope. No new
operator HTTP endpoint or result import is enabled. External tool decisions use the
separate 11.3 approval scope and lifecycle; findings never consume approval.
