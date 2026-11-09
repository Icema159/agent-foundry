import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EXECUTION_PROFILE } from "../executor/execution-contract.js";
import { WRITE_PROFILE, validDemoResource } from "../executor/demo-receipt-contract.js";
import { writeDemoReceipt, verifyDemoOutput } from "./write-demo-receipt.js";
import { StartLedger, type LedgerIdentity } from "./ledger.js";
import { HttpExecutorClient } from "./api-client.js";
import { IsolatedExecutorRuntime } from "./runtime.js";
import { assertLinuxIsolation, validatePrivateOrigin } from "./isolation.js";

async function main() {
  assertLinuxIsolation();
  if (["DATABASE_URL", "OPENAI_API_KEY", "AGENT_CREDENTIAL"].some(k => process.env[k])) throw new Error("Unnecessary credentials in executor environment");
  const config = JSON.parse(readFileSync("/secrets/config.json", "utf8"));
  if (Object.keys(config).some(k => !["apiOrigin","deploymentId","bindingId","ledgerId","artifactDigest","credential","once","executionProfile","outputResource"].includes(k)) ||
    !/^af_[A-Za-z0-9_-]{43}$/.test(config.credential ?? "")) throw new Error("Invalid executor configuration");
  const profile=config.executionProfile??EXECUTION_PROFILE;
  if(![EXECUTION_PROFILE,WRITE_PROFILE].includes(profile)||(profile===WRITE_PROFILE?!validDemoResource(config.outputResource):config.outputResource!==undefined))throw new Error("Invalid fixed execution profile");
  const outputMounted=readFileSync("/proc/self/mountinfo","utf8").split("\n").some(line=>line.split(" ")[4]==="/demo-output");
  if(outputMounted!==(profile===WRITE_PROFILE))throw new Error("Output mount does not match fixed profile");
  const identity: LedgerIdentity = { deploymentId: config.deploymentId, bindingId: config.bindingId, ledgerId: config.ledgerId, artifactDigest: config.artifactDigest, ...(profile===WRITE_PROFILE?{executionProfile:profile,outputResource:config.outputResource}:{}) };
  const verify = () => {
    const actual = createHash("sha256").update(readFileSync(new URL(profile===WRITE_PROFILE?"./write-demo-receipt.js":"./health-ping.js", import.meta.url))).digest("hex");
    if(profile===WRITE_PROFILE)verifyDemoOutput(config.outputResource);
    if (actual !== identity.artifactDigest) throw new Error("Handler artifact digest mismatch");
  };
  verify();
  const ledger = new StartLedger("/ledger/ledger.sqlite", identity);
  const runtime = new IsolatedExecutorRuntime(ledger, new HttpExecutorClient(validatePrivateOrigin(config.apiOrigin), config.credential), verify, undefined, profile===WRITE_PROFILE?(args,context)=>writeDemoReceipt(args,{invocationId:context.invocationId,outputResource:config.outputResource}):undefined);
  try {
    await runtime.initialize(); console.log("Executor session ready; durable ledger reconciled");
    let stopped = false; process.once("SIGTERM", () => { stopped = true; }); process.once("SIGINT", () => { stopped = true; });
    do { const worked = await runtime.tick(); if (worked) console.log("Executor report durably acknowledged"); if (config.once) break; await delay(1000); } while (!stopped);
  } finally { ledger.close(); }
}
void main().catch(() => { console.error("Executor stopped safely; inspect retained ledger and authorized history"); process.exitCode = 1; });
