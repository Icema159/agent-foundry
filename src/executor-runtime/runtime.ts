import { acknowledgement, localReport, type StartIdentity } from "./response.js";
import { randomUUID } from "node:crypto";
import { canonical } from "../registry/validation.js";
import { EXECUTION_PROFILE, HEALTH_RESULT, reportIdentity, type ReportInput } from "../executor/execution-contract.js";
import { WRITE_PROFILE, receiptIdentity } from "../executor/demo-receipt-contract.js";
import { healthPing } from "./health-ping.js";
import { type ExecutorClient, ApiFailure, ExecutorApi } from "./api-client.js";
import { StartLedger, RECOVERY_HISTORY_LIMIT, RECOVERY_HISTORY_WARNING_AT, type Attempt, type LedgerCounts } from "./ledger.js";
import type { RecoveryClaim } from "../executor/recovery-contract.js";

export type FaultPoint = "after_prepare" | "after_start_requested" | "after_start_response" | "after_start_intent" | "after_handler" | "after_result_persisted" | "after_result_ack";
export type RecoveryCapacity = {
  limit: number;
  warningAt: number;
} & ({ history: "local" } & LedgerCounts | { history: "server"; total: number; inventoryComplete: boolean });

const LEDGER_STATES = new Set(["PREPARED", "START_REQUESTED", "START_INTENT", "RESULT_PENDING", "ACKED", "AMBIGUOUS", "ABANDONED"]);

