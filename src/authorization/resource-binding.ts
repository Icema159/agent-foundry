import { WRITE_HANDLER } from "../executor/demo-receipt-contract.js";
import { canonical } from "../registry/validation.js";

export const RESOURCE_FREE_RESOURCE = "foundry:resource-free:v1";
export const RESOURCE_FREE_MODE = "RESOURCE_FREE_READ_ONLY_V1";
export const RESOURCE_FREE_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/** Deliberately no paths, URLs, selectors, aliases, coercion or caller-chosen resources. */
export function isResourceFreeReadOnly(tool: { declaredProfile: string; inputSchema: unknown }, args: unknown): boolean {
  return tool.declaredProfile === "READ_ONLY" &&
    canonical(tool.inputSchema).digest === canonical(RESOURCE_FREE_SCHEMA).digest &&
    canonical(args).digest === canonical({}).digest;
}

export function isDemoReceiptWrite(tool:{name:string;handlerId:string;declaredProfile:string;inputSchema:unknown},args:unknown){
  return tool.name==="write_demo_receipt"&&tool.handlerId===WRITE_HANDLER&&tool.declaredProfile==="WRITE"&&
    canonical(tool.inputSchema).digest===canonical(RESOURCE_FREE_SCHEMA).digest&&canonical(args).digest===canonical({}).digest;
}

export function grantDigest(grant: { id: string; ownerId: string; versionId: string; toolId: string; deploymentId: string;
  reviewedProfile: string; allowedResources: string[]; issuedByPrincipalId: string }): string {
  return canonical({ id: grant.id, ownerId: grant.ownerId, versionId: grant.versionId, toolId: grant.toolId,
    deploymentId: grant.deploymentId, reviewedProfile: grant.reviewedProfile, allowedResources: grant.allowedResources,
    issuedByPrincipalId: grant.issuedByPrincipalId }).digest;
}

export function deploymentDigest(deployment: { id: string; ownerId: string; name: string; environment: string }): string {
  return canonical({ id: deployment.id, ownerId: deployment.ownerId, name: deployment.name, environment: deployment.environment }).digest;
}
