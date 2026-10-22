// Luna (cloud understanding + wording) wired through the router, with a fake converse that follows the agreed
// contract and eng3's real symbolizer. The Mac executes actions, computes numbers and fills replies.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symbolizeText } from "../src/cloud/symbolize.ts";
import { openDb } from "../src/db.ts";
import { goalStatus, savingsCents } from "../src/handlers/finance.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { lunaHistory, resetLuna, setConverse } from "../src/imessage/luna.ts";
import { setResearch } from "../src/imessage/research.ts";
import { route } from "../src/imessage/router.ts";
import { listMemories } from "../src/memory/store.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

const NOW = fromLocal(2026, 10, 22, 14, 45);
const paths: string[] = [];
let prevVoice: string | undefined;
beforeAll(() => { prevVoice = process.env.VOICE; process.env.VOICE = "cloud"; });
afterAll(() => {
  if (prevVoice === undefined) delete process.env.VOICE; else process.env.VOICE = prevVoice;
  setConverse(undefined);
  for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});
afterEach(() => { resetLuna(); setConverse(undefined); });

let n = 0;
function freshDb(): Database {
  const p = join(tmpdir(), `fin-luna-${process.pid}-${Date.now()}-${n++}.db`);
  paths.push(p);
  const db = openDb(p);
  db.run("INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600218)");
  db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES ('pay', 'sav', ?, -800000, 'Payroll', 'INCOME')", [NOW - 20 * 86_400]);
  return db;
}

const SENT1 = "I want to save 40000 by December so I can quit my job and work on my startup without worrying about rent (about 1700$) and some other stuff till my OPT runs out - which is end of June.";
const SENT2 = "I also have around 10k in my robinhood";

type Call = { fn: string; arg: unknown };
function fakeConverse(phraseTemplate: (placeholders: string[]) => string | null = (ph) => ph.map((p) => `{${p}}`).join(" · ")) {
  const calls: Call[] = [];
  const meta = (body: unknown) => ({ payload_json: JSON.stringify(body), canary_checked: 7, canary_hits: 0 });
  return {
    calls,
    converse: {
      async understand(db: Database, text: string, history: unknown[]) {
        calls.push({ fn: "understand", arg: { text, history } });
        const { text: symbolized, qsyms } = symbolizeText(db, text);
        const sym = (cents: string) => Object.keys(qsyms).find((k) => qsyms[k] === cents)!;
        const actions = /save 40000 by December/.test(text) ? [{ type: "set_goal", amount: sym("4000000"), by: "December" }]
          : /robinhood/i.test(text) ? [{ type: "add_asset", name: "Robinhood", amount: sym("1000000") }]
          : /can i (buy|afford)/i.test(text) ? [{ type: "ask", intent: "afford" }]
          : [];
        return actions.length ? { actions, qsyms, symbolized, ledger: meta({ messages: [{ role: "user", content: symbolized }] }) } : null;
      },
      async phrase(_db: Database, kind: string, situation: string, placeholders: string[]) {
        calls.push({ fn: "phrase", arg: { kind, situation, placeholders } });
        const t = phraseTemplate(placeholders);
        return t === null ? null : { template: t, ledger: meta({ messages: [{ role: "user", content: situation }] }) };
      },
    },
  };
}
const say = (db: Database, text: string, now = NOW) => route(db, text, { now }, { fm: noFm });
// A local stand-in for every handler, so a test sees only Luna's own egress in the ledger row.
const sayLocal = (db: Database, text: string, now = NOW) =>
  route(db, text, { now }, { fm: noFm, loadHandler: async () => async () => ({ text: "local answer", tier: "local" as const }) });
const ledger = (db: Database) => db.query("SELECT tier, intent, payload_json, canary_checked, canary_hits FROM ledger ORDER BY id").all() as any[];

