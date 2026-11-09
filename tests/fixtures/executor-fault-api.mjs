// TEST ONLY: barriers surround the real HTTP adapter's committed responses.
// This file is passed to the disposable private API, never loaded by production entry points.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createPrismaClient} from '/app/dist/src/persistence/prisma-execution-store.js';
import {CredentialAuthenticator} from '/app/dist/src/identity/identity.js';
import {PrismaIdentityStore} from '/app/dist/src/identity/prisma-identity-store.js';
import {InvocationService} from '/app/dist/src/invocation/invocation-service.js';
import {ExecutorProtocol} from '/app/dist/src/executor/executor-protocol.js';
import {ExecutorExecution} from '/app/dist/src/executor/execution-service.js';
import {createExternalApiServer} from '/app/dist/src/external-api/server.js';
import {assertLinuxIsolation} from '/app/dist/src/executor-runtime/isolation.js';
assertLinuxIsolation();
const mode=process.argv[1],db=createPrismaClient(readFileSync('/api-secrets/database-url','utf8').trim()),protocol=new ExecutorProtocol(db);
const inner=createExternalApiServer({auth:new CredentialAuthenticator(new PrismaIdentityStore(db)),invocations:new InvocationService(db),executors:protocol,execution:new ExecutorExecution(db,protocol,true)});
let injected=false;
const server=createServer(async(req,res)=>{
 try{
  if(mode==='revoked-result'&&!injected&&req.url.endsWith('/results')){
   const start=await db.executorStart.findUniqueOrThrow({where:{id:req.url.split('/').at(-2)},include:{claim:true}});
   await db.credential.update({where:{id:start.claim.credentialId},data:{revokedAt:new Date()}});injected=true;console.log('FAULT: credential revoked before result admission');
  }
  const end=res.end.bind(res);
  res.end=function(...args){
   if(!injected&&res.statusCode===200&&((mode==='start-loss'&&req.url.endsWith('/authorize-start'))||(mode==='ack-loss'&&req.url.endsWith('/results'))||(mode==='before-start'&&req.url==='/api/v1/executor/claims'))){
    injected=true;console.log('FAULT_BARRIER: '+mode);return res; // Hold the committed response until the test kills its executor.
   }
   return end(...args);
  };
  inner.emit('request',req,res);
 }catch{res.statusCode=503;res.end('{}');}
});
server.listen(3002,'0.0.0.0',()=>console.log('Private container-only API ready (test fault adapter)'));
process.on('SIGTERM',()=>{server.close(()=>void db.$disconnect());});
