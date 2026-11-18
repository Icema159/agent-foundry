import type { ReportInput } from "../executor/execution-contract.js";
import type { SessionInput, StartInput } from "../executor/execution-service.js";
import { acknowledgement, claimResponse, inspectedStart, isObject, pollResponse, recoveryPage, sessionResponse, startResponse } from "./response.js";

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super("Executor API request failed"); }
}
export interface ExecutorClient { call(path: string, body?: unknown, method?: string): Promise<unknown>; }
export class HttpExecutorClient implements ExecutorClient {
  constructor(private readonly origin: string, private readonly secret: string) {}
  async call(path: string, body?: unknown, method = "POST"): Promise<unknown> {
    const response = await fetch(this.origin + "/api/v1/executor" + path, { method, headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.body) throw new Error("Empty executor API response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 131072) { await reader.cancel(); throw new Error("API response exceeds limit"); } chunks.push(chunk.value); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      const code = isObject(value) && isObject(value.error) ? value.error.code : undefined;
      throw new ApiFailure(response.status, typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "API_ERROR");
    }
    return value;
  }
}

// Routes and their decoders are paired here so callers only receive validated DTOs.
export class ExecutorApi {
  constructor(private readonly transport: ExecutorClient) {}

  async register(body: SessionInput) {
    return sessionResponse(await this.transport.call("/sessions", body));
  }
  async inventory(sessionId: string, ledgerProofDigest: string, after?: string) {
    return recoveryPage(await this.transport.call("/recovery", { sessionId, ledgerProofDigest, ...(after ? { after } : {}) }));
  }
  async poll(sessionId: string) {
    return pollResponse(await this.transport.call("/poll", { sessionId, limit: 1 }));
  }
  async claim(invocationId: string, requestKey: string, sessionId: string) {
    return claimResponse(await this.transport.call("/claims", { invocationId, requestKey, sessionId }), "ACTIVE");
  }
  async release(claimId: string, generation: number, sessionId: string) {
    return claimResponse(await this.transport.call(`/claims/${claimId}/release`, { generation, sessionId }), "RELEASED");
  }
  async inspect(claimId: string) {
    return inspectedStart(await this.transport.call(`/claims/${claimId}/start`, undefined, "GET"));
  }
  async authorize(claimId: string, body: StartInput) {
    return startResponse(await this.transport.call(`/claims/${claimId}/authorize-start`, body));
  }
  async report(startId: string, body: ReportInput) {
    return acknowledgement(await this.transport.call(`/starts/${startId}/results`, body));
  }
}