describe("live sentence 1: the goal is the amount next to 'save', not the rent", () => {
  test("set_goal → $40,000 by December, reply from local facts, one merged cloud ledger row", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    const r = await say(db, SENT1);
    const g = goalStatus(db, NOW)!;
    expect(g.goal.target_cents).toBe(4_000_000);
    expect(new Date(g.goal.deadline * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/Los_Angeles" })).toBe("December 2026");
    expect(r.tier).toBe("cloud");
    expect(r.text).toContain("$40k");
    expect(r.text).not.toContain("1,700");
    const rows = ledger(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "cloud", intent: "goal_set", canary_checked: 14, canary_hits: 0 });
    expect(JSON.parse(rows[0].payload_json)).toHaveLength(2); // understand + phrase bodies
  });
  test("what Luna receives: symbolized text, placeholder names and a number-free situation; history keeps no values", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    await say(db, SENT1);
    const ph = f.calls.find((c) => c.fn === "phrase")!.arg as { placeholders: string[]; situation: string };
    expect(ph.placeholders.every((p) => /^[A-Z][A-Z0-9_]*$/.test(p))).toBe(true);
    expect(ph.situation).not.toMatch(/\d/);
    const h = lunaHistory();
    expect(h).toHaveLength(2);
    expect(JSON.stringify(h)).not.toMatch(/\$|40000|40,000|1700/);
  });
});

describe("live sentence 2: an outside balance", () => {
  test("add_asset → manual_assets + a memory, counts toward savings, and isn't progress", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    await say(db, SENT1);
    const before = goalStatus(db, NOW)!;
    const r = await say(db, SENT2, NOW + 30);
    expect(r.text.split("\n")[0]).toBe("Noted: about $10k in Robinhood, counted toward your goal.");
    expect(db.query("SELECT name, amount_cents, memory_id IS NOT NULL AS linked FROM manual_assets").all()).toEqual([{ name: "Robinhood", amount_cents: 1_000_000, linked: 1 }]);
    expect(listMemories(db)[0]).toMatchObject({ kind: "asset", text: "Robinhood: about $10k" });
    const after = goalStatus(db, NOW)!; // same moment as `before`, so only the asset differs
    expect(after.savings).toBe(before.savings + 1_000_000);
    expect(after.paceGap).toBe(before.paceGap); // already-had money doesn't read as "ahead of pace"
  });
  test("forget removes the asset and takes it back out of the goal's starting point", async () => {
    const db = freshDb();
    setConverse(fakeConverse().converse as any);
    await say(db, SENT1);
    const base = goalStatus(db, NOW)!;
    await say(db, SENT2, NOW + 30);
    expect((await say(db, "forget 1", NOW + 60)).text).toBe("Forgot: Robinhood: about $10k.");
    expect(db.query("SELECT COUNT(*) AS n FROM manual_assets").get()).toEqual({ n: 0 });
    const g = goalStatus(db, NOW + 60)!;
    expect(g.savings).toBe(base.savings);
    expect(g.goal.savings_at_creation_cents).toBe(base.goal.savings_at_creation_cents);
  });
});