/** Fixed-handler controller. Injection points exist for deterministic tests, never CLI configuration. */
export class IsolatedExecutorRuntime {
  private sessionId = "";
  private ready = false;
  private localRecordCount = 0;
  private readonly api: ExecutorApi;
  constructor(private readonly ledger: StartLedger, transport: ExecutorClient, private readonly verifyArtifact: () => void,
    private readonly fault: (point: FaultPoint) => void = () => {}, private readonly handler: (args:unknown,context:{invocationId:string;outputResource?:string})=>unknown = healthPing,
    private readonly onCapacity: (capacity: RecoveryCapacity) => void = () => {}) { this.api = new ExecutorApi(transport); }
  async initialize() {
    this.ready = false;
    this.verifyArtifact();
    this.reportLocalCapacity();
    const identity = this.ledger.identity;
    const session = await this.api.register({ bindingId: identity.bindingId, sessionKey: randomUUID(), artifactDigest: identity.artifactDigest,
      ledgerId: identity.ledgerId, executionProfile: identity.executionProfile??EXECUTION_PROFILE, ledgerProofDigest: this.ledger.proofDigest, ...(identity.outputResource?{outputResource:identity.outputResource}:{}) });
    if (session.deploymentId !== identity.deploymentId || session.bindingId !== identity.bindingId ||
      session.artifactDigest !== identity.artifactDigest || session.ledgerId !== identity.ledgerId ||
      session.executionProfile !== (identity.executionProfile ?? EXECUTION_PROFILE) || session.outputResource !== identity.outputResource) throw new Error("Session installation mismatch");
    this.sessionId = session.id;
    await this.checkContinuity();
    for (const attempt of this.ledger.unfinished()) await this.recover(attempt);
    this.ready = true;
  }
  private reportLocalCapacity() {
    const counts = this.ledger.counts();
    this.localRecordCount = counts.total;
    this.onCapacity({ history: "local", ...counts, limit: RECOVERY_HISTORY_LIMIT, warningAt: RECOVERY_HISTORY_WARNING_AT });
  }
  private reportServerCapacity(total: number, inventoryComplete: boolean) {
    this.onCapacity({ history: "server", total, inventoryComplete, limit: RECOVERY_HISTORY_LIMIT, warningAt: RECOVERY_HISTORY_WARNING_AT });
  }
  private writeContract(invocationId:string){return this.ledger.identity.executionProfile===WRITE_PROFILE?{invocationId,outputResource:this.ledger.identity.outputResource!}:undefined;}
  private async checkContinuity() {
    const local = new Map<string, Attempt>();
    for (const attempt of this.ledger.all()) {
      if (local.has(attempt.claimId)) throw new Error("Duplicate local claim");
      local.set(attempt.claimId, attempt);
    }
    const seen = new Set<string>();
    const startIds = new Set<string>();
    const reportIds = new Set<string>();
    let after: string | undefined;
    do {
      const page = await this.api.inventory(this.sessionId, this.ledger.proofDigest, after);
      const receivedCount = seen.size + page.claims.length;
      if (receivedCount > RECOVERY_HISTORY_LIMIT) {
        this.reportServerCapacity(receivedCount, false);
        throw new Error("Server reconciliation capacity exceeded");
      }
      for (const claim of page.claims) {
        if (seen.has(claim.id)) throw new Error("Repeated recovery cursor");
        seen.add(claim.id);
        const attempt = local.get(claim.id);
        if (!attempt) { if (claim.start) throw new Error("Stale ledger: authorized start missing locally"); continue; }
        if (attempt.invocationId !== claim.invocationId || attempt.generation !== claim.generation || attempt.sessionId !== claim.sessionId ||
          attempt.artifactDigest !== claim.artifactDigest) throw new Error("Ledger claim identity mismatch");
        if (!LEDGER_STATES.has(attempt.state)) throw new Error("Invalid ledger state");
        const reports = new Map<string, NonNullable<RecoveryClaim["start"]>["reports"][number]>();
        if (claim.start) {
          if (startIds.has(claim.start.id)) throw new Error("Duplicate start identity");
          startIds.add(claim.start.id);
          if (["PREPARED","ABANDONED"].includes(attempt.state) || attempt.requestKey !== claim.start.requestKey ||
            (attempt.startId && attempt.startId !== claim.start.id)) throw new Error("Start history contradicts ledger");
          if (claim.start.reports.length && !attempt.report) throw new Error("Stale ledger: committed report missing locally");
          for (const report of claim.start.reports) {
            if (reports.has(report.digest) || reportIds.has(report.id)) throw new Error("Duplicate recovery report identity");
            reports.set(report.digest, report);
            reportIds.add(report.id);
          }
        } else if (attempt.startId || ["START_INTENT","RESULT_PENDING","ACKED"].includes(attempt.state)) throw new Error("Local start missing from Foundry");
        if (["RESULT_PENDING","ACKED"].includes(attempt.state)) {
          const body = localReport(JSON.parse(attempt.report!));
          if (!claim.start || attempt.startId !== claim.start.id || body.sessionId !== attempt.sessionId || body.generation !== attempt.generation) throw new Error("Ledger result identity mismatch");
          const digest = reportIdentity(body,this.writeContract(attempt.invocationId)).digest;
          const known = reports.get(digest);
          if (claim.start.reports.length && (!known || known.outcome !== body.outcome)) throw new Error("Conflicting persisted result");
          if (attempt.state === "ACKED") {
            const ack = acknowledgement(JSON.parse(attempt.ack!));
            if (!known || ack.reportId !== known.id || ack.startId !== claim.start.id || ack.digest !== digest || ack.outcome !== known.outcome) throw new Error("Ledger acknowledgement mismatch");
          } else if (!claim.reportCredentialCurrent) throw new Error("Pending result needs original credential; operator recovery required");
        }
      }
      after = page.nextCursor;
    } while (after);
    this.reportServerCapacity(seen.size, true);
    for (const id of local.keys()) {
      if (!seen.has(id)) throw new Error("Local claim missing from Foundry; recovery blocked");
    }
  }
  private validateStart(attempt: Attempt, start: StartIdentity) {
    const write=this.writeContract(attempt.invocationId);
    if(write){if(start?.execution?.profile!==WRITE_PROFILE||start.execution.outputResource!==write.outputResource||start.execution.target!==receiptIdentity(write.invocationId,write.outputResource).path)throw new Error("WRITE permit resource mismatch");}
    else if(start?.execution)throw new Error("Unexpected WRITE permit in READ_ONLY installation");
    if (start.invocationId !== attempt.invocationId || start.claimId !== attempt.claimId || start.generation !== attempt.generation ||
      start.sessionId !== attempt.sessionId || start.requestKey !== attempt.requestKey || start.artifactDigest !== attempt.artifactDigest) throw new Error("Authorized start identity mismatch");
  }
  private async sendPending(attempt: Attempt) {
    const body = localReport(JSON.parse(attempt.report!));
    if (!attempt.startId || body.sessionId !== attempt.sessionId || body.generation !== attempt.generation) throw new Error("Ledger result identity mismatch");
    const digest = reportIdentity(body, this.writeContract(attempt.invocationId)).digest;
    const response = await this.api.report(attempt.startId, body);
    if (response.startId !== attempt.startId || response.digest !== digest || response.outcome !== body.outcome) throw new Error("Result acknowledgement mismatch");
    this.fault("after_result_ack");
    this.ledger.move(attempt.claimId, ["RESULT_PENDING"], "ACKED", attempt.startId, null, JSON.stringify(response));
  }
  private async uncertain(attempt: Attempt, start: StartIdentity, reason: "START_RESPONSE_LOST" | "EXECUTOR_RESTART_UNCERTAIN" | "START_DEADLINE_EXPIRED") {
    this.validateStart(attempt, start);
    const body: ReportInput = { sessionId: attempt.sessionId, generation: attempt.generation, outcome: "UNKNOWN", reason };
    this.ledger.move(attempt.claimId, ["START_REQUESTED", "START_INTENT", "AMBIGUOUS"], "RESULT_PENDING", start.id, JSON.stringify(body));
    await this.sendPending(this.ledger.get(attempt.claimId));
  }
  private async recover(attempt: Attempt) {
    if (attempt.state === "RESULT_PENDING") return this.sendPending(attempt);
    if (attempt.state === "PREPARED") {
      try {
        const claim = await this.api.release(attempt.claimId, attempt.generation, attempt.sessionId);
        if (claim.id !== attempt.claimId || claim.invocationId !== attempt.invocationId || claim.generation !== attempt.generation ||
          claim.deploymentId !== this.ledger.identity.deploymentId) throw new Error("Release identity mismatch");
      }
      catch (error) { if (!(error instanceof ApiFailure) || ![404,409].includes(error.status)) throw error; }
      this.ledger.move(attempt.claimId, ["PREPARED"], "ABANDONED"); return;
    }
    const response = await this.api.inspect(attempt.claimId);
    if (response.start) return this.uncertain(attempt, response.start, attempt.state === "START_REQUESTED" ? "START_RESPONSE_LOST" : "EXECUTOR_RESTART_UNCERTAIN");
    if (response.claimFenced && attempt.state !== "START_INTENT") { this.ledger.move(attempt.claimId, ["START_REQUESTED", "AMBIGUOUS"], "ABANDONED"); return; }
    this.ledger.move(attempt.claimId, [attempt.state], "AMBIGUOUS");
    throw new Error("Unresolved start identity; executor quarantined");
  }
  async tick(): Promise<boolean> {
    if (!this.ready || !this.sessionId || this.ledger.unfinished().length) throw new Error("Ledger reconciliation required before polling");
    const offers = await this.api.poll(this.sessionId);
    const offer = offers[0]; if (!offer) return false;
    const claim = await this.api.claim(offer.invocationId, randomUUID(), this.sessionId);
    if (claim.invocationId !== offer.invocationId || claim.runId !== offer.runId || claim.deploymentId !== this.ledger.identity.deploymentId) throw new Error("Offer and claim identity mismatch");
    const attempt = this.ledger.prepare(claim, this.sessionId);
    this.localRecordCount++;
    if (this.localRecordCount === RECOVERY_HISTORY_WARNING_AT ||
        this.localRecordCount === RECOVERY_HISTORY_LIMIT ||
        this.localRecordCount === RECOVERY_HISTORY_LIMIT + 1) this.reportLocalCapacity();
    this.fault("after_prepare");
    this.ledger.move(attempt.claimId, ["PREPARED"], "START_REQUESTED");
    this.fault("after_start_requested");
    const response = await this.api.authorize(attempt.claimId, { sessionId: this.sessionId, generation: attempt.generation,
      requestKey: attempt.requestKey, artifactDigest: attempt.artifactDigest, ledgerId: this.ledger.identity.ledgerId });
    this.fault("after_start_response");
    if (response.ledgerId !== this.ledger.identity.ledgerId) throw new Error("Wrong ledger binding");
    if (!response.startAllowed) { await this.uncertain(this.ledger.get(attempt.claimId), response.start, "START_RESPONSE_LOST"); return true; }
    this.validateStart(attempt, response.start);
    this.verifyArtifact();
    this.ledger.move(attempt.claimId, ["START_REQUESTED"], "START_INTENT", response.start.id);
    this.fault("after_start_intent");
    const deadline = Date.parse(response.start.startDeadline);
    if (!Number.isFinite(deadline) || Date.now() >= deadline) { await this.uncertain(this.ledger.get(attempt.claimId), response.start, "START_DEADLINE_EXPIRED"); return true; }
    let body: ReportInput;
    try {
      const result = this.handler({}, {invocationId:attempt.invocationId,outputResource:this.ledger.identity.outputResource});
      if (canonical(result).digest !== canonical(this.writeContract(attempt.invocationId)?receiptIdentity(attempt.invocationId,this.ledger.identity.outputResource!).result:HEALTH_RESULT).digest) throw new Error("Unexpected handler result");
      body = { sessionId: this.sessionId, generation: attempt.generation, outcome: "SUCCEEDED", reason: this.writeContract(attempt.invocationId)?"DEMO_RECEIPT_CREATED":"HEALTH_PING_RETURNED", result };
    } catch { body = { sessionId: this.sessionId, generation: attempt.generation, outcome: "UNKNOWN", reason: "HANDLER_OUTCOME_UNKNOWN" }; }
    this.fault("after_handler");
    this.ledger.move(attempt.claimId, ["START_INTENT"], "RESULT_PENDING", response.start.id, JSON.stringify(body));
    this.fault("after_result_persisted");
    await this.sendPending(this.ledger.get(attempt.claimId));
    return true;
  }
}
