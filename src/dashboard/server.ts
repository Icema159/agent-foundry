import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunQueryService } from "../observability/run-query.js";
import type { ApprovalDecision, PendingApproval } from "../persistence/execution-store.js";

export type DashboardServices = {
  runs: Pick<RunQueryService, "listRecent" | "get">;
  listApprovals(): Promise<PendingApproval[]>;
  decideApproval(id: string, decision: ApprovalDecision): Promise<{ taskRunId: string; jobId: string }>;
};

export function createDashboardServer(services: DashboardServices, publicDir: string) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/api/runs") return json(200, await services.runs.listRecent());
      if (request.method === "GET" && pathname === "/api/approvals") return json(200, await services.listApprovals());
      const run = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && run) {
        if (!validId(run[1]!)) return json(400, { error: "Invalid TaskRun ID" });
        const details = await services.runs.get(run[1]!);
        return details ? json(200, details) : json(404, { error: "TaskRun not found" });
      }
      const approval = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
      if (request.method === "POST" && approval) {
        // A custom header and same-origin policy prevent cross-site form submissions.
        if (request.headers["x-foundry-dashboard"] !== "1") return json(403, { error: "Dashboard header required" });
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) return json(403, { error: "Origin not allowed" });
        if (!validId(approval[1]!)) return json(400, { error: "Invalid approval ID" });
        return json(200, await services.decideApproval(approval[1]!, approval[2] === "approve" ? "APPROVED" : "DENIED"));
      }
      if (pathname.startsWith("/api/")) return json(404, { error: "Endpoint not found" });
      if (request.method !== "GET") return json(405, { error: "Method not allowed" });
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/app.css": ["app.css", "text/css"],
      };
      const file = files[pathname];
      if (!file) return json(404, { error: "Not found" });
      const content = await readFile(path.join(publicDir, file[0]));
      response.writeHead(200, { "Content-Type": file[1] });
      response.end(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Approval not found/.test(message)) return json(404, { error: message });
      if (/already decided|not waiting|no longer waiting/.test(message)) return json(409, { error: message });
      console.error("Dashboard request failed:", message);
      json(503, { error: "Service unavailable. Refresh to check current state before retrying." });
    }
  });
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}