describe("fallbacks and fast paths", () => {
  test("an invalid Luna template (digits) → the local fallback text, still one ledger row", async () => {
    const db = freshDb();
    setConverse(fakeConverse(() => "You need 14703 a month!").converse as any);
    const r = await say(db, SENT1);
    expect(r.text).toContain("$40k");
    expect(r.text).not.toContain("14703 a month!");
    expect(ledger(db)).toHaveLength(1);
  });
  test("phrase is capped (timeoutMs passed) and a timed-out phrase's egress is still recorded", async () => {
    const db = freshDb();
    let opts: any;
    setConverse({
      understand: fakeConverse().converse.understand,
      phrase: async (_db: Database, _k: string, _s: string, _p: string[], _c: unknown, o: any) => { opts = o; return { template: null, ledger: { payload_json: JSON.stringify({ phrase: 1 }), canary_checked: 2, canary_hits: 0 } }; },
    } as any);
    const prev = process.env.LUNA_PHRASE_MS;
    delete process.env.LUNA_PHRASE_MS; // .env (loaded by bun test) may set it; this asserts the default
    const r = await say(db, SENT1).finally(() => { if (prev !== undefined) process.env.LUNA_PHRASE_MS = prev; });
    expect(opts.timeoutMs).toBe(4000);
    expect(r.text).toContain("$40k"); // the local fallback
    expect(JSON.parse(ledger(db)[0].payload_json)).toHaveLength(2); // understand + the timed-out phrase
  });
  test("phrase unavailable (null) → the local fallback text", async () => {
    const db = freshDb();
    setConverse(fakeConverse(() => null).converse as any);
    expect((await say(db, SENT1)).text).toContain("$40k");
  });
  test("Luna called but nothing runnable (e.g. 'by end of 2026' dropped) → local answer, but the row records the egress", async () => {
    const db = freshDb();
    setConverse({
      understand: async (_db: Database, text: string) => ({ actions: [], qsyms: {}, symbolized: "So I wanna save Q_AMT_1 by end of 2026",
        ledger: { payload_json: JSON.stringify({ messages: [{ role: "user", content: "So I wanna save Q_AMT_1 by end of 2026" }] }), canary_checked: 9, canary_hits: 0 } }),
    } as any);
    const r = await sayLocal(db, "So I wanna save 40k $ by end of 2026");
    expect(r).toMatchObject({ text: "local answer", tier: "cloud" });
    const [row] = ledger(db);
    expect(row).toMatchObject({ tier: "cloud", canary_checked: 9, canary_hits: 0 });
    expect(JSON.parse(row.payload_json)).toHaveLength(1);
  });
  test("an action that can't run (bad deadline) also records the egress", async () => {
    const db = freshDb();
    setConverse({
      understand: async () => ({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "someday" }], qsyms: { Q_AMT_1: "4000000" }, symbolized: "s",
        ledger: { payload_json: "{}", canary_checked: 3, canary_hits: 0 } }),
    } as any);
    await sayLocal(db, "save 40k someday maybe");
    expect(ledger(db)[0]).toMatchObject({ tier: "cloud", canary_checked: 3, canary_hits: 0 });
  });
  test("understand null → today's local path (keywords route the goal)", async () => {
    const db = freshDb();
    setConverse({ understand: async () => null } as any);
    const r = await say(db, "goal 40000 by december");
    expect(r.text).toStartWith("Goal set: $40,000");
  });
  test("exact commands, 1/2/3, memory commands and greetings never call Luna", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    for (const t of ["ledger", "privacy", "hello", "thanks", "1", "remember my rent is 1700", "memories", "goal 40000 by december"]) await say(db, t);
    expect(f.calls).toEqual([]);
  });
  test("VOICE=plain turns Luna off entirely", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    process.env.VOICE = "plain";
    try { await say(db, "What changed in my spending since August?"); await say(db, SENT2); } finally { process.env.VOICE = "cloud"; }
    expect(f.calls).toEqual([]);
    // The balance statement is read by the local reader (code, not a model), so it still counts.
    expect(db.query("SELECT COUNT(*) AS n FROM manual_assets").get()).toEqual({ n: 1 });
  });
  test("VOICE=device (on-device wording) never calls Luna either: the cloud is an explicit opt-in", async () => {
    const db = freshDb();
    const f = fakeConverse();
    setConverse(f.converse as any);
    process.env.VOICE = "device";
    try { await say(db, SENT2); } finally { process.env.VOICE = "cloud"; }
    expect(f.calls).toEqual([]);
  });
  test("history holds at most the last 4 turns", async () => {
    const db = freshDb();
    setConverse(fakeConverse().converse as any);
    for (let i = 0; i < 3; i++) await say(db, SENT1, NOW + i);
    expect(lunaHistory()).toHaveLength(4);
  });
});

