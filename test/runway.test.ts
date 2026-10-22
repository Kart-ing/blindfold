import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { isRunwayQuestion, parseInflow, parseStop, runwayAnswer, savingsCheck, statedBase, statedEstimate, statedFloor, statedSpend } from "../src/handlers/runway.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { resetLuna, setConverse } from "../src/imessage/luna.ts";
import { route } from "../src/imessage/router.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

// The human's live sentences (Oct 22), in the order they were sent.
const A = "Say my income stops January 1st + I have another 5.2k coming for October + the money in my checking account will also move to saving cause I’ve already paid all my bills for the month";
const B = "Ok, what will happen then, if I loose my income in January, will I survive and how many months if I deplete my savings to 0";
const C = "I’m already at 16k no? 6k in savings, 10k in Robinhood.";
const LIVE1 = "If I lost my job on the first day of January while saving the same amount I do today, how many months could I survive with my current expenditure?";
const LIVE2 = "2 months, my current spending is 4.5k and with all my savings, id’s have 35k ish that’s almost 8 months right?";
const NOW = fromLocal(2026, 10, 22, 15, 51);

const paths: string[] = [];
const prevVoice = process.env.VOICE;
afterEach(() => { setConverse(undefined); resetLuna(); if (prevVoice === undefined) delete process.env.VOICE; else process.env.VOICE = prevVoice; });
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

