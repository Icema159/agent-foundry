import "dotenv/config";
import { readFileSync, statSync } from "node:fs";
import { createPrismaClient } from "./persistence/prisma-execution-store.js";
import { CredentialAuthenticator } from "./identity/identity.js";
import { PrismaIdentityStore } from "./identity/prisma-identity-store.js";
import { OperatorReconciliation } from "./reconciliation/operator-service.js";

async function main(){
  const [action,id,...flags]=process.argv.slice(2), options=new Map<string,string>();
  if(!["inspect","refresh","record"].includes(action??"")||!id)throw Error("Usage: reconcile inspect|refresh|record INVOCATION_ID [--request-key KEY --basis-sequence N --decision RETAIN_UNKNOWN|CONFLICTING_EVIDENCE|RECOVERY_BLOCKED --reason TEXT --evidence-file PATH]");
  for(let n=0;n<flags.length;n+=2){const key=flags[n]!,value=flags[n+1];if(!["--request-key","--basis-sequence","--decision","--reason","--evidence-file"].includes(key)||!value||options.has(key))throw Error("Invalid options");options.set(key,value);}
  if(action!=="record"&&options.size)throw Error("Inspection takes no decision options");
  const file=process.env.FOUNDRY_OPERATOR_CREDENTIAL_FILE;
  if(!file||!statSync(file).isFile()||(statSync(file).mode&0o077)!==0)throw Error("Use a protected 0600/0400 FOUNDRY_OPERATOR_CREDENTIAL_FILE");
  const db=createPrismaClient(process.env.DATABASE_URL!);
  try{
    const context=await new CredentialAuthenticator(new PrismaIdentityStore(db)).authenticate(readFileSync(file,"utf8").trim()),service=new OperatorReconciliation(db);
    const evidenceFile=options.get("--evidence-file");
    if(evidenceFile&&statSync(evidenceFile).size>65536)throw Error("Evidence reference file exceeds limit");
    const result=action==="record"?await service.record(context,id,{requestKey:options.get("--request-key")!,basisSequence:options.get("--basis-sequence")!,decision:options.get("--decision")!,reason:options.get("--reason")!,evidence:evidenceFile?JSON.parse(readFileSync(evidenceFile,"utf8")):[]}):await service[action as "inspect"|"refresh"](context,id);
    console.log(JSON.stringify(result,(_key,value)=>typeof value==="bigint"?value.toString():value,2));
  }finally{await db.$disconnect();}
}
void main().catch(error=>{console.error(error instanceof Error&&/^(Usage:|Invalid options|Inspection takes|Use a protected|Evidence reference)/.test(error.message)?error.message:"Reconciliation rejected; check identity, scope, ownership and current evidence");process.exitCode=1;});
