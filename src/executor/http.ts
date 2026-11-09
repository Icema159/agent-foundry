import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutorClaim } from "../generated/prisma/client.js";
import { requireScope, type AuthenticatedContext } from "../identity/identity.js";
import { HttpError, bad, id, bodyObject, jsonBody, send } from "../external-api/http.js";
import { ExecutorProtocol } from "./executor-protocol.js";
import { generation, pollLimit } from "./protocol-validation.js";
import { ExecutorExecution } from "./execution-service.js";
import { handleExecutionRequest } from "./execution-http.js";

function claimDto(claim: ExecutorClaim) {
  return { id: claim.id, invocationId: claim.invocationId, runId: claim.runId, deploymentId: claim.deploymentId,
    generation: claim.generation, status: claim.status, leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
    createdAt: claim.createdAt.toISOString(), updatedAt: claim.updatedAt.toISOString(), closedAt: claim.closedAt?.toISOString() ?? null,
    startAllowed: false, executionAllowed: false };
}

export async function handleExecutorRequest(req: IncomingMessage, res: ServerResponse, url: URL,
  context: AuthenticatedContext, protocol: ExecutorProtocol, execution?: ExecutorExecution) {
  if (execution && await handleExecutionRequest(req, res, url, context, execution)) return;
  const prefix = "/api/v1/executor";
  const inspect = /^\/api\/v1\/executor\/claims\/([^/]+)$/.exec(url.pathname);
  const change = /^\/api\/v1\/executor\/claims\/([^/]+)\/(renew|release)$/.exec(url.pathname);
  if (url.search) throw bad();
  if (![`${prefix}/poll`, `${prefix}/claims`].includes(url.pathname) && !inspect && !change)
    throw new HttpError(404, "NOT_FOUND", "Resource not found");
  if (req.method !== (inspect ? "GET" : "POST")) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  try { requireScope(context, inspect || change ? "executor:lease" : "executor:claim"); }
  catch { throw new HttpError(403, "FORBIDDEN", "Access denied"); }
  if (inspect) {
    const result = await protocol.inspect(context, id(inspect[1]));
    return send(res, 200, { claim: claimDto(result.claim), current: result.current });
  }
  if (change) {
    const body = bodyObject(await jsonBody(req), ["generation", "sessionId"], ["generation"]);
    const sessionId = body.sessionId === undefined ? undefined : id(body.sessionId);
    const claimId = id(change[1]), token = generation(body.generation);
    const result = change[2] === "renew" ? await protocol.renew(context, claimId, token, sessionId) : await protocol.release(context, claimId, token, sessionId);
    return send(res, 200, { claim: claimDto(result) });
  }
  if (url.pathname === `${prefix}/poll`) {
    const body = bodyObject(await jsonBody(req), ["limit", "sessionId"], []);
    return send(res, 200, await protocol.poll(context, pollLimit(body.limit), body.sessionId === undefined ? undefined : id(body.sessionId)));
  }
  const body = bodyObject(await jsonBody(req), ["invocationId", "requestKey", "sessionId"], ["invocationId", "requestKey"]);
  if (typeof body.requestKey !== "string" || !body.requestKey.trim() || body.requestKey.length > 128) throw bad();
  return send(res, 200, { claim: claimDto(await protocol.claim(context, id(body.invocationId), body.requestKey, body.sessionId === undefined ? undefined : id(body.sessionId))) });
}
