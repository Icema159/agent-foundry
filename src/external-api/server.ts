import { createServer } from "node:http";
import { CredentialAuthenticator, IdentityError, requireScope, type Scope } from "../identity/identity.js";
import { InvocationConflict, InvocationService } from "../invocation/invocation-service.js";
import { ValidationError } from "../registry/validation.js";
import { HttpError, bad, id, bodyObject, jsonBody, send } from "./http.js";
import { ExecutorProtocol, ExecutorConflict } from "../executor/executor-protocol.js";
import { handleExecutorRequest } from "../executor/http.js";
import { ExecutorExecution } from "../executor/execution-service.js";
import { safeReportedResult } from "../executor/execution-contract.js";

function runDto(run: { id: string; versionId: string; status: string; createdAt: Date; completedAt: Date | null }) {
  return { id: run.id, versionId: run.versionId, status: run.status, createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null };
}
function invocationDto(inv: { id: string; runId: string; versionId: string; toolId: string; deploymentId: string; grantId: string | null; status: string; reason: string; createdAt: Date; updatedAt: Date }) {
  return { id: inv.id, runId: inv.runId, versionId: inv.versionId, toolId: inv.toolId, deploymentId: inv.deploymentId, grantId: inv.grantId,
    status: inv.status, reason: inv.reason, executionAllowed: false, createdAt: inv.createdAt.toISOString(), updatedAt: inv.updatedAt.toISOString() };
}
function eventDto(event: { sequence: bigint; invocationId: string; kind: string; status: string; reason: string; createdAt: Date;
  claimId?: string | null; claimGeneration?: number | null; leaseExpiresAt?: Date | null; startId?: string | null; reportId?: string | null; executionResult?: unknown; findingId?: string | null; externalApprovalId?: string | null }) {
  return { cursor: event.sequence.toString(), invocationId: event.invocationId, kind: event.kind, status: event.status, reason: event.reason, createdAt: event.createdAt.toISOString(),
    ...(event.claimId && event.claimGeneration && event.leaseExpiresAt ? { claim: { id: event.claimId, generation: event.claimGeneration, leaseExpiresAt: event.leaseExpiresAt.toISOString() } } : {}),
    ...(event.externalApprovalId ? {approval:{id:event.externalApprovalId}} : {}),
    ...(event.findingId ? { finding: { id: event.findingId, verification: "OPERATOR_FINDING_NOT_VERIFIED" } } : {}),
    ...(event.startId ? { execution: { startId: event.startId, ...(event.reportId ? { reportId: event.reportId, verification: "EXECUTOR_REPORTED" } : {}),
      ...(event.status === "SUCCEEDED" && safeReportedResult(event.executionResult,event.invocationId) ? { result: safeReportedResult(event.executionResult,event.invocationId) } : {}) } } : {}) };
}
function conflict(error: InvocationConflict): HttpError {
  const known: Record<string, [string, string]> = {
    "Idempotency key already used with different request": ["IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different request"],
    "External run is closed": ["RUN_CLOSED", "External run is closed"],
    "External run already has an active invocation": ["ACTIVE_INVOCATION", "External run already has an unresolved invocation"],
    "External run has an unresolved invocation": ["ACTIVE_INVOCATION", "External run already has an unresolved invocation"],
    "Invalid invocation transition": ["INVALID_TRANSITION", "Invocation cannot transition from its current state"],
  };
  const [code, message] = known[error.message] ?? ["CONFLICT", "Request conflicts with current state"];
  return new HttpError(409, code, message);
}

