import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateDockerProfile } from '../dist/src/executor-runtime/docker-profile.js';
function docker(args) {
  const r=spawnSync('docker',args,{encoding:'utf8'});
  if(r.status)throw new Error('Docker operation failed');
  return r.stdout.trim();
}
export function launchIsolatedExecutor(config) {
  if(Object.keys(config).some(k=>!["name","image","network","apiContainer","secretsVolume","ledgerVolume","profile","outputVolume","outputResource"].includes(k)))throw new Error("Unexpected installation option");
  for(const value of Object.values(config))if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]+$/.test(value))throw new Error('Invalid trusted installation configuration');
  if(config.ledgerVolume===config.secretsVolume)throw new Error('Separate secret and ledger volumes required');
  docker(['create','--name',config.name,'--network',config.network,'--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--memory=128m','--cpus=0.5','--pids-limit=64','--mount',`type=volume,src=${config.ledgerVolume},dst=/ledger,volume-nocopy`,
    '--mount',`type=volume,src=${config.secretsVolume},dst=/secrets,readonly,volume-nocopy`,...(config.outputVolume?['--mount',`type=volume,src=${config.outputVolume},dst=/demo-output,volume-nocopy`]:[]),config.image]);
  const container=JSON.parse(docker(['inspect',config.name]))[0], network=JSON.parse(docker(['network','inspect',config.network]))[0], api=JSON.parse(docker(['inspect',config.apiContainer]))[0];
  validateDockerProfile(container,network,api,config);
  docker(['start',config.name]);
  return config.name;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  launchIsolatedExecutor(JSON.parse(readFileSync(process.argv[2],'utf8')));
  console.log('Isolated executor started');
}
