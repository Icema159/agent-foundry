import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type LedgerIdentity = { deploymentId: string; bindingId: string; ledgerId: string; artifactDigest: string; executionProfile?: string; outputResource?: string };
export type Attempt = { claimId: string; invocationId: string; generation: number; sessionId: string; requestKey: string; artifactDigest: string;
  state: "PREPARED" | "START_REQUESTED" | "START_INTENT" | "RESULT_PENDING" | "ACKED" | "AMBIGUOUS" | "ABANDONED";
  startId: string | null; report: string | null; ack: string | null };

function configure(db: DatabaseSync) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  if ((db.prepare("PRAGMA synchronous").get() as any).synchronous !== 2) throw new Error("Durable SQLite mode unavailable");
}
/** Explicit trusted provisioning only. Runtime NEVER creates/reinitializes a lost ledger. */
export function initializeLedger(file: string, identity: LedgerIdentity) {
  if (existsSync(file)) throw new Error("Refusing to replace an existing ledger");
  const db = new DatabaseSync(file);
  try {
    configure(db);
    db.exec(`CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
      CREATE TABLE attempts (claimId TEXT PRIMARY KEY, invocationId TEXT NOT NULL, generation INTEGER NOT NULL, sessionId TEXT NOT NULL,
      requestKey TEXT NOT NULL, artifactDigest TEXT NOT NULL, state TEXT NOT NULL, startId TEXT UNIQUE, report TEXT, ack TEXT);
      CREATE UNIQUE INDEX one_possible_start ON attempts(invocationId) WHERE state IN ('START_REQUESTED','START_INTENT','RESULT_PENDING','ACKED','AMBIGUOUS');`);
    db.prepare("INSERT INTO identity VALUES(1,?)").run(JSON.stringify(identity));
    db.exec("CREATE TABLE continuity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, nonce TEXT NOT NULL)");
    db.prepare("INSERT INTO continuity VALUES(1,2,?)").run(randomBytes(32).toString("hex"));
    db.exec("PRAGMA wal_checkpoint(FULL)");
  } finally { db.close(); }
}

export class StartLedger {
  private readonly db: DatabaseSync;
  readonly identity: LedgerIdentity;
  readonly proofDigest: string;
  constructor(file: string, expected: LedgerIdentity) {
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Missing or invalid ledger; provisioning required");
    this.db = new DatabaseSync(file);
    try {
      configure(this.db);
      if ((this.db.prepare("PRAGMA quick_check").get() as any).quick_check !== "ok") throw new Error("Ledger integrity failed");
      const continuity = this.db.prepare("SELECT version,nonce FROM continuity WHERE singleton=1").get() as any;
      if (continuity?.version !== 2 || !/^[a-f0-9]{64}$/.test(continuity.nonce)) throw new Error("Ledger continuity baseline unavailable");
      this.proofDigest = createHash("sha256").update(continuity.nonce).digest("hex");
      this.identity = JSON.parse((this.db.prepare("SELECT value FROM identity WHERE singleton=1").get() as any).value);
      if (JSON.stringify(this.identity) !== JSON.stringify(expected)) throw new Error("Ledger installation identity mismatch");
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get(claimId: string): Attempt { return this.db.prepare("SELECT * FROM attempts WHERE claimId=?").get(claimId) as unknown as Attempt; }
  all(): Attempt[] {
    const rows = this.db.prepare("SELECT * FROM attempts ORDER BY rowid LIMIT 10001").all() as unknown as Attempt[];
    if (rows.length > 10000) throw new Error("Ledger reconciliation capacity exceeded");
    return rows;
  }
  unfinished(): Attempt[] { return this.db.prepare("SELECT * FROM attempts WHERE state NOT IN ('ACKED','ABANDONED') ORDER BY rowid").all() as unknown as Attempt[]; }
  prepare(claim: { id: string; invocationId: string; generation: number }, sessionId: string): Attempt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE invocationId=? AND state NOT IN ('PREPARED','ABANDONED')").get(claim.invocationId)) throw new Error("Invocation may already have started");
      this.db.prepare("INSERT INTO attempts(claimId,invocationId,generation,sessionId,requestKey,artifactDigest,state) VALUES(?,?,?,?,?,?,'PREPARED')")
        .run(claim.id, claim.invocationId, claim.generation, sessionId, randomUUID(), this.identity.artifactDigest);
      this.db.exec("COMMIT"); return this.get(claim.id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  move(claimId: string, from: Attempt["state"][], to: Attempt["state"], startId: string | null = null, report: string | null = null, ack: string | null = null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(claimId);
      if (!current || !from.includes(current.state) || (current.startId && startId && current.startId !== startId)) throw new Error("Ledger state or start identity conflict");
      this.db.prepare("UPDATE attempts SET state=?,startId=COALESCE(?,startId),report=COALESCE(?,report),ack=COALESCE(?,ack) WHERE claimId=?")
        .run(to, startId, report, ack, claimId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
