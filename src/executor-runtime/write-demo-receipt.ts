import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync}from"node:fs";
import {receiptIdentity,validDemoResource,WRITE_PROFILE}from"../executor/demo-receipt-contract.js";
function outputDirectory(resource:string){
 if(!validDemoResource(resource))throw Error("Invalid approved output resource");
 const dir=openSync("/demo-output",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{
  const stat=fstatSync(dir);
  if(!stat.isDirectory()||stat.uid!==0||stat.gid!==10001||(stat.mode&0o7777)!==0o1770)throw Error("Unprotected output root");
  const marker=openSync(`/proc/self/fd/${dir}/.foundry-resource.json`,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const m=fstatSync(marker);if(!m.isFile()||m.uid!==0||m.gid!==10001||(m.mode&0o7777)!==0o440||m.nlink!==1||m.size>1024)throw Error("Invalid output resource marker");
   const value=JSON.parse(readFileSync(marker,"utf8"));
   if(Object.keys(value).sort().join(",")!=="profile,resourceId,version"||value.profile!==WRITE_PROFILE||value.version!==1||value.resourceId!==resource)throw Error("Wrong approved output resource");
  }finally{closeSync(marker);}
  return dir;
 }catch(error){closeSync(dir);throw error;}
}
export function verifyDemoOutput(resource:string){closeSync(outputDirectory(resource));}
/** Fixed resource and basename only. Never accepts an agent path, content or command. */
export function writeDemoReceipt(args:unknown,context:{invocationId:string;outputResource:string}){
 if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).length)throw Error("Exact empty arguments required");
 const receipt=receiptIdentity(context.invocationId,context.outputResource),dir=outputDirectory(context.outputResource);
 try{
  const file=openSync(`/proc/self/fd/${dir}/${receipt.path}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{const stat=fstatSync(file);if(!stat.isFile()||stat.nlink!==1)throw Error("Invalid exclusive target");writeFileSync(file,receipt.content,"utf8");fsyncSync(file);}finally{closeSync(file);}
  fsyncSync(dir);
  return receipt.result;
 }finally{closeSync(dir);}
}