test("a local fallback that also used the planner merges both egresses into the one row", async () => {
  const db = freshDb();
  setConverse({ understand: async () => ({ actions: [], qsyms: {}, symbolized: "q", ledger: { payload_json: JSON.stringify({ a: 1 }), canary_checked: 4, canary_hits: 0 } }) } as any);
  await route(db, "tell me something", { now: NOW }, { fm: noFm, loadHandler: async () => async () => ({ text: "planned", tier: "cloud" as const,
    ledger: { payload_json: JSON.stringify({ b: 2 }), canary_checked: 6, canary_hits: 0 } }) });
  const [row] = ledger(db);
  expect(row).toMatchObject({ tier: "cloud", canary_checked: 10, canary_hits: 0 });
  expect(JSON.parse(row.payload_json)).toEqual([{ a: 1 }, { b: 2 }]);
});

describe("integration: eng3's real converse.ts with LLM_PROVIDER=fake (no network)", () => {
  test("the two live sentences, end to end through the router", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    setConverse(undefined); // the real module
    try {
      const db = freshDb();
      const r1 = await say(db, SENT1);
      const g1 = goalStatus(db, NOW)!;
      expect(g1.goal.target_cents).toBe(4_000_000);
      expect(new Date(g1.goal.deadline * 1000).toLocaleDateString("en-US", { month: "long", timeZone: "America/Los_Angeles" })).toBe("December");
      expect(r1.tier).toBe("cloud");
      const r2 = await say(db, SENT2, NOW + 30);
      expect(r2.text.split("\n")[0]).toBe("Noted: about $10k in Robinhood, counted toward your goal.");
      expect(db.query("SELECT name, amount_cents FROM manual_assets").all()).toEqual([{ name: "Robinhood", amount_cents: 1_000_000 }]);
      const rows = ledger(db);
      expect(rows[0]).toMatchObject({ tier: "cloud", canary_hits: 0 }); // the goal went through Luna
      expect(rows[1]).toMatchObject({ tier: "local" }); // the balance was read locally, no egress
      expect(JSON.stringify(lunaHistory())).not.toMatch(/40000|40,000|10k|\$/);
      // "end of 2026" now comes back as a month, so the phrasing that missed live works too.
      const db2 = freshDb();
      await say(db2, "So I wanna save 40k $ by end of 2026, so that basically I can quit my job.");
      const g2 = goalStatus(db2, NOW);
      if (g2) expect(g2.goal.target_cents).toBe(4_000_000);
    } finally {
      if (prev === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prev;
    }
  });
});

test("a mixed goal + balance message goes to Luna, which runs both actions (the local reader skips goal statements)", async () => {
  const db = freshDb();
  const MIXED = "Alright, my saving goal is 40k in total cash by end of December. You can see my savings, my rent is 1.8k and I have like 10k in savings in Robinhood";
  setConverse({
    async understand(_db: Database, text: string) {
      const { text: symbolized, qsyms } = symbolizeText(_db, text);
      const sym = (c: string) => Object.keys(qsyms).find((k) => qsyms[k] === c)!;
      return { actions: [{ type: "set_goal", amount: sym("4000000"), by: "December" }, { type: "add_asset", name: "Robinhood", amount: sym("1000000") }],
        qsyms, symbolized, ledger: { payload_json: "{}", canary_checked: 5, canary_hits: 0 } };
    },
    async phrase() { return { template: null, ledger: { canary_checked: 1, canary_hits: 0 } }; },
  } as any);
  const r = await say(db, MIXED);
  const g = goalStatus(db, NOW)!;
  expect(g.goal.target_cents).toBe(4_000_000);
  expect(r.text.split("\n")[0]).toBe("Noted: about $10k in Robinhood, counted toward your goal.");
  expect(g.savings - g.goal.savings_at_creation_cents).toBe(0); // the $10k counts toward savings but isn't progress
  expect(db.query("SELECT name, amount_cents FROM manual_assets").all()).toEqual([{ name: "Robinhood", amount_cents: 1_000_000 }]);
});

