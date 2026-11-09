import { readFileSync } from "node:fs";
import { WRITE_PROFILE, validDemoResource } from "../executor/demo-receipt-contract.js";
import { initializeLedger, type LedgerIdentity } from "./ledger.js";
const input = JSON.parse(readFileSync(0, "utf8")) as LedgerIdentity;
if (!input.deploymentId || !input.bindingId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.ledgerId) || !/^[a-f0-9]{64}$/.test(input.artifactDigest)) throw new Error("Invalid ledger provisioning identity");
if(input.executionProfile!==undefined&&(input.executionProfile!==WRITE_PROFILE||!validDemoResource(input.outputResource)))throw new Error("Invalid WRITE installation");
if(!input.executionProfile&&input.outputResource!==undefined)throw new Error("Output resource requires WRITE profile");
initializeLedger("/ledger/ledger.sqlite", { deploymentId: input.deploymentId, bindingId: input.bindingId, ledgerId: input.ledgerId, artifactDigest: input.artifactDigest, ...(input.executionProfile?{executionProfile:input.executionProfile,outputResource:input.outputResource}:{}) });
console.log("Durable ledger initialized");
