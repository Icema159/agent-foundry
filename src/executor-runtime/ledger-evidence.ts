import { DatabaseSync } from "node:sqlite";
import { lstatSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WRITE_PROFILE } from "../executor/demo-receipt-contract.js";
import { reportIdentity } from "../executor/execution-contract.js";

/** Offline, read-only export. Contains references/digests, never credentials or raw payloads. */
export function exportLedgerEvidence(file:string){
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid evidence file");
  // Offline coherent copy: SQLite may need writable WAL/SHM even for queries.
  // Only this disposable copy may recover/checkpoint; never the retained source.
  const directory=mkdtempSync(join(tmpdir(),"foundry-evidence-"));
  let db:DatabaseSync|undefined;
  try{
    let bytes=0;
    const sources=[file,file+"-wal",file+"-shm"].filter(existsSync).map(path=>({path,stat:lstatSync(path)}));
    for(const source of sources){
      bytes+=source.stat.size;
      if(!source.stat.isFile()||source.stat.isSymbolicLink()||bytes>32*1024*1024)throw Error("Invalid or oversized ledger snapshot");
      copyFileSync(source.path,join(directory,"ledger.sqlite"+source.path.slice(file.length)));
    }
    for(const source of sources){const after=lstatSync(source.path);if(after.size!==source.stat.size||after.mtimeMs!==source.stat.mtimeMs||after.ino!==source.stat.ino)throw Error("Stop executor before exporting evidence");}
    db=new DatabaseSync(join(directory,"ledger.sqlite"));
    db.exec("PRAGMA query_only=ON");
    if((db.prepare("PRAGMA quick_check").get() as any).quick_check!=="ok")throw Error("Ledger integrity failed");
    const identity=JSON.parse((db.prepare("SELECT value FROM identity WHERE singleton=1").get() as any).value);
    if(!["artifactDigest,bindingId,deploymentId,ledgerId","artifactDigest,bindingId,deploymentId,executionProfile,ledgerId,outputResource"].includes(Object.keys(identity).sort().join(",")))throw Error("Invalid installation identity");
    const rows=db.prepare("SELECT * FROM attempts ORDER BY rowid LIMIT 10001").all() as any[];
    if(rows.length>10000)throw Error("Export capacity exceeded");
    const records=rows.map(a=>{
      const report=a.report?JSON.parse(a.report):null,ack=a.ack?JSON.parse(a.ack):null;
      return {claimId:a.claimId,invocationId:a.invocationId,generation:a.generation,sessionId:a.sessionId,artifactDigest:a.artifactDigest,state:a.state,startId:a.startId,
        report:report?{digest:reportIdentity(report,identity.executionProfile===WRITE_PROFILE?{invocationId:a.invocationId,outputResource:identity.outputResource}:undefined).digest,outcome:report.outcome,reason:report.reason}:null,
        ack:ack?{reportId:ack.reportId,startId:ack.startId,digest:ack.digest,outcome:ack.outcome}:null};
    });
    const hasContinuity=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuity'").get();
    const continuity=hasContinuity?db.prepare("SELECT version,nonce FROM continuity WHERE singleton=1").get()as any:null;
    const proofDigest=continuity?.version===2&&/^[a-f0-9]{64}$/.test(continuity.nonce)?createHash("sha256").update(continuity.nonce).digest("hex"):null;
    const evidence={version:1,installation:identity,continuity:{proofDigest,requiresOperatorRecovery:!proofDigest},records,verification:"LOCAL_EXPORT_NOT_INDEPENDENTLY_VERIFIED"};
    return {...evidence,evidenceDigest:createHash("sha256").update(JSON.stringify(evidence)).digest("hex")};
  }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
}
