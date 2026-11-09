import { receiptIdentity } from "./demo-receipt-contract.js";
import { canonical, ValidationError } from "../registry/validation.js";

export const HEALTH_HANDLER = "health_ping.v1";
export const EXECUTION_PROFILE = "docker-health-ping-v1";
export const HEALTH_RESULT = { ok: true, tool: "health_ping", version: 1 } as const;
export const unknownReasons = ["START_RESPONSE_LOST", "EXECUTOR_RESTART_UNCERTAIN", "HANDLER_OUTCOME_UNKNOWN", "START_DEADLINE_EXPIRED"] as const;
export type ReportInput = { sessionId: string; generation: number; outcome: "SUCCEEDED" | "UNKNOWN"; reason: string; result?: unknown };
export function reportIdentity(input: ReportInput, write?:{invocationId:string;outputResource:string}) {
  if (input.outcome === "SUCCEEDED") {
    if (input.reason !== (write?"DEMO_RECEIPT_CREATED":"HEALTH_PING_RETURNED") || canonical(input.result).digest !== canonical(write?receiptIdentity(write.invocationId,write.outputResource).result:HEALTH_RESULT).digest) throw new ValidationError("Invalid health result");
  } else if (input.outcome !== "UNKNOWN" || input.result !== undefined || !unknownReasons.includes(input.reason as any)) throw new ValidationError("Invalid uncertain outcome");
  return canonical({ sessionId: input.sessionId, generation: input.generation, outcome: input.outcome, reason: input.reason, result: input.result ?? null });
}

export function safeReportedResult(value:unknown,invocationId:string){
  try{if(canonical(value).digest===canonical(HEALTH_RESULT).digest)return HEALTH_RESULT;
    const v=value as {invocationId?:unknown;resource?:unknown};
    if(v.invocationId!==invocationId||typeof v.resource!=="string")return undefined;
    const expected=receiptIdentity(invocationId,v.resource).result;
    return canonical(value).digest===canonical(expected).digest?expected:undefined;
  }catch{return undefined;}
}
