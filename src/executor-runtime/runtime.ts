import { randomUUID } from "node:crypto";
import { canonical } from "../registry/validation.js";
import { EXECUTION_PROFILE, HEALTH_RESULT, reportIdentity, type ReportInput } from "../executor/execution-contract.js";
import { WRITE_PROFILE, receiptIdentity } from "../executor/demo-receipt-contract.js";
import { healthPing } from "./health-ping.js";
import { type ExecutorClient, ApiFailure } from "./api-client.js";
import { StartLedger, type Attempt } from "./ledger.js";

export type FaultPoint = "after_prepare" | "after_start_requested" | "after_start_response" | "after_start_intent" | "after_handler" | "after_result_persisted" | "after_result_ack";
/** Fixed-handler controller. Injection points exist for deterministic tests, never CLI configuration. */
export class IsolatedExecutorRuntime {
  private sessionId = "";
  constructor(private readonly ledger: StartLedger, private readonly api: ExecutorClient, private readonly verifyArtifact: () => void,
    private readonly fault: (point: FaultPoint) => void = () => {}, private readonly handler: (args:unknown,context:{invocationId:string;outputResource?:string})=>unknown = healthPing) {}
  async initialize() {
    this.verifyArtifact();
    const identity = this.ledger.identity;
    const response = await this.api.call("/sessions", { bindingId: identity.bindingId, sessionKey: randomUUID(), artifactDigest: identity.artifactDigest,
      ledgerId: identity.ledgerId, executionProfile: identity.executionProfile??EXECUTION_PROFILE, ledgerProofDigest: this.ledger.proofDigest, ...(identity.outputResource?{outputResource:identity.outputResource}:{}) });
    if (!response.session.active || response.session.deploymentId !== identity.deploymentId || response.session.bindingId !== identity.bindingId ||
      response.session.artifactDigest !== identity.artifactDigest || response.session.ledgerId !== identity.ledgerId ||
      (identity.executionProfile===WRITE_PROFILE&&(response.session.executionProfile!==WRITE_PROFILE||response.session.outputResource!==identity.outputResource))) throw new Error("Session installation mismatch");
    this.sessionId = response.session.id;
    await this.checkContinuity();
    for (const attempt of this.ledger.unfinished()) await this.recover(attempt);
  }
  private writeContract(invocationId:string){return this.ledger.identity.executionProfile===WRITE_PROFILE?{invocationId,outputResource:this.ledger.identity.outputResource!}:undefined;}
  private async checkContinuity() {
    const local = this.ledger.all(), seen = new Set<string>();
    let after: string | undefined, count = 0;
    do {
      const page = await this.api.call("/recovery", { sessionId: this.sessionId, ledgerProofDigest: this.ledger.proofDigest, ...(after ? { after } : {}) });
      if (!Array.isArray(page.claims) || page.claims.length > 100 || count + page.claims.length > 10000) throw new Error("Invalid recovery inventory");
      for (const claim of page.claims as import("../executor/recovery-contract.js").RecoveryClaim[]) {
        if (seen.has(claim.id)) throw new Error("Repeated recovery cursor"); seen.add(claim.id); count++;
        const attempt = local.find(a => a.claimId === claim.id);
        if (!attempt) { if (claim.start) throw new Error("Stale ledger: authorized start missing locally"); continue; }
        if (attempt.invocationId !== claim.invocationId || attempt.generation !== claim.generation || attempt.sessionId !== claim.sessionId ||
          attempt.artifactDigest !== claim.artifactDigest) throw new Error("Ledger claim identity mismatch");
        const states = ["PREPARED","START_REQUESTED","START_INTENT","RESULT_PENDING","ACKED","AMBIGUOUS","ABANDONED"];
        if (!states.includes(attempt.state)) throw new Error("Invalid ledger state");
        if (claim.start) {
          if (["PREPARED","ABANDONED"].includes(attempt.state) || attempt.requestKey !== claim.start.requestKey ||
            (attempt.startId && attempt.startId !== claim.start.id)) throw new Error("Start history contradicts ledger");
          if (claim.start.reports.length && !attempt.report) throw new Error("Stale ledger: committed report missing locally");
        } else if (attempt.startId || ["START_INTENT","RESULT_PENDING","ACKED"].includes(attempt.state)) throw new Error("Local start missing from Foundry");
        if (["RESULT_PENDING","ACKED"].includes(attempt.state)) {
          const body = JSON.parse(attempt.report!);
          if (!claim.start || attempt.startId !== claim.start.id || body.sessionId !== attempt.sessionId || body.generation !== attempt.generation) throw new Error("Ledger result identity mismatch");
          const digest = reportIdentity(body,this.writeContract(attempt.invocationId)).digest, known = claim.start.reports.find(r => r.digest === digest);
          if (claim.start.reports.length && !known) throw new Error("Conflicting persisted result");
          if (attempt.state === "ACKED") {
            const ack = JSON.parse(attempt.ack!);
            if (!known || !ack.acknowledged || ack.reportId !== known.id || ack.startId !== claim.start.id || ack.digest !== digest || ack.outcome !== known.outcome) throw new Error("Ledger acknowledgement mismatch");
          } else if (!claim.reportCredentialCurrent) throw new Error("Pending result needs original credential; operator recovery required");
        }
      }
      if (page.hasMore && (typeof page.nextCursor !== "string" || page.nextCursor === after || !seen.has(page.nextCursor))) throw new Error("Invalid recovery cursor");
      after = page.hasMore ? page.nextCursor : undefined;
    } while (after);
    if (local.some(a => !seen.has(a.claimId))) throw new Error("Local claim missing from Foundry; recovery blocked");
  }
  private validateStart(attempt: Attempt, start: any) {
    const write=this.writeContract(attempt.invocationId);
    if(write){if(start?.execution?.profile!==WRITE_PROFILE||start.execution.outputResource!==write.outputResource||start.execution.target!==receiptIdentity(write.invocationId,write.outputResource).path)throw new Error("WRITE permit resource mismatch");}
    else if(start?.execution)throw new Error("Unexpected WRITE permit in READ_ONLY installation");
    if (!start || start.invocationId !== attempt.invocationId || start.claimId !== attempt.claimId || start.generation !== attempt.generation ||
      start.sessionId !== attempt.sessionId || start.requestKey !== attempt.requestKey || start.artifactDigest !== attempt.artifactDigest || typeof start.id !== "string") throw new Error("Authorized start identity mismatch");
  }
  private async sendPending(attempt: Attempt) {
    const body = JSON.parse(attempt.report!) as ReportInput;
    const response = await this.api.call(`/starts/${attempt.startId}/results`, body);
    if (!response.acknowledged || response.startId !== attempt.startId || response.digest !== reportIdentity(body,this.writeContract(attempt.invocationId)).digest || response.outcome !== body.outcome ||
      typeof response.reportId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(response.reportId) || response.verification !== "EXECUTOR_REPORTED") throw new Error("Result acknowledgement mismatch");
    this.fault("after_result_ack");
    this.ledger.move(attempt.claimId, ["RESULT_PENDING"], "ACKED", attempt.startId, null, JSON.stringify(response));
  }
  private async uncertain(attempt: Attempt, start: any, reason: "START_RESPONSE_LOST" | "EXECUTOR_RESTART_UNCERTAIN" | "START_DEADLINE_EXPIRED") {
    this.validateStart(attempt, start);
    const body: ReportInput = { sessionId: attempt.sessionId, generation: attempt.generation, outcome: "UNKNOWN", reason };
    this.ledger.move(attempt.claimId, ["START_REQUESTED", "START_INTENT", "AMBIGUOUS"], "RESULT_PENDING", start.id, JSON.stringify(body));
    await this.sendPending(this.ledger.get(attempt.claimId));
  }
  private async recover(attempt: Attempt) {
    if (attempt.state === "RESULT_PENDING") return this.sendPending(attempt);
    if (attempt.state === "PREPARED") {
      try { await this.api.call(`/claims/${attempt.claimId}/release`, { generation: attempt.generation, sessionId: attempt.sessionId }); }
      catch (error) { if (!(error instanceof ApiFailure) || ![404,409].includes(error.status)) throw error; }
      this.ledger.move(attempt.claimId, ["PREPARED"], "ABANDONED"); return;
    }
    const response = await this.api.call(`/claims/${attempt.claimId}/start`, undefined, "GET");
    if (response.startCommitted) return this.uncertain(attempt, response.start, attempt.state === "START_REQUESTED" ? "START_RESPONSE_LOST" : "EXECUTOR_RESTART_UNCERTAIN");
    if (response.claimFenced && attempt.state !== "START_INTENT") { this.ledger.move(attempt.claimId, ["START_REQUESTED", "AMBIGUOUS"], "ABANDONED"); return; }
    this.ledger.move(attempt.claimId, [attempt.state], "AMBIGUOUS");
    throw new Error("Unresolved start identity; executor quarantined");
  }
  async tick(): Promise<boolean> {
    if (!this.sessionId || this.ledger.unfinished().length) throw new Error("Ledger reconciliation required before polling");
    const polled = await this.api.call("/poll", { limit: 1, sessionId: this.sessionId });
    const offer = polled.offers[0]; if (!offer) return false;
    const receipt = await this.api.call("/claims", { invocationId: offer.invocationId, requestKey: randomUUID(), sessionId: this.sessionId });
    const attempt = this.ledger.prepare(receipt.claim, this.sessionId);
    this.fault("after_prepare");
    this.ledger.move(attempt.claimId, ["PREPARED"], "START_REQUESTED");
    this.fault("after_start_requested");
    const response = await this.api.call(`/claims/${attempt.claimId}/authorize-start`, { sessionId: this.sessionId, generation: attempt.generation,
      requestKey: attempt.requestKey, artifactDigest: attempt.artifactDigest, ledgerId: this.ledger.identity.ledgerId });
    this.fault("after_start_response");
    if (!response.startAllowed) { await this.uncertain(this.ledger.get(attempt.claimId), response.start, "START_RESPONSE_LOST"); return true; }
    this.validateStart(attempt, response.start);
    if (response.ledgerId !== this.ledger.identity.ledgerId) throw new Error("Wrong ledger binding");
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
