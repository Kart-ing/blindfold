// Money-math fixes in src/cloud/dsl.ts (codex review items 12–14, 17–20). One describe per item.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, validatePlan } from "../src/cloud/dsl.ts";
import { openDb } from "../src/db.ts";
import { fromLocal } from "../src/imessage/clock.ts";

const NOW = fromLocal(2026, 10, 22, 12, 0);
const ctx = { now: NOW };
const paths: string[] = [];
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

let n = 0;
function db() {
  const p = join(tmpdir(), `fin-dsl-${process.pid}-${Date.now()}-${n++}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run(`INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES
    ('chk', 'Checking', 'depository', 'checking', 0, 'me', 300000),
    ('amex', 'Shared Amex', 'credit', 'credit card', 1, 'shared', 90000)`);
  return d;
}
let t = 0;
function txn(d: ReturnType<typeof db>, o: { cents: number; cat?: string; merchant?: string; ts?: number; acct?: string; owner?: string }) {
  const id = `t${t++}`;
  d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, ?, ?, ?, ?, ?)",
    [id, o.acct ?? "chk", o.ts ?? fromLocal(2026, 10, 10, 12, 0), o.cents, o.merchant ?? "Shop", o.cat ?? "GENERAL_MERCHANDISE"]);
  if (o.owner) d.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES (?, ?, 7, 1)", [id, o.owner]);
  return id;
}
const run = (d: ReturnType<typeof db>, plan: unknown, q: Record<string, string> = {}) => {
  const v = validatePlan(plan);
  if (!v.ok) throw new Error(v.error);
  return executePlan(d, v.plan, ctx, q);
};
const invalid = (plan: unknown) => { const v = validatePlan(plan); return v.ok ? null : v.error; };

describe("#12 only Q_AMT in money ops; missing symbols throw", () => {
  const sum = { id: "s1", op: "sum", filter: { month: "M-0" } };
  test("Q_NUM can't be compared, diffed or projected", () => {
    for (const op of ["compare", "diff"])
      expect(invalid({ steps: [sum, { id: "s2", op, inputs: ["s1", "Q_NUM_1"] }], answer_template: op === "compare" ? "{s2:y|n}" : "{s2}" }))
        .toContain("only Q_AMT_n");
    expect(invalid({ steps: [sum, { id: "s2", op: "project", inputs: ["s1", "Q_NUM_1"], months: 2 }], answer_template: "{s2}" })).toContain("only Q_AMT_n");
  });
  test("$100 spent, 'over 400' as Q_NUM is rejected instead of comparing 10000 >= 400", () => {
    const d = db();
    txn(d, { cents: 10000 });
    expect(() => run(d, { steps: [sum, { id: "s2", op: "compare", inputs: ["s1", "Q_NUM_1"] }], answer_template: "{s2:y|n}" }, { Q_NUM_1: "400" })).toThrow();
    expect(run(d, { steps: [sum, { id: "s2", op: "compare", inputs: ["s1", "Q_AMT_1"], cmp: "gt" }], answer_template: "{s2:y|n}" }, { Q_AMT_1: "40000" }).s2.v).toBe(false);
  });
  test("a Q_AMT the question never had throws, never becomes 0", () => {
    const d = db();
    txn(d, { cents: 10000 });
    expect(() => run(d, { steps: [sum, { id: "s2", op: "diff", inputs: ["s1", "Q_AMT_99"] }], answer_template: "{s2}" }, {})).toThrow("Q_AMT_99 has no value");
    expect(() => run(d, { steps: [sum, { id: "s2", op: "diff", inputs: ["s1", "Q_AMT_1"] }], answer_template: "{s2}" }, { Q_AMT_1: "abc" })).toThrow();
  });
});

describe("#13 unqualified inflow is income", () => {
  test("salary + transfer in: inflow = salary only; transfers only when asked for", () => {
    const d = db();
    txn(d, { cents: -100000, cat: "INCOME" });
    txn(d, { cents: -500000, cat: "TRANSFER_IN" });
    const r = run(d, { steps: [
      { id: "s1", op: "sum", filter: { direction: "inflow", month: "M-0" } },
      { id: "s2", op: "sum", filter: { direction: "inflow", month: "M-0", category: "TRANSFER_IN" } },
      { id: "s3", op: "avg_monthly", filter: { direction: "inflow", months: 1 } },
    ], answer_template: "{s1} {s2} {s3}" });
    expect(r.s1.v).toBe(100000);
    expect(r.s2.v).toBe(500000);
  });
});

describe("#14 balance: net worth subtracts credit debt; typed balances stay separate", () => {
  test("$3,000 checking and $900 owed on a shared card → net $2,550", () => {
    const r = run(db(), { steps: [
      { id: "s1", op: "balance" },
      { id: "s2", op: "balance", filter: { account_type: "depository" } },
      { id: "s3", op: "balance", filter: { account_type: "credit" } },
    ], answer_template: "{s1} {s2} {s3}" });
    expect(r.s1.v).toBe(255000);
    expect(r.s2.v).toBe(300000);
    expect(r.s3.v).toBe(45000); // my half of the debt
  });
  test("her account counts for nothing", () => {
    const d = db();
    d.run("INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES ('hers', 'Hers', 'depository', 'checking', 0, 'her', 999999)");
    expect(run(d, { steps: [{ id: "s1", op: "balance" }], answer_template: "{s1}" }).s1.v).toBe(255000);
  });
});

describe("#17 units: no arithmetic across incompatible kinds", () => {
  const sum = { id: "s1", op: "sum", filter: { month: "M-0" } };
  const count = { id: "s2", op: "count", filter: { month: "M-0" } };
  const byCat = (id: string, month: string) => ({ id, op: "group_by", by: "category", filter: { month } });
  test("diff(sum, count) is rejected", () => {
    expect(invalid({ steps: [sum, count, { id: "s3", op: "diff", inputs: ["s1", "s2"] }], answer_template: "{s3}" })).toContain("matching units");
  });
  test("category list minus merchant list is rejected; same dimension is fine", () => {
    const byMerchant = { id: "s2", op: "group_by", by: "merchant_sym", filter: { month: "M-1" } };
    expect(invalid({ steps: [byCat("s1", "M-0"), byMerchant, { id: "s3", op: "diff", inputs: ["s1", "s2"] }], answer_template: "{s3}" })).toContain("matching units");
    expect(invalid({ steps: [byCat("s1", "M-0"), byCat("s2", "M-1"), { id: "s3", op: "diff", inputs: ["s1", "s2"] }], answer_template: "{s3}" })).toBeNull();
  });
  test("compare(count, Q_AMT), project(count, cents), diff(list, scalar) and top_n(scalar) are rejected", () => {
    expect(invalid({ steps: [count, { id: "s3", op: "compare", inputs: ["s2", "Q_AMT_1"] }], answer_template: "{s3:y|n}" })).toContain("same unit");
    expect(invalid({ steps: [sum, count, { id: "s3", op: "project", inputs: ["s2", "s1"], months: 3 }], answer_template: "{s3}" })).toContain("cents inputs");
    expect(invalid({ steps: [sum, byCat("s2", "M-0"), { id: "s3", op: "diff", inputs: ["s2", "s1"] }], answer_template: "{s3}" })).toContain("matching units");
    expect(invalid({ steps: [sum, { id: "s3", op: "top_n", inputs: ["s1"], n: 3 }], answer_template: "{s3}" })).toContain("needs a list");
  });
  test("count vs count compares; top_n keeps the list's dimension for diff", () => {
    expect(invalid({ steps: [count, { id: "s3", op: "count", filter: { month: "M-1" } }, { id: "s4", op: "compare", inputs: ["s2", "s3"], cmp: "gt" }], answer_template: "{s4:y|n}" })).toBeNull();
    expect(invalid({ steps: [byCat("s1", "M-0"), byCat("s2", "M-1"), { id: "s3", op: "top_n", inputs: ["s1"], n: 3 }, { id: "s4", op: "diff", inputs: ["s3", "s2"] }], answer_template: "{s4}" })).toBeNull();
  });
});

describe("#18 one integer-cent allocation per transaction, so aggregates reconcile", () => {
  test("shared odd cents: sum equals the sum of category totals", () => {
    const d = db();
    txn(d, { cents: 101, cat: "FOOD_AND_DRINK", acct: "amex", owner: "shared" });
    txn(d, { cents: 301, cat: "TRANSPORTATION", acct: "amex", owner: "shared" });
    txn(d, { cents: 1, cat: "ENTERTAINMENT", acct: "amex", owner: "shared" });
    const r = run(d, { steps: [
      { id: "s1", op: "sum", filter: { month: "M-0" } },
      { id: "s2", op: "group_by", by: "category", filter: { month: "M-0" } },
    ], answer_template: "{s1} {s2}" });
    const parts = (r.s2.v as { cents: number }[]).reduce((a, x) => a + x.cents, 0);
    expect(r.s1.v).toBe(50 + 150 + 0); // floor(half) to me; the odd cent is hers
    expect(parts).toBe(r.s1.v);
    expect((r.s2.v as { cents: number }[]).every((x) => Number.isInteger(x.cents))).toBe(true);
  });
});

describe("#19 recurring median of an even sample averages the middle two", () => {
  test("$10, $11, $12, $13 over four months → $11.50", () => {
    const d = db();
    [[7, 1000], [8, 1100], [9, 1200], [10, 1300]].forEach(([m, c]) => txn(d, { cents: c, merchant: "Gym", ts: fromLocal(2026, m, 5, 9, 0) }));
    d.run("INSERT INTO symbols(symbol, real, kind) VALUES ('MERCHANT_1', 'Gym', 'merchant')");
    const r = run(d, { steps: [{ id: "s1", op: "recurring" }], answer_template: "{s1}" });
    expect(r.s1.v).toEqual([{ key: "MERCHANT_1", cents: 1150 }]);
  });
});

describe("#20 compare takes an explicit gt|gte|lt|lte", () => {
  const plan = (cmp?: string) => ({
    steps: [{ id: "s1", op: "sum", filter: { month: "M-0" } }, { id: "s2", op: "compare", inputs: ["s1", "Q_AMT_1"], ...(cmp ? { cmp } : {}) }],
    answer_template: "{s2:yes|no}",
  });
  test("spend exactly $3,000 vs 'over $3k'", () => {
    const d = db();
    txn(d, { cents: 300000 });
    const q = { Q_AMT_1: "300000" };
    expect(run(d, plan("gt"), q).s2.v).toBe(false);
    expect(run(d, plan("gte"), q).s2.v).toBe(true);
    expect(run(d, plan("lt"), q).s2.v).toBe(false);
    expect(run(d, plan("lte"), q).s2.v).toBe(true);
    expect(run(d, plan(), q).s2.v).toBe(true); // omitted: gte (back-compat)
    expect(invalid(plan(">="))).toContain("cmp must be gt|gte|lt|lte");
  });
});
