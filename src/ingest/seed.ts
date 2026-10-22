// `bun run src/ingest/seed.ts [--db <path>]`: delete and rebuild the fixture DB, then ingestReceipts -> matchReceipts -> attributeAll.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db";
import { attributeAll } from "../attribution/engine";
import { matchReceipts } from "./match";
import { ingestReceipts } from "./receipts";
import { ingestAppleMail } from "./applemail";

/** MAIL_SOURCE=applemail: real receipts from local Apple Mail; on an access error, log and continue with none. */
function appleMailReceipts(db: Database): number {
  const r = ingestAppleMail(db);
  if (r.error) console.error(`[seed] Apple Mail: ${r.error}`);
  return r.parsed;
}
import { ingestAccounts, ingestTransactions, type Account, type Place, type Transaction } from "./types";

const FIXTURES = join(import.meta.dir, "../../fixtures");
export const DEMO_NOW = 1792695600; // 2026-10-22 12:00 PT

type Fixture = { accounts: Account[]; transactions: Transaction[]; places: Place[];
  goals: { id: number; target_cents: number; deadline: number; created_ts: number; savings_at_creation_cents: number; active: number }[] };

/** Loads the fixture into an empty DB and runs the full local pipeline. */
export function seed(db: Database, fixtureDir = FIXTURES) {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, "demo.json"), "utf8")) as Fixture;
  db.transaction(() => {
    ingestAccounts(db, fixture.accounts);
    ingestTransactions(db, fixture.transactions);
    for (const p of fixture.places) db.query("INSERT INTO places (label, address, lat, lng) VALUES (?, ?, ?, ?)").run(p.label, p.address, p.lat, p.lng);
    for (const g of fixture.goals) db.query("INSERT INTO goals (id, target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (?, ?, ?, ?, ?, ?)")
      .run(g.id, g.target_cents, g.deadline, g.created_ts, g.savings_at_creation_cents, g.active);
  })();
  const receipts = process.env.MAIL_SOURCE === "applemail" ? appleMailReceipts(db) : ingestReceipts(db, join(fixtureDir, "mail"));
  const matched = matchReceipts(db);
  const attributions = attributeAll(db);
  return { accounts: fixture.accounts.length, transactions: fixture.transactions.length, receipts, matched,
    attributed: attributions.length, needs_prompt: attributions.filter(a => a.needs_prompt).length };
}

/** Deletes the DB file (and WAL/SHM) and seeds a fresh one. */
export function rebuild(path: string) {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
  const db = openDb(path);
  return { db, summary: seed(db) };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--db");
  const path = i > 0 ? process.argv[i + 1] : process.env.FIN_DB ?? join(import.meta.dir, "../../data/fin.db");
  const { db, summary } = rebuild(path);
  const { affordability } = await import("../handlers/finance");
  const a = affordability(db, 40000, DEMO_NOW);
  db.close();
  console.log(JSON.stringify({ db: path, ...summary, tuning: a && { verdict: a.verdict, paceGap: a.paceGap, netMonthly: a.netMonthly } }, null, 2));
}
