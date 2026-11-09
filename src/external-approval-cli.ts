import "dotenv/config";
import {readFileSync,statSync}from"node:fs";
import {createPrismaClient}from"./persistence/prisma-execution-store.js";
import {CredentialAuthenticator}from"./identity/identity.js";
import {PrismaIdentityStore}from"./identity/prisma-identity-store.js";
import {ExternalApprovals}from"./external-approvals/external-approvals.js";
import {ExecutorConflict}from"./executor/protocol-errors.js";
async function main(){
 const[action,id,...flags]=process.argv.slice(2),options=new Map<string,string>();
 if(!["inspect","decide"].includes(action??"")||!id)throw Error("Usage: external-approvals inspect|decide INVOCATION_ID [--request-digest SHA --request-key KEY --decision APPROVE|REJECT --reason TEXT]");
 for(let n=0;n<flags.length;n+=2){const key=flags[n]!,value=flags[n+1];if(!["--request-digest","--request-key","--decision","--reason"].includes(key)||!value||options.has(key))throw Error("Invalid options");options.set(key,value);}
 if(action==="inspect"&&options.size)throw Error("Inspection takes no decision options");
 const file=process.env.FOUNDRY_OPERATOR_CREDENTIAL_FILE;
 if(!file||!statSync(file).isFile()||(statSync(file).mode&0o077)!==0||statSync(file).size>4096)throw Error("Use a protected operator credential file");
 const db=createPrismaClient(process.env.DATABASE_URL!);
 try{const context=await new CredentialAuthenticator(new PrismaIdentityStore(db)).authenticate(readFileSync(file,"utf8").trim()),service=new ExternalApprovals(db);
 const result=action==="inspect"?await service.inspect(context,id):await service.decide(context,id,{requestDigest:options.get("--request-digest")!,requestKey:options.get("--request-key")!,decision:options.get("--decision")!,reason:options.get("--reason")!});console.log(JSON.stringify(result,null,2));
 }finally{await db.$disconnect();}
}
void main().catch(error=>{console.error(error instanceof ExecutorConflict?`External approval rejected: ${error.code}`:error instanceof Error&&/^(Usage:|Invalid options|Inspection takes|Use a protected)/.test(error.message)?error.message:"External approval rejected; check identity, explicit approval scope, ownership and request digest");process.exitCode=1;});
