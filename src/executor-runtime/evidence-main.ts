import { exportLedgerEvidence } from "./ledger-evidence.js";
try { console.log(JSON.stringify(exportLedgerEvidence(process.argv[2] ?? "/ledger/ledger.sqlite"),null,2)); }
catch { console.error("Ledger evidence export failed; preserve the volume and investigate offline"); process.exitCode=1; }
