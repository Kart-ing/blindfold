import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { setReason } from "../src/calc/execute.ts";
import type { Plan, VarDef } from "../src/calc/types.ts";
import { symbolizeText } from "../src/cloud/symbolize.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { resetLuna, setConverse } from "../src/imessage/luna.ts";
import { route } from "../src/imessage/router.ts";
import { listFacts } from "../src/memory/facts.ts";

// The human's live messages (Oct 22), sent in this order.
const M1 = "goal 40000 by december\n\nBasically come Jan 1st I wanna quit and take a long trip, and survive on my savings till they run to 0.\n\nMy rent is the money I send my friend Priya every month, and my spend won’t reduce much. How much do I need to save per month for November and December.\n\nAlso, everything in my checking account is also savings rn, cause bills for the month are paid, and also I have another 10k in Robinhood";
const M2 = "So I have around 6k in my checking too which goes into savings and we’re only on October 22nd, I have another 5.2k coming for October, which should help too.";
const M3 = "Yes, so my saving at the end of October would be 19 to 22k right?";
const NOW = fromLocal(2026, 10, 22, 16, 30);
const paths: string[] = [];
const prev = { voice: process.env.VOICE, brain: process.env.BRAIN };
beforeEach(() => { process.env.VOICE = "cloud"; delete process.env.BRAIN; });
afterEach(() => {
  setReason(undefined); setConverse(undefined); resetLuna();
  for (const [k, v] of [["VOICE", prev.voice], ["BRAIN", prev.brain]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

/** Synthetic, real-shaped: $6k savings, $3.3k checking statement; Aug/Sep $10.2k pay, $4.5k spend avg. */
function db(): Database {
  const p = join(tmpdir(), `fin-exec-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run(`INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES
    ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600000), ('chk', 'Checking', 'depository', 'checking', 0, 'me', 330000)`);
  for (const [m, spend] of [[8, 310000], [9, 590000]]) {
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, -1020000, 'Payroll', 'INCOME')", [`i${m}`, fromLocal(2026, m, 1, 12)]);
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, ?, 'Life', 'GENERAL_MERCHANDISE')", [`s${m}`, fromLocal(2026, m, 10, 12), spend]);
  }
  return d;
}

/** A fake reason(): records what it was sent, returns the Plan a model would write for that message. */
function fakeReason(plans: ((names: Set<string>) => Plan)[], seen: { defs: VarDef[]; text: string }[] = []) {
  let i = 0;
  setReason(async (d, text, _h, defs) => {
    seen.push({ defs, text });
    const { text: symbolized, qsyms } = symbolizeText(d, text);
    return { plan: plans[i++](new Set(defs.map((x) => x.name))), ledger: { question_sym: symbolized, payload_json: JSON.stringify({ reason: i }), canary_checked: 3, canary_hits: 0 }, qsyms, symbolized };
  });
}
const deps = { fm: noFm, loadHandler: async () => null };

// What Sol would write for each live message (names only; the Mac has the values).
const P1: Plan = {
  actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "December" }, { type: "add_asset", name: "Robinhood", amount: "Q_AMT_2" }],
  facts: [{ name: "U_QUIT_DATE", unit: "date", expr: 'date("2027-01-01")', desc: "date the user plans to quit their job" },
    { name: "U_CHECKING_IS_SAVINGS", unit: "bool", expr: "1 == 1", desc: "the user counts their checking balance as savings" }],
  forget_facts: [],
  equations: [
    { name: "have_now", expr: "SAVINGS + Q_AMT_2 + CHECKING" },
    { name: "months_left", expr: "months_between(TODAY, GOAL_DEADLINE)" },
    { name: "need_mo", expr: "(GOAL_TARGET - have_now) / months_left" },
    { name: "short_mo", expr: "need_mo - NET_MO" },
    { name: "at_quit", expr: "have_now + NET_MO * months_between(TODAY, U_QUIT_DATE)" },
    { name: "runway", expr: "at_quit / SPEND_MO" },
    { name: "runway_end", expr: "add_months(U_QUIT_DATE, runway)" },
  ],
  reply: "To hit {GOAL_TARGET} by {GOAL_DEADLINE|day} you need about {need_mo|usd_mo} from now; you're netting {NET_MO|usd_mo}, so about {short_mo|usd_mo} short.\nIf you quit {U_QUIT_DATE|day}: about {at_quit} then, which lasts {runway|months} months on {SPEND_MO|usd_mo}, into {runway_end|when}.",
};
const P2: Plan = {
  actions: [],
  facts: [{ name: "U_CHECKING_NOW", unit: "usd", expr: "Q_AMT_1", desc: "what the user says is in checking today" },
    { name: "U_OCT_PAY_LEFT", unit: "usd", expr: "Q_AMT_2", desc: "pay still coming this month" }],
  forget_facts: [],
  equations: [
    { name: "have_now", expr: "SAVINGS + ASSET_1 + U_CHECKING_NOW" },
    { name: "full_months", expr: "months_between(next_month_start(TODAY), GOAL_DEADLINE)" },
    { name: "need_mo", expr: "(GOAL_TARGET - have_now - U_OCT_PAY_LEFT) / full_months" },
    { name: "at_quit", expr: "have_now + U_OCT_PAY_LEFT + NET_MO * months_between(next_month_start(TODAY), U_QUIT_DATE)" },
    { name: "runway", expr: "at_quit / SPEND_MO" },
    { name: "runway_end", expr: "add_months(U_QUIT_DATE, runway)" },
  ],
  reply: "Now about {have_now}. You need about {need_mo|usd_mo} in November and December.\nOn {U_QUIT_DATE|day} you'd have about {at_quit}: {runway|months} months, into {runway_end|when}.",
};
const P3: Plan = {
  actions: [], facts: [], forget_facts: [],
  equations: [{ name: "end_oct", expr: "SAVINGS + ASSET_1 + U_CHECKING_NOW + U_OCT_PAY_LEFT" }],
  reply: "Not quite: about {end_oct} by the end of October, counting the pay still coming.",
};

test("the human's three live messages: actions, facts and equations run locally; replies filled with real numbers", async () => {
  const d = db();
  const seen: { defs: VarDef[]; text: string }[] = [];
  fakeReason([() => P1, () => P2, () => P3], seen);
  const r1 = await route(d, M1, { now: NOW }, deps);
  expect(r1.tier).toBe("cloud");
  // (40k − 19.3k) / 2.3 mo; 19.3k + 5.7k × 2.3 → ~32.5k ÷ 4.5k ≈ 7.2 months
  expect(r1.text).toStartWith("To hit $40k by Dec 31 you need about $9,038/mo from now; you're netting $5,700/mo, so about $3,338/mo short.\nIf you quit Jan 1, 2027: about $32,539 then, which lasts 7.2 months on $4,500/mo, into early-August 2027.");
  expect(r1.text).toContain("Noted: about $10k in Robinhood.");
  expect(r1.text).toContain("Teach me anything"); // the first goal's tail
  expect(listFacts(d).map((f) => f.name).sort()).toEqual(["U_CHECKING_IS_SAVINGS", "U_QUIT_DATE"]);

  const r2 = await route(d, M2, { now: NOW + 60 }, deps);
  // 6k + 10k + 6k = 22k now; (40 − 22 − 5.2) / 2 = 6.4k/mo; 22 + 5.2 + 5.7 × 2 = 38.6k → 8.6 months, into mid-Sep
  expect(r2.text).toBe("Now about $22k. You need about $6,505/mo in November and December.\nOn Jan 1, 2027 you'd have about $38,600: 8.6 months, into mid-September 2027.");
  const r3 = await route(d, M3, { now: NOW + 120 }, deps);
  expect(r3.text).toBe("Not quite: about $27,200 by the end of October, counting the pay still coming.");

  // What went out: names, units, descriptions. Never a value, never a real name.
  const out = JSON.stringify(seen.map((s) => s.defs));
  for (const real of ["600000", "330000", "1020000", "Robinhood", "Priya"]) expect(out).not.toContain(real);
  expect(seen[1].defs.map((x) => x.name)).toEqual(expect.arrayContaining(["U_QUIT_DATE", "GOAL_TARGET", "ASSET_1"]));
  // One ledger row per answer, tier cloud, with reason()'s payload.
  expect(d.query("SELECT tier, payload_json FROM ledger ORDER BY id").all()).toEqual([
    { tier: "cloud", payload_json: JSON.stringify({ reason: 1 }) }, { tier: "cloud", payload_json: JSON.stringify({ reason: 2 }) }, { tier: "cloud", payload_json: JSON.stringify({ reason: 3 }) }]);
});

test("a plan whose equations fail → the local fallback answers, and the row still records what was sent", async () => {
  const d = db();
  d.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (4000000, ?, ?, 600000, 1)", [fromLocal(2026, 12, 31, 23, 59), NOW - 60]);
  fakeReason([() => ({ actions: [], facts: [], forget_facts: [], equations: [{ name: "x", expr: "SAVINGS / 0" }], reply: "{x}" })]);
  const r = await route(d, "am I on track for my goal?", { now: NOW }, deps);
  expect(r.text).not.toContain("{x}");
  const row = d.query("SELECT tier, payload_json FROM ledger").get() as any;
  expect(row.tier).toBe("cloud");
  expect(row.payload_json).toContain("reason");
});

test("reason sent but failed ({ failed, ledger }) → the fallback answers; the row is tier cloud with that payload", async () => {
  const d = db();
  setReason(async () => ({ failed: true, ledger: { payload_json: JSON.stringify({ sent: 1 }), canary_checked: 2, canary_hits: 0 } }));
  const r = await route(d, "how much did I spend in September?", { now: NOW }, deps);
  expect(r.text).not.toBe("");
  expect(d.query("SELECT tier, payload_json FROM ledger").get()).toMatchObject({ tier: "cloud", payload_json: expect.stringContaining('"sent":1') });
});

test("reason unavailable → today's local handlers; VOICE=plain never calls reason", async () => {
  const d = db();
  setReason(null);
  expect((await route(d, "can I afford a $400 jacket?", { now: NOW }, deps)).text).not.toBe("");
  let called = 0;
  setReason(async () => { called++; return null; });
  process.env.VOICE = "plain";
  await route(d, "how long would my savings last?", { now: NOW }, deps);
  expect(called).toBe(0);
});

test("acceptance 4: 'Can I buy a $400 jacket?' via the reason path", async () => {
  const d = db();
  fakeReason([() => ({ actions: [], facts: [], forget_facts: [], equations: [{ name: "after", expr: "SAVINGS - Q_AMT_1" }, { name: "ok", expr: "after > Q_AMT_1" }],
    reply: "[[if ok]]Yes: you'd still have {after} in savings.[[else]]Better not: it would leave {after}.[[end]]" })]);
  expect((await route(d, "Can I buy a $400 jacket?", { now: NOW }, deps)).text).toBe("Yes: you'd still have $5,600 in savings.");
});