/** Synthetic: $6k savings + $10k told (Robinhood) + $3.3k checking; Aug and Sep: $10.2k pay, $3.1k and $5.9k spend. */
function db(): Database {
  const p = join(tmpdir(), `fin-runway-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  const d = openDb(p);
  d.run(`INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES
    ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600000), ('chk', 'Checking', 'depository', 'checking', 0, 'me', 330000)`);
  d.run("INSERT INTO manual_assets(name, amount_cents, created_ts) VALUES ('Robinhood', 1000000, ?)", [NOW - 3600]);
  for (const [m, spend] of [[8, 310000], [9, 590000]]) {
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, -1020000, 'Payroll', 'INCOME')", [`i${m}`, fromLocal(2026, m, 1, 12, 0)]);
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'chk', ?, ?, 'Life', 'GENERAL_MERCHANDISE')", [`s${m}`, fromLocal(2026, m, 10, 12, 0), spend]);
  }
  return d;
}
const lines = (t: string) => t.split("\n");
const BREAKDOWN = "Jan 1: ~$35.9k = $16k saved + $3.3k checking + $5.2k October pay + ~$11.4k Nov–Dec surplus. ÷ ~$4.5k/mo spending.";

describe("runway parsing", () => {
  test("the live phrasings are runway questions; goal and spending questions aren't", () => {
    for (const t of [A, B, LIVE1, LIVE2, "If I lost my job in December, how long would I last?", "what's my runway", "if I get laid off, how long could I last?"])
      expect(isRunwayQuestion(t)).toBe(true);
    for (const t of [C, "can I afford a $400 jacket?", "how much did I spend on food last month", "how long until I reach my goal?", "how many months until my deadline?", "I may lose weight"])
      expect(isRunwayQuestion(t)).toBe(false);
  });
  test("stop date is the one tied to the stop verb, not the first month in the text", () => {
    expect(parseStop(A, NOW)!.label).toBe("Jan 1");
    expect(parseStop(B, NOW)!.label).toBe("Jan 1");
    expect(parseStop(LIVE1, NOW)!.label).toBe("Jan 1");
    expect(parseStop("I want 40k by the end of March. If I lost my job in December, how long would I last?", NOW)!.label).toBe("Dec 1");
    expect(parseStop("say my income stops at the end of November", NOW)!.label).toBe("Dec 1");
    expect(parseStop("what if I lose my job in October", NOW)!.ts).toBe(NOW); // this month: from now
    expect(parseStop(C, NOW)).toBeNull();
  });
  test("inflow, spend, own figures, floor", () => {
    expect(parseInflow(A, NOW)).toEqual({ cents: 520000, monthStart: fromLocal(2026, 10, 1) });
    expect(parseInflow(C, NOW)).toBeNull();
    expect(statedSpend(LIVE2)).toBe(450000);
    expect(statedSpend("my rent is around 1800$ a month")).toBeNull();
    expect(statedBase(LIVE2)).toBe(3500000);
    expect(statedEstimate(LIVE2)).toBe(8);
    expect(statedEstimate(B)).toBeNull();
    expect(statedFloor("how long if I keep 5k untouched?")).toBe(500000);
    expect(statedFloor("I want to keep 40k saved by December")).toBeNull();
  });
});

describe("runway answers (local, no planner)", () => {
  test("a) the scenario statement is answered with the runway, and stored", () => {
    const d = db();
    const r = runwayAnswer(d, A, NOW);
    expect(lines(r)).toEqual([
      "About 8 months, into late August 2027.",
      BREAKDOWN,
      "Assumes income stops Jan 1, the $5.2k is the rest of October's pay (not on top of it), spending stays at your Aug–Sep average and you spend down to $0.",
    ]);
    expect(JSON.parse((d.query("SELECT value FROM settings WHERE key = 'runway_scenario'").get() as { value: string }).value))
      .toMatchObject({ stopTs: fromLocal(2027, 1, 1), inflow: { cents: 520000 }, checking: true });
  });
  test("b) the follow-up applies the stored scenario (the $5.2k, Jan 1) and answers 'will I survive'", () => {
    const d = db();
    runwayAnswer(d, A, NOW);
    const r = runwayAnswer(d, B, NOW + 35);
    expect(lines(r).slice(0, 2)).toEqual(["Yes, for about 8 months, into late August 2027.", BREAKDOWN]);
  });
  test("c) 'I'm already at 16k no?' → yes with the parts, then the runway again", () => {
    const d = db();
    runwayAnswer(d, A, NOW);
    expect(savingsCheck(d, C)).toBe("Yes: $16k ($6k savings + $10k Robinhood).");
    expect(savingsCheck(d, "I'm at 25k right?")).toBe("Not quite: $16k ($6k savings + $10k Robinhood).");
    expect(savingsCheck(d, "I have 5k coming for October?")).toBeNull();
  });
  test("a stop date in the message beats the stored one: 'tomorrow' drops the stored Jan 1, the inflow and the projection", () => {
    const d = db();
    runwayAnswer(d, A, NOW);
    expect(lines(runwayAnswer(d, "how long would I last if I lost my job tomorrow?", NOW + 60)).slice(0, 2)).toEqual([
      "About 4 months, into early March 2027.",
      "Now: ~$19.3k = $16k saved + $3.3k checking. ÷ ~$4.5k/mo spending.",
    ]);
    expect(parseStop("if I lost my job next month", NOW)!.label).toBe("Nov 1");
    // A stop before the stored inflow's month drops it too.
    runwayAnswer(d, "I have 3k coming in December", NOW);
    expect(runwayAnswer(d, "what if my income stops in November?", NOW + 90)).not.toContain("inflow");
  });
  test("forget everything clears the stored scenario", async () => {
    const d = db();
    runwayAnswer(d, A, NOW);
    const { answerForgetAll } = await import("../src/memory/commands.ts");
    answerForgetAll(d, 1, NOW + 10);
    expect(d.query("SELECT value FROM settings WHERE key = 'runway_scenario'").get()).toBeNull();
  });
  test("earlier live pair: LIVE1 projects to Jan 1; LIVE2's own numbers (35k ÷ 4.5k ≈ 7.8) confirm their estimate", () => {
    const d = db();
    expect(lines(runwayAnswer(d, LIVE1, NOW)).slice(0, 2)).toEqual([
      "About 7 months, into early August 2027.",
      "Jan 1: ~$32.5k = $16k saved + $3.3k checking + ~$13.2k Oct–Dec surplus. ÷ ~$4.5k/mo spending.",
    ]);
    expect(lines(runwayAnswer(d, LIVE2, NOW + 60)).slice(0, 2)).toEqual([
      "Yes, that's right. About 8 months, into late August 2027.",
      "Jan 1: ~$35k (your figure). ÷ ~$4.5k/mo spending.",
    ]);
  });
  test("a wrong estimate is corrected explicitly; no spending data asks for the figure", () => {
    expect(runwayAnswer(db(), "my spending is 4.5k and I'd have 35k, that's 12 months right?", NOW)).toStartWith("Not quite: closer to 7.8 months, not 12.");
    const empty = openDb(join(tmpdir(), `fin-runway-empty-${process.pid}-${Date.now()}.db`));
    expect(runwayAnswer(empty, "how long would I last?", NOW)).toStartWith("I can't see enough spending yet");
  });
});

/** Fake Luna: returns what live returned for each sentence (remember ×3 / runway / add_asset + goal_status). */
function luna(intent: string | null, actions: (qsym: (c: string) => string) => unknown[]) {
  setConverse({
    async understand(_db: Database, text: string) {
      const qsyms: Record<string, string> = {};
      const sym = (c: string) => { const k = `Q_AMT_${Object.keys(qsyms).length + 1}`; qsyms[k] = c; return k; };
      return { intent, actions: actions(sym), qsyms, symbolized: text, ledger: { payload_json: JSON.stringify({ u: 1 }), canary_checked: 1, canary_hits: 0 } };
    },
    async phrase() { return { template: null, ledger: {} }; },
  } as any);
}

describe("routing (VOICE=cloud and the local fallback)", () => {
  test("live a→b→c through Luna: runway answers, one memory row, no duplicate asset, never the planner", async () => {
    process.env.VOICE = "cloud";
    const d = db();
    const seen: string[] = [];
    const deps = { fm: noFm, loadHandler: async (i: any) => { seen.push(i); return null; } };
    luna("none", () => [{ type: "remember", text: "MEMO_1" }, { type: "remember", text: "MEMO_2" }, { type: "remember", text: "MEMO_3" }]);
    const ra = await route(d, A, { now: NOW }, deps);
    expect(lines(ra.text).slice(0, 2)).toEqual(["About 8 months, into late August 2027.", BREAKDOWN]);
    expect((d.query("SELECT COUNT(*) AS n FROM memories WHERE kind = 'note'").get() as { n: number }).n).toBe(1);

    luna("runway", () => [{ type: "ask", intent: "other" }]);
    const rb = await route(d, B, { now: NOW + 35 }, deps);
    expect(lines(rb.text)[0]).toBe("Yes, for about 8 months, into late August 2027.");

    luna("goal_status", (sym) => [{ type: "add_asset", name: "Robinhood", amount: sym("1000000") }, { type: "ask", intent: "goal_status" }]);
    const rc = await route(d, C, { now: NOW + 70 }, deps);
    expect(lines(rc.text).slice(0, 3)).toEqual(["Yes: $16k ($6k savings + $10k Robinhood).", "", "About 8 months, into late August 2027."]);
    expect((d.query("SELECT COUNT(*) AS n FROM manual_assets").get() as { n: number }).n).toBe(1);
    expect(seen).toEqual([]); // no handler, so never Sol
    const rows = d.query("SELECT tier, intent FROM ledger ORDER BY id").all();
    expect(rows).toEqual([{ tier: "cloud", intent: "runway" }, { tier: "cloud", intent: "runway" }, { tier: "cloud", intent: "goal_status" }]);
  });
  test("goal + asset + runway in one message (live 15:47): goal status, then the local runway; never the planner", async () => {
    process.env.VOICE = "cloud";
    const d = db();
    const seen: string[] = [];
    luna("runway", (sym) => [{ type: "set_goal", amount: sym("4000000"), by: "December" }, { type: "ask", intent: "other" }]);
    const r = await route(d, "I want to have 40k saved up by the end of December. If I lost my job in December, how long would I last?", { now: NOW },
      { fm: noFm, loadHandler: async (i: any) => { seen.push(i); return null; } });
    expect(r.text).toContain("$40k");
    expect(r.text).toMatch(/\n\nAbout \d+ months, into .+\nDec 1: ~\$[\d.]+k = \$16k saved \+ \$3\.3k checking/);
    expect(seen).toEqual([]);
  });
  test("a remember sent with a goal is acknowledged (live 16:11)", async () => {
    process.env.VOICE = "cloud";
    luna(null, (sym) => [{ type: "set_goal", amount: sym("4000000"), by: "December" }, { type: "remember", text: "MEMO_1" }]);
    const r = await route(db(), "goal 40000 by december. my rent is the money I send my friend Priya every month.", { now: NOW }, { fm: noFm, loadHandler: async () => null });
    expect(r.text.split("\n")[0]).toBe("Got it, I'll remember that.");
    expect(r.text).toContain("$40k");
  });
  test("Luna off (VOICE=plain): the same sentences answer locally, tier local", async () => {
    process.env.VOICE = "plain";
    const d = db();
    const deps = { fm: noFm, loadHandler: async () => null };
    const ra = await route(d, A, { now: NOW }, deps);
    expect(ra.tier).toBe("local");
    expect(lines(ra.text)[0]).toBe("About 8 months, into late August 2027.");
    expect(lines((await route(d, B, { now: NOW + 35 }, deps)).text)[0]).toBe("Yes, for about 8 months, into late August 2027.");
    expect(lines((await route(d, C, { now: NOW + 70 }, deps)).text)[0]).toBe("Yes: $16k ($6k savings + $10k Robinhood).");
  });
});
