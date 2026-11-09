// Test-only entry point; never loaded by the production image's main module.
import{readFileSync,writeSync}from"node:fs";import{createHash}from"node:crypto";
import{StartLedger,type LedgerIdentity}from"../../src/executor-runtime/ledger.js";
import{IsolatedExecutorRuntime,type FaultPoint}from"../../src/executor-runtime/runtime.js";
import{HttpExecutorClient}from"../../src/executor-runtime/api-client.js";
import{assertLinuxIsolation,validatePrivateOrigin}from"../../src/executor-runtime/isolation.js";
import{WRITE_PROFILE}from"../../src/executor/demo-receipt-contract.js";
async function main(){
 assertLinuxIsolation();const config=JSON.parse(readFileSync("/secrets/config.json","utf8")),point=process.env.FOUNDRY_TEST_EXECUTOR_FAULT;
 if(config.executionProfile!==WRITE_PROFILE||!["after_start_response","after_start_intent","after_handler"].includes(point??""))throw Error("Invalid test fixture");
 const artifact=new URL("./write-demo-receipt.js",import.meta.url),module=await import(artifact.href);
 const verify=()=>{if(createHash("sha256").update(readFileSync(artifact)).digest("hex")!==config.artifactDigest)throw Error("Wrong artifact");module.verifyDemoOutput(config.outputResource);};verify();
 const identity:LedgerIdentity={deploymentId:config.deploymentId,bindingId:config.bindingId,ledgerId:config.ledgerId,artifactDigest:config.artifactDigest,executionProfile:WRITE_PROFILE,outputResource:config.outputResource};
 const ledger=new StartLedger("/ledger/ledger.sqlite",identity),runtime=new IsolatedExecutorRuntime(ledger,new HttpExecutorClient(validatePrivateOrigin(config.apiOrigin),config.credential),verify,
  p=>{if(p===point){writeSync(1,`FAULT_REACHED:${p}\n`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}},(args,ctx)=>module.writeDemoReceipt(args,{invocationId:ctx.invocationId,outputResource:config.outputResource}));
 try{await runtime.initialize();await runtime.tick();}finally{ledger.close();}
}
void main().catch(()=>{console.error("Test executor stopped safely");process.exitCode=1;});