/** A separate API; listen only on loopback or behind a trusted TLS terminator. */
export function createExternalApiServer(services: { auth: CredentialAuthenticator; invocations: InvocationService; executors?: ExecutorProtocol; execution?: ExecutorExecution }) {
  async function withApproval(context:import("../identity/identity.js").AuthenticatedContext,inv:Parameters<typeof invocationDto>[0]){
    const approval=await services.invocations.approvalStatus(context,inv.id);
    return {...invocationDto(inv),...(approval?{approval}: {})};
  }
  const server = createServer(async (req, res) => {
    try {
      const headers = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === "authorization");
      const token = headers.length === 1 ? /^Bearer (af_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] : undefined;
      if (!token) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required");
      let context;
      try { context = await services.auth.authenticate(token); }
      catch (error) { if (error instanceof IdentityError) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required"); throw error; }
      const url = new URL(req.url ?? "/", "http://localhost"), path = url.pathname;
      if (path.startsWith("/api/v1/executor/")) {
        if (context.principalType !== "EXECUTOR") throw new HttpError(403, "FORBIDDEN", "Access denied");
        if (!services.executors) throw new HttpError(404, "NOT_FOUND", "Resource not found");
        return await handleExecutorRequest(req, res, url, context, services.executors, services.execution);
      }
      if (context.principalType !== "AGENT") throw new HttpError(403, "FORBIDDEN", "Access denied");
      const pathRun = /^\/api\/v1\/external\/runs\/([^/]+)$/.exec(path);
      const pathInvocations = /^\/api\/v1\/external\/runs\/([^/]+)\/invocations$/.exec(path);
      const pathHistory = /^\/api\/v1\/external\/runs\/([^/]+)\/history$/.exec(path);
      const pathClose = /^\/api\/v1\/external\/runs\/([^/]+)\/close$/.exec(path);
      const pathInvocation = /^\/api\/v1\/external\/invocations\/([^/]+)$/.exec(path);
      const pathCancel = /^\/api\/v1\/external\/invocations\/([^/]+)\/cancel$/.exec(path);
      const matching = path === "/api/v1/external/runs" || pathRun || pathInvocations || pathHistory || pathClose || pathInvocation || pathCancel;
      if (!matching) throw new HttpError(404, "NOT_FOUND", "Resource not found");
      const method = pathRun || pathHistory || pathInvocation ? "GET" : "POST";
      if (req.method !== method) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      const scope: Scope = path === "/api/v1/external/runs" || pathRun || pathClose ? "run:manage" : "invocation:request";
      try { requireScope(context, scope); } catch { throw new HttpError(403, "FORBIDDEN", "Access denied"); }
      if (!pathHistory && url.search) throw bad();
      if (path === "/api/v1/external/runs") {
        const body = bodyObject(await jsonBody(req), ["versionId"], ["versionId"]);
        return send(res, 201, { run: runDto(await services.invocations.openRun(context, id(body.versionId))) });
      }
      if (pathRun) return send(res, 200, { run: runDto(await services.invocations.getRun(context, id(pathRun[1]))) });
      if (pathInvocations) {
        const runId = id(pathInvocations[1]);
        const body = bodyObject(await jsonBody(req), ["idempotencyKey", "toolId", "deploymentId", "grantId", "arguments"], ["idempotencyKey", "toolId", "deploymentId", "arguments"]);
        if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 128) throw bad();
        const invocation = await services.invocations.acceptInvocation(context, { runId, idempotencyKey: body.idempotencyKey,
          toolId: id(body.toolId), deploymentId: id(body.deploymentId), ...(body.grantId !== undefined ? { grantId: id(body.grantId) } : {}), arguments: body.arguments });
        return send(res, 200, { invocation: await withApproval(context,invocation) });
      }
      if (pathInvocation) return send(res,200,{invocation:await withApproval(context,await services.invocations.getInvocation(context,id(pathInvocation[1])))});
      if (pathCancel) {
        bodyObject(await jsonBody(req), [], []);
        const invocation = await services.invocations.getInvocation(context, id(pathCancel[1]));
        return send(res, 200, { invocation: invocationDto(await services.invocations.cancelBlocked(context, invocation.runId, invocation.id)) });
      }
      if (pathClose) { bodyObject(await jsonBody(req), [], []); return send(res, 200, { run: runDto(await services.invocations.closeRun(context, id(pathClose[1]))) }); }
      if (pathHistory) {
        if ([...url.searchParams.keys()].some(key => !["after", "limit"].includes(key)) || url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) throw bad();
        const afterText = url.searchParams.get("after") ?? "0", limitText = url.searchParams.get("limit") ?? "50";
        if (!/^(0|[1-9]\d{0,18})$/.test(afterText) || !/^[1-9]\d{0,2}$/.test(limitText)) throw bad();
        const after = BigInt(afterText), limit = Number(limitText);
        if (after > 9223372036854775807n || limit > 100) throw bad();
        let page;
        try { page = await services.invocations.historyPage(context, id(pathHistory[1]), after, limit); }
        catch (error) { if (error instanceof InvocationConflict) throw bad(); throw error; }
        return send(res, 200, { events: page.events.map(eventDto), nextCursor: page.events.at(-1)?.sequence.toString() ?? (after ? after.toString() : null), hasMore: page.hasMore });
      }
    } catch (error) {
      const failure = error instanceof HttpError ? error : error instanceof IdentityError ? new HttpError(404, "NOT_FOUND", "Resource not found") :
        error instanceof ValidationError ? bad() : error instanceof InvocationConflict ? conflict(error) :
        error instanceof ExecutorConflict ? new HttpError(409, error.code, "Executor request conflicts with current state") :
        new HttpError(503, "SERVICE_UNAVAILABLE", "Service unavailable");
      if (failure.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
      if (!res.headersSent) send(res, failure.status, { error: { code: failure.code, message: failure.message } });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 20000;
  return server;
}
