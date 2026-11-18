import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { StartLedger, initializeLedger, type Attempt } from "../src/executor-runtime/ledger.js";
import { IsolatedExecutorRuntime, type RecoveryCapacity } from "../src/executor-runtime/runtime.js";
import { HEALTH_RESULT, reportIdentity } from "../src/executor/execution-contract.js";
import type { RecoveryClaim } from "../src/executor/recovery-contract.js";

const identity = { deploymentId: "deployment", bindingId: "binding", ledgerId: "test-ledger", artifactDigest: "a".repeat(64) };
const result = { sessionId: "original", generation: 1, outcome: "SUCCEEDED", reason: "HEALTH_PING_RETURNED", result: HEALTH_RESULT } as const;
const digest = reportIdentity(result).digest;

function claim(index: number, started: boolean): RecoveryClaim {
  const id = `claim-${index}`;
  return {
    id, invocationId: `invocation-${index}`, generation: 1, sessionId: result.sessionId,
    artifactDigest: identity.artifactDigest, status: "COMPLETED", reportCredentialCurrent: true,
    start: started ? { id: `start-${index}`, requestKey: `key-${index}`, reports: [{ id: `report-${index}`, digest, outcome: result.outcome }] } : null,
  };
}

function fixture(t: TestContext, history: RecoveryClaim[], seeded = history.length, stopAfterPrepare = false) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-capacity-"));
  const file = join(dir, "ledger.sqlite");
  let ledger: StartLedger | undefined;
  t.after(() => {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  initializeLedger(file, identity);
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const row of history.slice(0, seeded)) {
      const start = row.start;
      const ack = start ? { acknowledged: true, verification: "EXECUTOR_REPORTED", reportId: start.reports[0]!.id, startId: start.id, digest, outcome: result.outcome } : null;
      insert.run(row.id, row.invocationId, row.generation, row.sessionId, start?.requestKey ?? "unused",
        row.artifactDigest, start ? "ACKED" : "ABANDONED", start?.id ?? null, start ? JSON.stringify(result) : null, ack ? JSON.stringify(ack) : null);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  ledger = new StartLedger(file, identity);
  const routes: string[] = [];
  const diagnostics: RecoveryCapacity[] = [];
  const cursors = new Map(history.map(({ id }, index) => [id, index + 1]));
  const api = {
    async call(route: string, body?: { after?: string }) {
      routes.push(route);
      if (route === "/sessions") return { session: { ...identity, generation: 1, executionProfile: "docker-health-ping-v1", active: true, id: "current" } };
      if (route === "/recovery") {
        const offset = body?.after ? cursors.get(body.after)! : 0;
        const claims = history.slice(offset, offset + 100);
        const hasMore = offset + claims.length < history.length;
        return { executionAllowed: false, claims, hasMore, nextCursor: hasMore ? claims.at(-1)!.id : null };
      }
      if (route === "/poll" && stopAfterPrepare) return { startAllowed: false, offers: [{ executionAllowed: false, runId: "run", invocationId: "new-invocation" }] };
      if (route === "/claims" && stopAfterPrepare) return { claim: { deploymentId:identity.deploymentId,runId:"run",status:"ACTIVE",startAllowed:false,executionAllowed:false,id: "new-claim", invocationId: "new-invocation", generation: 1 } };
      throw new Error(`Unexpected side effect: ${route}`);
    },
  };
  const runtime = new IsolatedExecutorRuntime(ledger, api, () => {}, point => {
    if (stopAfterPrepare && point === "after_prepare") throw new Error("Simulated stop after prepare");
  }, () => assert.fail("Handler invoked during recovery"), capacity => diagnostics.push(capacity));
  return { ledger, diagnostics, routes, runtime };
}

test("small and full histories match and count ACKED and abandoned attempts", async t => {
  for (const size of [3, 9_999, 10_000]) {
    await t.test(String(size), async sub => {
      const { diagnostics, routes, runtime } = fixture(sub, Array.from({ length: size }, (_, i) => claim(i, i % 2 === 0)));
      await runtime.initialize();
      const acknowledged = Math.ceil(size / 2);
      assert.deepEqual(diagnostics, [
        { history: "local", total: size, limit: 10_000, warningAt: 9_000, acknowledged, abandoned: size - acknowledged, unresolved: 0 },
        { history: "server", total: size, limit: 10_000, warningAt: 9_000, inventoryComplete: true },
      ]);
      assert.equal(routes.filter(route => route === "/recovery").length, Math.ceil(size / 100));
      assert.equal(routes.length, 1 + Math.ceil(size / 100));
    });
  }
});

test("crossing the warning threshold reports unresolved local evidence", async t => {
  const { diagnostics, ledger, runtime } = fixture(t, Array.from({ length: 8_999 }, (_, i) => claim(i, false)), 8_999, true);
  await runtime.initialize();
  await assert.rejects(runtime.tick(), /Simulated stop after prepare/);
  assert.equal(ledger.get("new-claim").state, "PREPARED");
  assert.deepEqual(diagnostics.at(-1), { history: "local", total: 9_000, limit: 10_000, warningAt: 9_000, acknowledged: 0, abandoned: 8_999, unresolved: 1 });
});

test("local and server overflows independently block startup and subsequent polling", async t => {
  for (const historyToOverflow of ["local", "server"]) {
    await t.test(historyToOverflow, async sub => {
      const local = historyToOverflow === "local";
      const { diagnostics, routes, runtime } = fixture(sub, Array.from({ length: 10_001 }, (_, i) => claim(i, false)), local ? 10_001 : 0);
      await assert.rejects(runtime.initialize(), /reconciliation capacity exceeded/);
      await assert.rejects(runtime.tick(), /reconciliation required/);
      assert.ok(!routes.includes("/poll"));
      assert.equal(routes.filter(route => route === "/recovery").length, local ? 0 : 101);
      const overflow = diagnostics.at(-1)!;
      assert.equal(overflow.history, historyToOverflow);
      assert.equal(overflow.total, 10_001);
      if (overflow.history === "server") assert.equal(overflow.inventoryComplete, false);
    });
  }
});

test("indexed recovery rejects inconsistent identity and leaves retained evidence intact", async t => {
  const cases: Array<[string, (history: RecoveryClaim[], ledger: StartLedger) => void, RegExp]> = [
    ["duplicate local claim", (_, ledger) => { const rows = ledger.all(); ledger.all = () => [...rows, rows[0]!]; }, /Duplicate local claim/],
    ["duplicate server claim", history => { history.push(history[0]!); }, /Repeated recovery cursor/],
    ["changed session", history => { history[0]!.sessionId = "unexpected"; }, /claim identity mismatch/],
    ["duplicate start", history => { history[1]!.start!.id = history[0]!.start!.id; }, /Duplicate start identity/],
    ["duplicate report ID", history => { history[1]!.start!.reports[0]!.id = history[0]!.start!.reports[0]!.id; }, /Duplicate recovery report/],
    ["conflicting report for the same digest", history => { history[0]!.start!.reports.push({ id: "different", digest, outcome: "UNKNOWN" }); }, /Duplicate recovery report/],
    ["missing local start evidence", history => { history.push(claim(2, true)); }, /authorized start missing locally/],
    ["missing server start", history => { history[0]!.start = null; }, /Local start missing from Foundry/],
    ["missing server claim", history => { history.pop(); }, /Local claim missing from Foundry/],
    ["wrong result digest", history => { history[0]!.start!.reports[0]!.digest = "b".repeat(64); }, /Conflicting persisted result/],
    ["wrong result outcome", history => { history[0]!.start!.reports[0]!.outcome = "UNKNOWN"; }, /Conflicting persisted result/],
    ["wrong ACK identity", history => { history[0]!.start!.reports[0]!.id = "unexpected"; }, /acknowledgement mismatch/],
    ["wrong result generation", (_, ledger) => { const rows = ledger.all(); const wrong: Attempt = { ...rows[0]!, report: JSON.stringify({ ...result, generation: 2 }) }; ledger.all = () => [wrong, rows[1]!]; }, /result identity mismatch/],
  ];
  for (const [name, alter, error] of cases) await t.test(name, async sub => {
    const history = [claim(0, true), claim(1, true)];
    const { ledger, routes, runtime } = fixture(sub, history);
    const retained = ledger.get("claim-0");
    alter(history, ledger);
    await assert.rejects(runtime.initialize(), error);
    await assert.rejects(runtime.tick(), /reconciliation required/);
    assert.deepEqual(routes.filter(route => !["/recovery", "/sessions"].includes(route)), []);
    assert.deepEqual(ledger.get("claim-0"), retained);
  });
});