test("add_asset with a symbolized name uses name_real; a bare symbol is never stored as the account", async () => {
  const db = freshDb();
  const mk = (actions: unknown[]) => ({ understand: async () => ({ actions, qsyms: { Q_AMT_1: "1000000" }, symbolized: "s", ledger: { canary_checked: 1, canary_hits: 0 } }),
    phrase: async () => ({ template: null, ledger: {} }) });
  setConverse(mk([{ type: "add_asset", name: "PERSON_1", name_real: "Robinhood", amount: "Q_AMT_1" }]) as any);
  await say(db, "my saving goal stuff and PERSON_1 has Q_AMT_1");
  expect(db.query("SELECT name FROM manual_assets").all()).toEqual([{ name: "Robinhood" }]);
  setConverse(mk([{ type: "add_asset", name: "PERSON_2", amount: "Q_AMT_1" }]) as any);
  await say(db, "goal note and PERSON_2 has Q_AMT_1", NOW + 5);
  expect(db.query("SELECT COUNT(*) AS n FROM manual_assets").get()).toEqual({ n: 1 });
});

test("no actions but an overall intent: Luna's intent picks the local handler (question → the planner)", async () => {
  const db = freshDb();
  const seen: string[] = [];
  setConverse({ understand: async () => ({ actions: [], intent: "question", qsyms: {}, symbolized: "q", ledger: { canary_checked: 1, canary_hits: 0 } }) } as any);
  await route(db, "what changed lately", { now: NOW }, { fm: noFm, loadHandler: async (i) => { seen.push(i); return async () => ({ text: "planned", tier: "cloud" as const }); } });
  expect(seen).toEqual(["other"]);
});

test("a question asked with a goal change is answered too, after the status (one reply, one merged row)", async () => {
  const db = freshDb();
  setConverse({
    async understand(_db: Database, text: string) {
      const { text: symbolized, qsyms } = symbolizeText(_db, text);
      const sym = (c: string) => Object.keys(qsyms).find((k) => qsyms[k] === c)!;
      return { actions: [{ type: "set_goal", amount: sym("4000000"), by: "December" }, { type: "ask", intent: "other" }],
        qsyms, symbolized, ledger: { payload_json: JSON.stringify({ u: 1 }), canary_checked: 2, canary_hits: 0 } };
    },
    async phrase() { return { template: null, ledger: {} }; },
  } as any);
  const seen: string[] = [];
  const r = await route(db, "I want to save 40000 by December. What changed since August?", { now: NOW },
    { fm: noFm, loadHandler: async (i) => { seen.push(i); return async () => ({ text: "About 3 months on your savings.", tier: "cloud" as const,
      ledger: { payload_json: JSON.stringify({ sol: 1 }), canary_checked: 3, canary_hits: 0 } }); } });
  expect(seen).toContain("other");
  expect(r.text).toContain("$40k");
  expect(r.text).toContain("\n\nAbout 3 months on your savings."); // then the first-goal tail
  const [row] = ledger(db);
  expect(row).toMatchObject({ tier: "cloud", canary_checked: 5 });
  expect(JSON.parse(row.payload_json)).toEqual([{ u: 1 }, { sol: 1 }]);
});

