// Decode only fields the fixed runner consumes. Transport JSON never supplies a trusted type.
import { generation } from "../executor/protocol-validation.js";
import { validDemoResource, WRITE_PROFILE } from "../executor/demo-receipt-contract.js";
import type { ReportInput } from "../executor/execution-contract.js";
import type { RecoveryClaim } from "../executor/recovery-contract.js";

function invalid(): never { throw new Error("Invalid executor API response"); }
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) invalid();
  return value;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
function outcome(value: unknown) {
  if (value !== "SUCCEEDED" && value !== "UNKNOWN") invalid();
  return value;
}
function date(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

type SessionReceipt = {
  id: string; deploymentId: string; bindingId: string; artifactDigest: string;
  ledgerId: string; executionProfile: string; outputResource?: string; generation: number;
};
type ClaimReceipt = { id: string; invocationId: string; runId: string; deploymentId: string; generation: number };
export type StartIdentity = {
  id: string; invocationId: string; claimId: string; generation: number; sessionId: string;
  requestKey: string; artifactDigest: string; authorizationDigest: string; startDeadline: string;
  execution?: { profile: typeof WRITE_PROFILE; outputResource: string; target: string };
};
type ResultAck = {
  acknowledged: true; verification: "EXECUTOR_REPORTED"; reportId: string;
  startId: string; digest: string; outcome: ReportInput["outcome"];
};

export function sessionResponse(raw: unknown): SessionReceipt {
  const s = object(object(raw).session);
  if (s.active !== true || (s.outputResource !== undefined && !validDemoResource(s.outputResource))) invalid();
  return { id: id(s.id), deploymentId: id(s.deploymentId), bindingId: id(s.bindingId), artifactDigest: digest(s.artifactDigest),
    generation: generation(s.generation), ledgerId: id(s.ledgerId), executionProfile: id(s.executionProfile), outputResource: s.outputResource };
}

export function pollResponse(raw: unknown) {
  const r = object(raw);
  if (r.startAllowed !== false || !Array.isArray(r.offers) || r.offers.length > 1) invalid();
  return r.offers.map((value: unknown) => {
    const o = object(value);
    if (o.executionAllowed !== false) invalid();
    return { invocationId: id(o.invocationId), runId: id(o.runId) };
  });
}

export function claimResponse(raw: unknown, status: "ACTIVE" | "RELEASED"): ClaimReceipt {
  const c = object(object(raw).claim);
  if (c.startAllowed !== false || c.executionAllowed !== false || c.status !== status) invalid();
  return { id: id(c.id), invocationId: id(c.invocationId), runId: id(c.runId), deploymentId: id(c.deploymentId), generation: generation(c.generation) };
}

function startIdentity(raw: unknown): StartIdentity {
  const s = object(raw);
  let execution: StartIdentity["execution"];
  if (s.execution !== undefined) {
    const e = object(s.execution);
    if (e.profile !== WRITE_PROFILE || !validDemoResource(e.outputResource) || typeof e.target !== "string") invalid();
    execution = { profile: e.profile, outputResource: e.outputResource, target: e.target };
  }
  return { id: id(s.id), invocationId: id(s.invocationId), claimId: id(s.claimId), generation: generation(s.generation),
    sessionId: id(s.sessionId), requestKey: id(s.requestKey), artifactDigest: digest(s.artifactDigest),
    authorizationDigest: digest(s.authorizationDigest), startDeadline: date(s.startDeadline), execution };
}

export function startResponse(raw: unknown) {
  const r = object(raw);
  if (typeof r.startAllowed !== "boolean" || r.executionAllowed !== r.startAllowed) invalid();
  return { startAllowed: r.startAllowed, start: startIdentity(r.start), ledgerId: id(r.ledgerId) };
}
export function inspectedStart(raw: unknown) {
  const r = object(raw);
  if (r.startAllowed !== false || r.executionAllowed !== false || typeof r.claimFenced !== "boolean") invalid();
  if (r.startCommitted === false && r.start === null) return { start: null, claimFenced: r.claimFenced };
  if (r.startCommitted !== true || !r.claimFenced) invalid();
  return { start: startIdentity(r.start), claimFenced: true };
}
export function acknowledgement(raw: unknown): ResultAck {
  const a = object(raw);
  if (a.acknowledged !== true || a.verification !== "EXECUTOR_REPORTED") invalid();
  return { acknowledged: true, verification: a.verification, reportId: id(a.reportId), startId: id(a.startId), digest: digest(a.digest), outcome: outcome(a.outcome) };
}

function recoveryClaim(raw: unknown): RecoveryClaim {
  const c = object(raw);
  if (typeof c.reportCredentialCurrent !== "boolean") invalid();
  let start: RecoveryClaim["start"] = null;
  if (c.start !== null) {
    const s = object(c.start);
    if (!Array.isArray(s.reports)) invalid();
    start = { id: id(s.id), requestKey: id(s.requestKey), reports: s.reports.map((rawReport: unknown) => {
      const r = object(rawReport);
      return { id: id(r.id), digest: digest(r.digest), outcome: outcome(r.outcome) };
    }) };
  }
  return { id: id(c.id), invocationId: id(c.invocationId), sessionId: id(c.sessionId), generation: generation(c.generation),
    artifactDigest: digest(c.artifactDigest), status: id(c.status), reportCredentialCurrent: c.reportCredentialCurrent, start };
}
export function recoveryPage(raw: unknown) {
  const r = object(raw);
  if (r.executionAllowed !== false || !Array.isArray(r.claims) || r.claims.length > 100 || typeof r.hasMore !== "boolean") invalid();
  const claims = r.claims.map(recoveryClaim);
  if (r.hasMore ? id(r.nextCursor) !== claims.at(-1)?.id : r.nextCursor !== null) invalid();
  return { claims, nextCursor: r.hasMore ? id(r.nextCursor) : undefined };
}


// Local result evidence crosses the SQLite/JSON boundary again on recovery.
export function localReport(raw: unknown): ReportInput {
  const r = object(raw);
  if (typeof r.reason !== "string") invalid();
  return { sessionId: id(r.sessionId), generation: generation(r.generation), outcome: outcome(r.outcome),
    reason: r.reason, ...(r.result !== undefined ? { result: r.result } : {}) };
}
