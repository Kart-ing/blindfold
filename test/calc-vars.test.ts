import { afterAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { GROUP_NAMES, varDefs } from "../src/calc/vars.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { addAsset } from "../src/memory/assets.ts";
import { forgetFact, listFacts, storeFact } from "../src/memory/facts.ts";
import { answerForgetAll, runMemory } from "../src/memory/commands.ts";

const NOW = fromLocal(2026, 10, 22, 16, 30);
const paths: string[] = [];
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

/** Synthetic, real-shaped: $6k savings, $3.3k checking (statement Sep 30), Robinhood told; Aug/Sep $10.2k pay. */
function db(): Database {
  const p = join(tmpdir(), `fin-vars-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run(`INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES
    ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600000), ('chk', 'Checking', 'depository', 'checking', 0, 'me', 330000)`);
  d.run("INSERT INTO ingest_log(file_sha, path, source, account_id, period_start, period_end, rows, ingested_ts) VALUES ('f1', 'x.pdf', 'pdf', 'chk', ?, ?, 4, ?)",
    [fromLocal(2026, 9, 1), fromLocal(2026, 9, 30), NOW]);
  for (const [m, spend] of [[8, 310000], [9, 590000]]) {
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, -1020000, 'Payroll', 'INCOME')", [`i${m}`, fromLocal(2026, m, 1, 12)]);
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, 270000, 'Zelle', 'RENT_AND_UTILITIES')", [`r${m}`, fromLocal(2026, m, 3, 12)]);
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, ?, 'Life', 'GENERAL_MERCHANDISE')", [`s${m}`, fromLocal(2026, m, 10, 12), spend - 270000]);
  }
  addAsset(d, "Robinhood", 1000000, NOW - 60);
  d.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (4000000, ?, ?, 1600000, 1)", [fromLocal(2026, 12, 31, 23, 59), NOW - 60]);
  return d;
}

test("variables: real values locally, and the defs Sol sees carry no values", () => {
  const d = db();
  const { defs, vars } = varDefs(d, NOW, { Q_AMT_1: "600000" });
  const v = (n: string) => vars[n]?.value;
  expect(v("TODAY")).toBe(NOW);
  expect(v("SAVINGS")).toBe(600000);
  expect(v("CHECKING")).toBe(330000);
  expect(v("CHECKING_ASOF")).toBe(fromLocal(2026, 9, 30));
  expect(v("ASSET_1")).toBe(1000000);
  expect(v("INCOME_MO")).toBe(1020000);
  expect(v("SPEND_MO")).toBe(450000);
  expect(v("NET_MO")).toBe(570000);
  expect(v("RENT_MO")).toBe(270000);
  expect(v("CAT_SHOPPING_MO")).toBe(180000);
  expect(GROUP_NAMES.reduce((a, n) => a + v(n)!, 0)).toBe(v("SPEND_MO")); // the groups add up to spending
  expect(v("GOAL_TARGET")).toBe(4000000);
  expect(v("Q_AMT_1")).toBe(600000);
  expect(vars.SPEND_MO.unit).toBe("usd_mo");
  // No values in what goes out: no digits beyond counts like "last 2 complete months", and no names.
  const out = JSON.stringify(defs);
  expect(out).not.toMatch(/Robinhood|Zelle|\$/);
  for (const x of defs) expect(x.desc.replace(/\b[A-Z_]+_\d+\b/g, "")).not.toMatch(/\d/); // digits in a desc get it dropped
  // Fixed category list, same for every user: absent ones are zero locally.
  expect(defs.filter((x) => /^(CAT_|RENT_MO)/.test(x.name)).map((x) => x.name)).toEqual(GROUP_NAMES);
  expect(v("CAT_FOOD_MO")).toBe(0);
  for (const x of defs) expect(x.desc.length).toBeLessThanOrEqual(60);
  expect(defs.every((x) => !("value" in x))).toBe(true);
});

test("facts: stored with a local value, sent as a var, listed under memories, forgotten by name / N / everything", () => {
  const d = db();
  storeFact(d, { name: "U_QUIT_DATE", unit: "date", value: fromLocal(2027, 1, 1), desc: "date the user plans to quit their job" }, NOW);
  storeFact(d, { name: "U_CHECKING_NOW", unit: "usd", value: 600000, desc: "what the user says is in checking today" }, NOW);
  storeFact(d, { name: "U_CHECKING_NOW", unit: "usd", value: 610000, desc: "what the user says is in checking today" }, NOW + 5); // replaces
  expect(listFacts(d).map((f) => [f.name, f.value])).toEqual([["U_QUIT_DATE", fromLocal(2027, 1, 1)], ["U_CHECKING_NOW", 610000]]);
  const { defs, vars } = varDefs(d, NOW);
  expect(vars.U_QUIT_DATE.value).toBe(fromLocal(2027, 1, 1));
  expect(defs.find((x) => x.name === "U_CHECKING_NOW")!.desc).toBe("fact: what the user says is in checking today");
  const list = runMemory(d, { kind: "memories" }, NOW);
  expect(list).toContain("date the user plans to quit their job: Jan 1, 2027");
  expect(list).toContain("what the user says is in checking today: $6,100");
  expect(forgetFact(d, "U_QUIT_DATE")).toBe(true);
  expect(listFacts(d).map((f) => f.name)).toEqual(["U_CHECKING_NOW"]);
  const n = runMemory(d, { kind: "memories" }, NOW).split("\n").findIndex((l) => l.includes("checking today"));
  runMemory(d, { kind: "forget", n }, NOW);
  expect(listFacts(d)).toEqual([]);
  storeFact(d, { name: "U_X", unit: "number", value: 1, desc: "x" }, NOW);
  answerForgetAll(d, 1, NOW);
  expect(listFacts(d)).toEqual([]);
});

test("reset-user clears facts", () => {
  const d = db();
  storeFact(d, { name: "U_QUIT_DATE", unit: "date", value: fromLocal(2027, 1, 1), desc: "quit date" }, NOW);
  const path = paths.at(-1)!;
  d.close();
  const r = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "..", "scripts", "reset-user.ts"), "--db", path]);
  expect(r.exitCode).toBe(0);
  expect((openDb(path).query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n).toBe(0);
});
