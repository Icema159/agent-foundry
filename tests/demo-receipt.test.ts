import test from"node:test";import assert from"node:assert/strict";import{randomUUID}from"node:crypto";
import{receiptIdentity,validDemoResource}from"../src/executor/demo-receipt-contract.js";
import{writeDemoReceipt}from"../src/executor-runtime/write-demo-receipt.js";
import{reportIdentity}from"../src/executor/execution-contract.js";
test("receipt target/content are deterministic and reject agent paths or arbitrary content",()=>{
 const resource=`foundry:demo-output:${randomUUID()}`,expected=receiptIdentity("invocation_1",resource);
 assert.deepEqual(expected,receiptIdentity("invocation_1",resource));assert.equal(expected.path,"receipt-invocation_1.txt");assert.ok(expected.content.includes(resource));
 for(const id of["../escape","/tmp/file","a/b",".","x".repeat(129)])assert.throws(()=>receiptIdentity(id,resource));
 for(const r of["/tmp","foundry:resource-free:v1","foundry:demo-output:../x"])assert.equal(validDemoResource(r),false);
 assert.throws(()=>writeDemoReceipt({path:"/tmp/escape"},{invocationId:"invocation_1",outputResource:resource}));
});
test("WRITE report validation binds exact Invocation/resource/content and rejects READ_ONLY substitution",()=>{
 const write={invocationId:"invocation_1",outputResource:`foundry:demo-output:${randomUUID()}`},result=receiptIdentity(write.invocationId,write.outputResource).result;
 const body={sessionId:"session",generation:1,outcome:"SUCCEEDED"as const,reason:"DEMO_RECEIPT_CREATED",result};
 assert.doesNotThrow(()=>reportIdentity(body,write));assert.throws(()=>reportIdentity(body));assert.throws(()=>reportIdentity({...body,result:{...result,path:"/escape"}},write));assert.throws(()=>reportIdentity(body,{...write,invocationId:"other"}));
});
