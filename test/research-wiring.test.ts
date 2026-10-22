import { afterAll, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { resetLuna, setConverse } from "../src/imessage/luna.ts";
import { RESEARCH_DOWN, setResearch } from "../src/imessage/research.ts";
import { route } from "../src/imessage/router.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

// The human's live sentence (Oct 22).
const JACKET = "I wanted to buy this jacket - 400$ Arteryx - could you look at its reviews and tell me if it's worth it.";
const NOW = fromLocal(2026, 10, 22, 16, 30);
const paths: string[] = [];
const prev = { voice: process.env.VOICE, ms: process.env.RESEARCH_REPLY_MS };
afterEach(() => {
  setConverse(undefined); setResearch(undefined); resetLuna();
  for (const [k, v] of [["VOICE", prev.voice], ["RESEARCH_REPLY_MS", prev.ms]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

function db(): Database {
  const p = join(tmpdir(), `fin-research-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run("INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES ('sav', 'Savings', 'depository', 'savings', 0, 'me', 1600000), ('chk', 'Checking', 'depository', 'checking', 0, 'me', 300000)");
  for (const m of [8, 9]) {
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, -1000000, 'Payroll', 'INCOME')", [`i${m}`, fromLocal(2026, m, 1, 12)]);
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, 450000, 'Life', 'GENERAL_MERCHANDISE')", [`s${m}`, fromLocal(2026, m, 10, 12)]);
  }
  d.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (4000000, ?, ?, 1600000, 1)", [fromLocal(2026, 12, 31), NOW - 86_400]);
  return d;
}
const lunaSays = (intent: string) => setConverse({
  understand: async (_d: Database, text: string) => ({ intent, actions: [{ type: "ask", intent: "other" }], qsyms: {}, symbolized: text, ledger: { payload_json: JSON.stringify({ u: 1 }), canary_checked: 1, canary_hits: 0 } }),
  phrase: async () => ({ template: null, ledger: {} }),
} as any);
const deps = (seen: string[]) => ({ fm: noFm, loadHandler: async (i: any) => { seen.push(i); return null; } });

test("research intent: reviews from research(), then the local money verdict, one reply, one merged row; never the planner", async () => {
  process.env.VOICE = "cloud";
  lunaSays("research");
  let asked = "";
  setResearch(() => async (_d, text) => { asked = text; return { text: "Reviews say it's warm and lasts years. Sources: a.com, b.com.", tier: "cloud", ledger: { payload_json: JSON.stringify({ r: 1 }), canary_checked: 2, canary_hits: 0 } }; });
  const d = db(), seen: string[] = [];
  const r = await route(d, JACKET, { now: NOW }, deps(seen));
  expect(asked).toBe(JACKET);
  expect(r.text).toStartWith("Reviews say it's warm and lasts years. Sources: a.com, b.com.\n\nMoney-wise: ");
  expect(r.text).toContain("$400");
  expect(seen).toEqual([]);
  const row = d.query("SELECT tier, intent, payload_json, canary_checked FROM ledger").get() as any;
  expect(row).toMatchObject({ tier: "cloud", intent: "research", canary_checked: 3 });
  expect(JSON.parse(row.payload_json)).toEqual([{ u: 1 }, { r: 1 }]);
});

test("research fails → the afford verdict + 'I couldn't look up reviews right now.'", async () => {
  process.env.VOICE = "cloud";
  lunaSays("research");
  setResearch(() => async () => { throw new Error("down"); });
  const r = await route(db(), JACKET, { now: NOW }, deps([]));
  expect(r.text).toContain("$400");
  expect(r.text).toEndWith(`\n${RESEARCH_DOWN}`);
});

test("research slower than the cap → the verdict + the limit, and the ledger says the query may have left", async () => {
  process.env.VOICE = "cloud";
  process.env.RESEARCH_REPLY_MS = "150";
  lunaSays("research");
  setResearch(() => () => new Promise(() => {}));
  const d = db();
  const t0 = performance.now();
  const r = await route(d, JACKET, { now: NOW }, deps([]));
  expect(performance.now() - t0).toBeLessThan(1500);
  expect(r.text).toEndWith(`\n${RESEARCH_DOWN}`);
  expect((d.query("SELECT payload_json FROM ledger").get() as any).payload_json).toContain("timed out");
});

test("the cap pauses while research waits on a consent answer (the user's typing time isn't the lookup's)", async () => {
  process.env.VOICE = "cloud";
  process.env.RESEARCH_REPLY_MS = "150";
  lunaSays("research");
  const { setConsentSender, takeConsentAnswer, resetConsent } = await import("../src/imessage/consent.ts");
  setConsentSender(async () => { setTimeout(() => takeConsentAnswer("1"), 400); }); // the user answers after 400 ms
  let grant = "";
  setResearch((ask) => async (d, _t, c) => { grant = await ask(d, "research:MERCHANT_1", "Look up MERCHANT_1?", c); return { text: "Reviews say fine. Sources: a.com.", tier: "cloud" }; });
  try {
    const r = await route(db(), "what's a good winter jacket?", { now: NOW }, deps([]));
    expect(grant).toBe("once");
    expect(r.text).toBe("Reviews say fine. Sources: a.com.");
  } finally { resetConsent(); }
});

test("Luna off: a reviews question still goes to research, with the verdict", async () => {
  process.env.VOICE = "plain";
  setResearch(() => async () => ({ text: "Reviews say great. Sources: a.com.", tier: "cloud", ledger: {} }));
  const r = await route(db(), JACKET, { now: NOW }, deps([]));
  expect(r.text).toStartWith("Reviews say great. Sources: a.com.\n\nMoney-wise: ");
});