describe("asset names arrive symbolized: resolved locally to a short display name", () => {
  const mk = (actions: unknown[]) => ({ understand: async () => ({ actions, qsyms: { Q_AMT_1: "1000000" }, symbolized: "s", ledger: { canary_checked: 1, canary_hits: 0 } }),
    phrase: async () => ({ template: null, ledger: {} }) });
  test("MERCHANT_n from the statements → 'Robinhood' (the live case), never the symbol", async () => {
    const db = freshDb();
    db.run("INSERT INTO symbols(symbol, real, kind) VALUES ('MERCHANT_71', 'ROBINHOOD SECURITIES CCB PAYMENT 1234567', 'merchant')");
    setConverse(mk([{ type: "add_asset", name: "MERCHANT_71", amount: "Q_AMT_1" }]) as any);
    const r = await say(db, "goal stuff and 10k in MERCHANT_71");
    expect(db.query("SELECT name FROM manual_assets").all()).toEqual([{ name: "Robinhood" }]);
    expect(listMemories(db)[0].text).toBe("Robinhood: about $10k");
    expect(r.text).not.toMatch(/MERCHANT_\d+/);
  });
  test("an unknown broker merchant gets cleaned and title-cased", async () => {
    const db = freshDb();
    db.run("INSERT INTO symbols(symbol, real, kind) VALUES ('MERCHANT_9', 'Withdrawal from ACME BROKERAGE 998877', 'merchant')");
    setConverse(mk([{ type: "add_asset", name: "MERCHANT_9", amount: "Q_AMT_1" }]) as any);
    await say(db, "x");
    expect(db.query("SELECT name FROM manual_assets").all()).toEqual([{ name: "Acme Brokerage" }]);
  });
  test("a symbol that can't be resolved is skipped, never stored", async () => {
    const db = freshDb();
    setConverse(mk([{ type: "add_asset", name: "MERCHANT_404", amount: "Q_AMT_1" }]) as any);
    await say(db, "x");
    expect(db.query("SELECT COUNT(*) AS n FROM manual_assets").get()).toEqual({ n: 0 });
  });
  test("then the local reader's 'Robinhood' dedupes against it (no double count)", async () => {
    const db = freshDb();
    db.run("INSERT INTO symbols(symbol, real, kind) VALUES ('MERCHANT_71', 'ROBINHOOD SECURITIES CCB PAYMENT', 'merchant')");
    setConverse(mk([{ type: "add_asset", name: "MERCHANT_71", amount: "Q_AMT_1" }]) as any);
    await say(db, "x");
    setConverse(undefined);
    await say(db, "I have like 12k in robinhood now", NOW + 5);
    expect(db.query("SELECT name, amount_cents FROM manual_assets").all()).toEqual([{ name: "Robinhood", amount_cents: 1_200_000 }]);
  });
});

test("'change the goal to 30k' with no deadline keeps the current goal's deadline", async () => {
  const db = freshDb();
  setConverse(fakeConverse().converse as any);
  await say(db, SENT1); // $40k by December
  const dec = goalStatus(db, NOW)!.goal.deadline;
  setConverse({ understand: async () => ({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "" }], qsyms: { Q_AMT_1: "3000000" }, symbolized: "s",
    ledger: { canary_checked: 1, canary_hits: 0 } }), phrase: async () => ({ template: null, ledger: {} }) } as any);
  await say(db, "Let's change the goal to 30k", NOW + 60);
  const g = goalStatus(db, NOW + 60)!.goal;
  expect(g.target_cents).toBe(3_000_000);
  expect(g.deadline).toBe(dec);
});

test("a purchase asked as an open question ('…look at its reviews, is it worth it?') with research unavailable: the local afford answer + an honest limit", async () => {
  const db = freshDb();
  db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (1000000, ?, ?, 0, 1)", [NOW + 200 * 86_400, NOW - 30 * 86_400]);
  setConverse({ understand: async () => ({ actions: [{ type: "ask", intent: "other" }], qsyms: {}, symbolized: "s", ledger: { canary_checked: 1, canary_hits: 0 } }),
    phrase: async () => ({ template: null, ledger: {} }) } as any);
  setResearch(() => null);
  const seen: string[] = [];
  const r = await route(db, "I wanted to buy this jacket - 400$ Arteryx - could you look at its reviews and tell me if it's worth it.", { now: NOW },
    { fm: noFm, loadHandler: async (i) => { seen.push(i); return async () => ({ text: "planner", tier: "cloud" as const }); } }).finally(() => setResearch(undefined));
  expect(seen).not.toContain("other"); // the planner isn't asked a question it can't answer
  expect(r.text).toContain("$400");
  expect(r.text).toEndWith("\nI couldn't look up reviews right now.");
});
