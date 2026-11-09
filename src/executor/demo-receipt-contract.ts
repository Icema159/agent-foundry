import { createHash } from "node:crypto";
export const WRITE_PROFILE = "docker-demo-receipt-v1";
export const WRITE_HANDLER = "write_demo_receipt.v1";
export const WRITE_MODE = "DEMO_RECEIPT_WRITE_V1";
export function validDemoResource(value: unknown): value is string {
  return typeof value === "string" && /^foundry:demo-output:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
export function receiptIdentity(invocationId:string,resource:string){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(invocationId)||!validDemoResource(resource))throw Error("Invalid trusted receipt identity");
  const path=`receipt-${invocationId}.txt`,content=`Agent Foundry controlled receipt\nInvocation: ${invocationId}\nResource: ${resource}\n`;
  const contentDigest=createHash("sha256").update(content).digest("hex");
  return {path,content,result:{tool:"write_demo_receipt",version:1,invocationId,resource,path,contentDigest}};
}
