export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super("Executor API request failed"); }
}
export interface ExecutorClient { call(path: string, body?: unknown, method?: string): Promise<any>; }
export class HttpExecutorClient implements ExecutorClient {
  constructor(private readonly origin: string, private readonly secret: string) {}
  async call(path: string, body?: unknown, method = "POST") {
    const response = await fetch(this.origin + "/api/v1/executor" + path, { method, headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(10000), redirect: "error" });
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 131072) { await reader.cancel(); throw new Error("API response exceeds limit"); } chunks.push(chunk.value); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) throw new ApiFailure(response.status, /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error.code : "API_ERROR");
    return value;
  }
}
