import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutorStart } from "../generated/prisma/client.js";
import { requireScope, type AuthenticatedContext } from "../identity/identity.js";
import { bad, bodyObject, HttpError, id, jsonBody, send } from "../external-api/http.js";
import { ExecutorExecution } from "./execution-service.js";
import { generation } from "./protocol-validation.js";

function startDto(start: ExecutorStart) {
  return { id: start.id, invocationId: start.invocationId, claimId: start.claimId, generation: start.generation, sessionId: start.sessionId,
    requestKey: start.requestKey, authorizationDigest: start.authorizationDigest, artifactDigest: start.artifactDigest, startDeadline: start.startDeadline.toISOString() };
}
export async function handleExecutionRequest(req: IncomingMessage, res: ServerResponse, url: URL, context: AuthenticatedContext, execution: ExecutorExecution): Promise<boolean> {
  const recovery = url.pathname === "/api/v1/executor/recovery";
  const session = url.pathname === "/api/v1/executor/sessions";
  const start = /^\/api\/v1\/executor\/claims\/([^/]+)\/authorize-start$/.exec(url.pathname);
  const inspect = /^\/api\/v1\/executor\/claims\/([^/]+)\/start$/.exec(url.pathname);
  const report = /^\/api\/v1\/executor\/starts\/([^/]+)\/results$/.exec(url.pathname);
  if (!recovery && !session && !start && !inspect && !report) return false;
  if (url.search) throw bad();
  if (req.method !== (inspect ? "GET" : "POST")) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  try { requireScope(context, session ? "executor:session" : start ? "executor:start" : "executor:report"); }
  catch { throw new HttpError(403, "FORBIDDEN", "Access denied"); }
  if (recovery) {
    const body = bodyObject(await jsonBody(req), ["sessionId", "ledgerProofDigest", "after"], ["sessionId", "ledgerProofDigest"]);
    send(res, 200, await execution.recoveryInventory(context, id(body.sessionId), id(body.ledgerProofDigest), body.after === undefined ? undefined : id(body.after)));
  } else if (session) {
    const body = bodyObject(await jsonBody(req), ["bindingId", "sessionKey", "artifactDigest", "ledgerId", "executionProfile", "ledgerProofDigest", "outputResource"], ["bindingId", "sessionKey", "artifactDigest", "ledgerId", "executionProfile", "ledgerProofDigest"]);
    const s = await execution.registerSession(context, { bindingId: id(body.bindingId), sessionKey: id(body.sessionKey), artifactDigest: id(body.artifactDigest), ledgerId: id(body.ledgerId), executionProfile: id(body.executionProfile), ledgerProofDigest: id(body.ledgerProofDigest), ...(body.outputResource!==undefined?{outputResource: typeof body.outputResource==="string"?body.outputResource: (()=>{throw bad();})()}:{}) });
    send(res, 200, { session: { id: s.id, deploymentId: s.deploymentId, bindingId: s.bindingId, artifactDigest: s.artifactDigest, ledgerId: s.ledgerId, executionProfile: s.executionProfile,
      ...(body.outputResource?{outputResource:body.outputResource}:{}), generation: s.generation, active: s.active, expiresAt: s.expiresAt.toISOString() } });
  } else if (start) {
    const body = bodyObject(await jsonBody(req), ["sessionId", "generation", "requestKey", "artifactDigest", "ledgerId"], ["sessionId", "generation", "requestKey", "artifactDigest", "ledgerId"]);
    if (typeof body.requestKey !== "string") throw bad();
    const result = await execution.authorizeStart(context, id(start[1]), { sessionId: id(body.sessionId), generation: generation(body.generation), requestKey: body.requestKey,
      artifactDigest: id(body.artifactDigest), ledgerId: id(body.ledgerId) });
    send(res, 200, { start: {...startDto(result.start),...(result.execution?{execution:result.execution}: {})}, ledgerId: result.ledgerId, startAllowed: result.startAllowed, executionAllowed: result.startAllowed });
  } else if (inspect) {
    const result = await execution.inspectStart(context, id(inspect[1]));
    send(res, 200, { start: result.start ? {...startDto(result.start),...(result.execution?{execution:result.execution}: {})} : null, startCommitted: !!result.start, claimFenced: result.claimFenced, startAllowed: false, executionAllowed: false });
  } else if (report) {
    const body = bodyObject(await jsonBody(req), ["sessionId", "generation", "outcome", "reason", "result"], ["sessionId", "generation", "outcome", "reason"]);
    if (!["SUCCEEDED", "UNKNOWN"].includes(body.outcome as string) || typeof body.reason !== "string") throw bad();
    const result = await execution.report(context, id(report[1]), { sessionId: id(body.sessionId), generation: generation(body.generation),
      outcome: body.outcome as "SUCCEEDED" | "UNKNOWN", reason: body.reason, ...(body.result !== undefined ? { result: body.result } : {}) });
    send(res, 200, { acknowledged: true, reportId: result.id, startId: result.startId, digest: result.digest, outcome: result.outcome, verification: "EXECUTOR_REPORTED" });
  }
  return true;
}
