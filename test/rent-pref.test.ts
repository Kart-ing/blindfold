import { afterAll, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { FIRST_GOAL_TAIL, resetLuna, setConverse } from "../src/imessage/luna.ts";
import { route } from "../src/imessage/router.ts";
import { rentPayee } from "../src/memory/rent.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

// The human's live sentence (Oct 22, 16:11).
const LIVE = "goal 40000 by december\n\nYou know my savings, my rent is the money I send my friend Priya every month.";
const NOW = fromLocal(2026, 10, 22, 16, 20);
const paths: string[] = [];
const prevVoice = process.env.VOICE;
afterEach(() => { setConverse(undefined); resetLuna(); if (prevVoice === undefined) delete process.env.VOICE; else process.env.VOICE = prevVoice; });
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

/** Synthetic: Zelle to Priya Doe $2,000 (Sep 3, already rent) and $1,500 (Sep 30, filed as TRANSFER_OUT). */
function db(): Database {
  const p = join(tmpdir(), `fin-rent-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run("INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES ('chk', 'Checking', 'depository', 'checking', 0, 'me', 300000), ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600000)");
  const tx = (id: string, ts: number, c: number, cat: string, memo: string) =>
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category, memo) VALUES (?, 'chk', ?, ?, 'Zelle', ?, ?)", [id, ts, c, cat, memo]);
  tx("z1", fromLocal(2026, 9, 3, 12), 200000, "RENT_AND_UTILITIES", "Zelle to Priya Doe");
  tx("z2", fromLocal(2026, 9, 30, 12), 150000, "TRANSFER_OUT", "Zelle to Priya Doe");
  tx("z3", fromLocal(2026, 9, 8, 12), -20000, "TRANSFER_IN", "Zelle from Priya Doe");
  d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES ('p8', 'chk', ?, -1000000, 'Payroll', 'INCOME'), ('p9', 'chk', ?, -1000000, 'Payroll', 'INCOME')",
    [fromLocal(2026, 8, 1, 12), fromLocal(2026, 9, 1, 12)]);
  return d;
}
const luna = (actions: (sym: (c: string) => string) => unknown[]) => setConverse({
  async understand(_d: Database, text: string) {
    const qsyms: Record<string, string> = {};
    const sym = (c: string) => { const k = `Q_AMT_${Object.keys(qsyms).length + 1}`; qsyms[k] = c; return k; };
    return { intent: "none", actions: actions(sym), qsyms, symbolized: text, ledger: { canary_checked: 1, canary_hits: 0 } };
  },
  async phrase() { return { template: null, ledger: {} }; },
} as any);
const cat = (d: Database, id: string) => (d.query("SELECT category AS c FROM transactions WHERE id = ?").get(id) as { c: string }).c;

test("payee parsing", () => {
  expect(rentPayee(LIVE)).toBe("Priya");
  expect(rentPayee("I pay Priya Doe rent")).toBe("Priya Doe");
  expect(rentPayee("I send my mom money every month")).toBeNull(); // no rent/bills
});

test("live 16:11 via Luna: first goal gets the onboarding tail; rent preference confirmed with ~$/mo; categories set", async () => {
  process.env.VOICE = "cloud";
  luna((sym) => [{ type: "set_goal", amount: sym("4000000"), by: "December" }, { type: "remember", text: "MEMO_1" }]);
  const d = db();
  const r = await route(d, LIVE, { now: NOW }, { fm: noFm, loadHandler: async () => null });
  expect(r.text.split("\n")[0]).toBe("Got it: your transfers to Priya (~$1.8k/mo) are rent.");
  expect(r.text).toContain("$40k");
  expect(r.text).toEndWith(FIRST_GOAL_TAIL);
  expect([cat(d, "z1"), cat(d, "z2"), cat(d, "z3")]).toEqual(["RENT_AND_UTILITIES", "RENT_AND_UTILITIES", "TRANSFER_IN"]);
  // A second goal change: no tail again.
  luna((sym) => [{ type: "set_goal", amount: sym("3000000"), by: "December" }]);
  expect((await route(d, "change the goal to 30k", { now: NOW + 60 }, { fm: noFm, loadHandler: async () => null })).text).not.toContain(FIRST_GOAL_TAIL);
});

test("'remember …' command does the same, and forgetting it puts the category back", async () => {
  process.env.VOICE = "plain";
  const d = db();
  const deps = { fm: noFm, loadHandler: async () => null };
  expect((await route(d, "remember my rent is the money I send my friend Priya every month", { now: NOW }, deps)).text)
    .toBe("Got it: your transfers to Priya (~$1.8k/mo) are rent.");
  expect(cat(d, "z2")).toBe("RENT_AND_UTILITIES");
  await route(d, "forget 1", { now: NOW + 60 }, deps);
  expect(cat(d, "z2")).toBe("TRANSFER_OUT");
  expect(cat(d, "z1")).toBe("RENT_AND_UTILITIES"); // was already rent: untouched
});
