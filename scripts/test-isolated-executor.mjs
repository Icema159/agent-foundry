// Opt-in real Docker + PostgreSQL integration test. Never connects to the developer database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from '../dist/tests/executor-start-fixture.js';
import { OperatorReconciliation } from '../dist/src/reconciliation/operator-service.js';
import { launchIsolatedExecutor } from './run-isolated-executor.mjs';
const mode=process.argv[2]??'normal';
if(!['normal','before-start','start-loss','ack-loss','revoked-result'].includes(mode))throw Error('Invalid fault scenario');
const prefix='foundry112d-'+randomBytes(5).toString('hex');
const networks=[],volumes=[],containers=[];let fixture;
function run(cmd,args,options={}){const r=spawnSync(cmd,args,{encoding:'utf8',timeout:120000,...options});if(r.status!==0)throw new Error(`${cmd} ${args.slice(0,2).join(' ')} failed: ${r.stderr?.slice(-2000)??''}`);return r.stdout.trim();}
function docker(args,input){return run('docker',args,input===undefined?{}:{input});}
function volume(label){const name=prefix+'-'+label;docker(['volume','create',name]);volumes.push(name);return name;}
function network(label,isolated=true,internal=true){const name=prefix+'-'+label;docker(['network','create',...(internal?['--internal']:[]),...(isolated?['--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated']:[]),name]);networks.push(name);return name;}
function provision(vol,files,uid=10001){
 const code=`const fs=require('fs'),f=JSON.parse(fs.readFileSync(0,'utf8'));fs.chmodSync('/out',0o700);for(const [name,data]of Object.entries(f)){fs.writeFileSync('/out/'+name,data,{mode:0o400});fs.chownSync('/out/'+name,${uid},${uid});}fs.chownSync('/out',${uid},${uid});`;
 docker(['run','--rm','-i','--network=none','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--security-opt=no-new-privileges','--mount',`type=volume,src=${vol},dst=/out`,'node:22-alpine','node','-e',code],JSON.stringify(files));
}
function create(args,label){const name=prefix+'-'+label;docker(['create','--name',name,...args]);containers.push(name);return name;}
function wait(name,expected=0){assert.equal(Number(docker(['wait',name])),expected,`container ${name}: ${docker(['logs',name])}`);}
const apiImage=process.env.FOUNDRY_TEST_API_IMAGE??'agent-foundry-private-api:11.2d',executorImage=process.env.FOUNDRY_TEST_EXECUTOR_IMAGE??'agent-foundry-executor:11.2d';
try{
 const execNet=network('executor'),agentNet=network('agent'),dbNet=network('db',false),bootstrapNet=network('bootstrap',false,false);
 const password=randomBytes(24).toString('hex');
 const pg=create(['--network',bootstrapNet,'-p','127.0.0.1::5432','-e','POSTGRES_DB=foundry_112d_docker_test','-e',`POSTGRES_PASSWORD=${password}`,'postgres:16'],'postgres');docker(['network','connect','--alias','foundry-postgres',dbNet,pg]);docker(['start',pg]);
 let ready=false;for(let n=0;n<100;n++){if(spawnSync('docker',['exec',pg,'pg_isready','-U','postgres'],{stdio:'ignore'}).status===0){ready=true;break;}await delay(100);}assert.ok(ready,'isolated PostgreSQL ready');
 const info=JSON.parse(docker(['inspect',pg]))[0],port=info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
 const url=`postgresql://postgres:${password}@127.0.0.1:${port}/foundry_112d_docker_test`;
 run('npm',['run','prisma:migrate'],{env:{...process.env,DATABASE_URL:url}});
 const artifactDigest=createHash('sha256').update(readFileSync('dist/isolated-executor/health-ping.js')).digest('hex');
 fixture=await startFixture(url,artifactDigest);
 const apiSecrets=volume('api-secrets');provision(apiSecrets,{'database-url':`postgresql://postgres:${password}@foundry-postgres:5432/foundry_112d_docker_test`});
 const faultApi=mode==='normal'?[]:['--entrypoint','node'];
 const apiCommand=mode==='normal'?[]:['--input-type=module','-e',readFileSync('tests/fixtures/executor-fault-api.mjs','utf8'),mode];
 const api=create([...faultApi,'--network',execNet,'--network-alias','foundry-api','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=512m','--cpus=1','--pids-limit=128','--mount',`type=volume,src=${apiSecrets},dst=/api-secrets,readonly`,apiImage,...apiCommand],'api');
 docker(['network','connect',dbNet,api]);docker(['network','connect','--alias','foundry-api',agentNet,api]);docker(['start',api]);
 for(let n=0;n<100;n++){if(docker(['logs',api]).includes('API ready')){ready=true;break;}await delay(100);}
 assert.ok(docker(['logs',api]).includes('API ready'),'private API ready');
 const agentSecrets=volume('agent-secrets');provision(agentSecrets,{'agent.json':JSON.stringify({credential:fixture.token.secret,versionId:fixture.version.id,toolId:fixture.tool.id,deploymentId:fixture.deployment.id,grantId:fixture.grant.id})},10002);
 const agentCode=`const fs=require('fs'),assert=require('assert/strict'),c=JSON.parse(fs.readFileSync('/agent-secrets/agent.json','utf8'));async function call(path,body){const r=await fetch('http://foundry-api:3002'+path,{method:'POST',headers:{authorization:'Bearer '+c.credential,'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}(async()=>{assert.ok(!fs.existsSync('/ledger'));assert.ok(!fs.existsSync('/secrets/config.json'));assert.equal((await call('/api/v1/executor/sessions',{})).status,403);const run=await call('/api/v1/external/runs',{versionId:c.versionId});assert.equal(run.status,201);const body={toolId:c.toolId,deploymentId:c.deploymentId,grantId:c.grantId,idempotencyKey:'docker-ping',arguments:{}};const inv=await call('/api/v1/external/runs/'+run.body.run.id+'/invocations',body);assert.equal(inv.status,200);const retry=await call('/api/v1/external/runs/'+run.body.run.id+'/invocations',body);assert.equal(retry.body.invocation.id,inv.body.invocation.id);console.log(JSON.stringify({runId:run.body.run.id,invocationId:inv.body.invocation.id}));})().catch(()=>{console.error('Agent test failed');process.exitCode=1});`;
 const agent=create(['--network',agentNet,'--user','10002:10002','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=128m','--pids-limit=64','--mount',`type=volume,src=${agentSecrets},dst=/agent-secrets,readonly`,'node:22-alpine','node','-e',agentCode],'agent');docker(['start',agent]);wait(agent);
 const receipt=JSON.parse(docker(['logs',agent]));console.log('Agent HTTP receipt:',JSON.stringify(receipt));
 const secrets=volume('executor-secrets'),ledger=volume('ledger');
 provision(secrets,{'config.json':JSON.stringify({...fixture.identity,credential:fixture.credential.secret,apiOrigin:'http://foundry-api:3002',once:true})});provision(ledger,{});
 docker(['run','--rm','-i','--network=none','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--mount',`type=volume,src=${ledger},dst=/ledger,volume-nocopy`,'--entrypoint','node',executorImage,'/app/initialize.mjs'],JSON.stringify(fixture.identity));
 function launch(label,secretVolume=secrets,ledgerVolume=ledger){const name=prefix+'-'+label;containers.push(name);launchIsolatedExecutor({name,image:executorImage,network:execNet,apiContainer:api,secretsVolume:secretVolume,ledgerVolume});return name;}
 const snapshot=volume('initial-snapshot');provision(snapshot,{});
 const copyLedger=(source,target)=>docker(['run','--rm','--network=none','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--mount',`type=volume,src=${source},dst=/src,readonly`,'--mount',`type=volume,src=${target},dst=/out`,'node:22-alpine','node','-e',`const fs=require('fs');for(const name of fs.readdirSync('/src'))fs.copyFileSync('/src/'+name,'/out/'+name)`]);
 copyLedger(ledger,snapshot);
 const executor=launch('executor');
 if(mode!=='normal'){
   if(mode==='revoked-result')wait(executor,1);
   else{let reached=false;for(let n=0;n<150;n++){if(docker(['logs',api]).includes('FAULT_BARRIER: '+mode)){reached=true;break;}await delay(50);}assert.ok(reached,'real committed-response barrier');docker(['kill','--signal=KILL',executor]);wait(executor,137);}
   docker(['network','disconnect',execNet,executor]);
   const restarted=launch('fault-restart');wait(restarted,mode==='revoked-result'?1:0);
   const current=await fixture.db.invocation.findUniqueOrThrow({where:{id:receipt.invocationId}});
   if(mode==='start-loss'){assert.equal(current.status,'UNKNOWN');assert.equal(await fixture.db.executorReport.count({where:{start:{invocationId:current.id},outcome:'SUCCEEDED'}}),0);}
   if(mode==='before-start'||mode==='ack-loss')assert.equal(current.status,'SUCCEEDED');
   assert.equal(await fixture.db.executorStart.count({where:{invocationId:current.id}}),1);
   if(mode==='before-start')assert.equal(await fixture.db.executorClaim.count({where:{invocationId:current.id}}),2);
   if(mode==='revoked-result'){
     assert.equal(await fixture.db.executorReport.count({where:{start:{invocationId:current.id}}}),0);
     const operator=new OperatorReconciliation(fixture.db),view=await operator.refresh(fixture.op,current.id);assert.equal(view.status,'UNKNOWN');
     await operator.record(fixture.op,current.id,{requestKey:'revoked-result',basisSequence:view.basisSequence,decision:'RECOVERY_BLOCKED',reason:'Original credential revoked; preserved local result cannot be imported by this phase',evidence:[{kind:'START',id:view.start.id}]});
   }
   const exported=JSON.parse(docker(['run','--rm','--network=none','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=96m,uid=10001,gid=10001,mode=0700','--memory=256m','--mount',`type=volume,src=${ledger},dst=/ledger,readonly,volume-nocopy`,'--entrypoint','node',executorImage,'/app/evidence.mjs']));
   const row=exported.records.find(r=>r.invocationId===current.id&&r.startId);
   assert.equal(row.state,mode==='revoked-result'?'RESULT_PENDING':'ACKED');
   if(mode==='revoked-result')assert.equal(row.report.outcome,'SUCCEEDED');
   console.log(`PASS real Docker ${mode}: one authorized start; state ${mode==='revoked-result'?'UNKNOWN':current.status}; ledger ${row.state}; no automatic handler replay`);
   console.log('Docker fault E2E PASS; test resources will be removed');
 }else{
 wait(executor);
 const invocation=await fixture.db.invocation.findUniqueOrThrow({where:{id:receipt.invocationId}});assert.equal(invocation.status,'SUCCEEDED');
 assert.equal(await fixture.db.executorStart.count({where:{invocationId:invocation.id}}),1);assert.equal(await fixture.db.executorReport.count({where:{start:{invocationId:invocation.id}}}),1);
 const history=await fixture.invocations.history(fixture.agentContext,receipt.runId);assert.deepEqual(history.map(e=>e.kind),['AUTHORIZATION_DECISION','CLAIMED','START_AUTHORIZED','RESULT_REPORTED']);
 console.log('PASS: agent HTTP → session → claim → atomic start → isolated health_ping → durable result ACK');
 const historyCode=`const fs=require('fs'),assert=require('assert/strict'),c=JSON.parse(fs.readFileSync('/agent-secrets/agent.json','utf8'));(async()=>{const r=await fetch('http://foundry-api:3002/api/v1/external/runs/'+process.argv[1]+'/history',{headers:{authorization:'Bearer '+c.credential}});assert.equal(r.status,200);const body=await r.json(),event=body.events.at(-1);assert.equal(event.status,'SUCCEEDED');assert.equal(event.execution.verification,'EXECUTOR_REPORTED');assert.deepEqual(event.execution.result,{ok:true,tool:'health_ping',version:1});assert.ok(!/credentialId|artifactDigest|authorizationDigest/.test(JSON.stringify(body)));console.log('Authorized HTTP history verified');})().catch(()=>{console.error('History test failed');process.exitCode=1});`;
 docker(['run','--rm','--network',agentNet,'--user','10002:10002','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--mount',`type=volume,src=${agentSecrets},dst=/agent-secrets,readonly`,'node:22-alpine','node','-e',historyCode,receipt.runId]);
 console.log('PASS: authenticated agent reconnect reads safe reported result through Docker HTTP history');
 // Remove completed executor from control network before launching replacement: only API + one executor are permitted.
 docker(['network','disconnect',execNet,executor]);const replacement=launch('replacement');wait(replacement);
 assert.equal(await fixture.db.executorStart.count({where:{invocationId:invocation.id}}),1);assert.equal(await fixture.db.executorReport.count({where:{start:{invocationId:invocation.id}}}),1);
 console.log('PASS: real container replacement, same durable ledger, no repeated start/result');
 docker(['network','disconnect',execNet,replacement]);
 wait(launch('stale-snapshot',secrets,snapshot),1);docker(['network','disconnect',execNet,prefix+'-stale-snapshot']);
 const fresh=volume('reinitialized');provision(fresh,{});
 docker(['run','--rm','-i','--network=none','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--mount',`type=volume,src=${fresh},dst=/ledger,volume-nocopy`,'--entrypoint','node',executorImage,'/app/initialize.mjs'],JSON.stringify(fixture.identity));
 wait(launch('reinitialized',secrets,fresh),1);docker(['network','disconnect',execNet,prefix+'-reinitialized']);
 const corrupt=volume('corrupted');provision(corrupt,{'ledger.sqlite':'damaged SQLite file'});
 wait(launch('corrupted',secrets,corrupt),1);docker(['network','disconnect',execNet,prefix+'-corrupted']);
 console.log('PASS: stale snapshot, initialized replacement and corrupted ledger all fail closed');
 const readyCount=(docker(['logs',api]).match(/API ready/g)??[]).length;
 docker(['stop','--time=2',api]);wait(launch('api-outage'),1);docker(['network','disconnect',execNet,prefix+'-api-outage']);docker(['start',api]);
 for(let n=0;n<100;n++){if((docker(['logs',api]).match(/API ready/g)??[]).length>readyCount)break;await delay(50);}
 wait(launch('api-reconnected'),0);docker(['network','disconnect',execNet,prefix+'-api-reconnected']);
 console.log('PASS: real API outage stops executor; reconnect preserves completed start/result');

 const missing=volume('missing-ledger');provision(missing,{});wait(launch('missing',secrets,missing),1);docker(['network','disconnect',execNet,prefix+'-missing']);
 const wrong=volume('wrong-artifact');provision(wrong,{'config.json':JSON.stringify({...fixture.identity,artifactDigest:'a'.repeat(64),credential:fixture.credential.secret,apiOrigin:'http://foundry-api:3002',once:true})});wait(launch('wrong-artifact',wrong),1);
 assert.equal(await fixture.db.executorStart.count({where:{invocationId:invocation.id}}),1);
 console.log('PASS: missing ledger and wrong artifact refuse execution; no host fallback');
 // Direct network probes use the same executor network after removing the stopped executor.
 docker(['network','disconnect',execNet,prefix+'-wrong-artifact']);
 const probeCode=`const net=require('net');(async()=>{for(const host of ['foundry-postgres','1.1.1.1']){const connected=await new Promise(r=>{const s=net.connect({host,port:host==='1.1.1.1'?443:5432});s.setTimeout(700);s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.on('timeout',()=>{s.destroy();r(false)});});if(connected)throw Error('unexpected network path');}console.log('Network probes blocked');})().catch(()=>process.exitCode=1);`;
 docker(['run','--rm','--network',execNet,'--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','node:22-alpine','node','-e',probeCode]);
 console.log('PASS: executor network blocks database and Internet; API has no host port');
 console.log('Docker E2E PASS; ephemeral resources will be removed, no main DB/services used.');
 }
}finally{
 if(fixture)await fixture.db.$disconnect();
 for(const name of containers.reverse())spawnSync('docker',['rm','-f',name],{stdio:'ignore'});
 for(const name of networks.reverse())spawnSync('docker',['network','rm',name],{stdio:'ignore'});
 for(const name of volumes.reverse())spawnSync('docker',['volume','rm',name],{stdio:'ignore'});
}
