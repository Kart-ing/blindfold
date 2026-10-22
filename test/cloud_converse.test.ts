// Luna (src/cloud/converse.ts): only symbols leave, every word we author is canaried, outputs are whitelisted.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { resetProvider, setProvider, type Provider } from "../src/cloud/egress";
import { scan, sensitiveValues } from "../src/cloud/canary";
import { PHRASE_PROMPT, UNDERSTAND_PROMPT, phrase, templateOk, understand, validateActions, type Turn } from "../src/cloud/converse";
import { desymbolize } from "../src/cloud/plan";
import { buildSymbols } from "../src/cloud/symbolize";
import { symbolizeText } from "../src/cloud/symbolize";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000);
const ctx = { now: NOW };
// The code's defaults are what's asserted: bun test loads .env, which may pick other models or efforts for the live agent.
const ENV = ["OPENAI_MODEL", "OPENAI_CONVERSE_MODEL", "OPENAI_REASONING_EFFORT", "LUNA_UNDERSTAND_REASONING", "LUNA_PHRASE_REASONING", "LUNA_UNDERSTAND_MS"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const clearEnv = () => { for (const k of ENV) delete process.env[k]; };
beforeAll(clearEnv);
afterAll(() => { for (const k of ENV) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
const fixture = () => { const db = openDb(":memory:"); seed(db); return db; };
const S1 = "I want to save 40000 by December so I can quit my job and work on my startup without worrying about rent (about 1700$) and some other stuff till my OPT runs out - which is end of June.";
const S2 = "I also have around 10k in my robinhood";

let restore: Provider | null = null;
afterEach(() => { if (restore) setProvider(restore); restore = null; });
/** Records bodies and send options; answers with json. */
function luna(json: object | string) {
  const calls: { body: string; opts?: { timeoutMs?: number } }[] = [];
  restore = setProvider(async (body, opts) => { calls.push({ body, opts }); return { content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }] }; }, "openai");
  return calls;
}
const userTurn = (body: string) => (JSON.parse(body).messages as { role: string; content: string }[]).filter((m) => m.role !== "system");

describe("understand: the two live sentences", () => {
  test("(a) goal + remember: real cents and a desymbolized note come back; only symbols went out", async () => {
    const db = fixture();
    const calls = luna({ actions: [
      { type: "set_goal", amount: "Q_AMT_1", by: "December" },
      { type: "remember", text: "Rent is about Q_AMT_2 a month; OPT ends end of June; saving so I can work on my startup" },
    ] });
    const r = await understand(db, S1, [], ctx);
    expect(r!.actions).toEqual([
      { type: "set_goal", amount: "Q_AMT_1", amount_cents: 4_000_000, by: "December" },
      { type: "remember", text: "Rent is about Q_AMT_2 a month; OPT ends end of June; saving so I can work on my startup",
        text_real: "Rent is about $1,700 a month; OPT ends end of June; saving so I can work on my startup" },
    ]);
    expect(r!.qsyms).toEqual({ Q_AMT_1: "4000000", Q_AMT_2: "170000" });
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "low", response_format: { type: "json_object" } });
    expect(body.messages[0]).toEqual({ role: "system", content: UNDERSTAND_PROMPT });
    expect(userTurn(calls[0].body)).toEqual([{ role: "user", content: `New message: ${r!.symbolized}` }]);
    expect(r!.symbolized).toContain("save Q_AMT_1 by December");
    expect(calls[0].body).not.toMatch(/40000|40,000|1700|1,700/);
    expect(calls[0].opts).toEqual({ timeoutMs: 9000 });
    expect(r!.ledger).toMatchObject({ question_sym: r!.symbolized, payload_json: calls[0].body, canary_hits: 0 });
    expect(r!.ledger.canary_checked).toBeGreaterThan(100);
  });
  test("(b) an outside balance → add_asset with real cents", async () => {
    luna({ actions: [{ type: "add_asset", name: "Robinhood", amount: "Q_AMT_1" }] });
    const r = await understand(fixture(), S2, [], ctx);
    expect(r!.actions).toEqual([{ type: "add_asset", name: "Robinhood", name_real: "Robinhood", amount: "Q_AMT_1", amount_cents: 1_000_000 }]);
    expect(r!.symbolized).toBe("I also have around Q_AMT_1 in my robinhood");
  });
});

describe("understand: history and refusals", () => {
  test("history is symbolized again, its quantities renamed PRIOR_*, and it rides in OUR (canaried) user turn", async () => {
    const db = fixture();
    const calls = luna({ actions: [{ type: "chat" }] });
    await understand(db, "thanks!", [{ role: "user", text: "what did Blue Bottle cost me" }, { role: "assistant", text: "You spent $460 at Blue Bottle Coffee last month (your share)." }], ctx);
    const turns = userTurn(calls[0].body);
    expect(turns.length).toBe(1);
    expect(turns[0].content).toMatch(/^Earlier turns, oldest first:\nUser: what did MERCHANT_\d+ cost me\nAssistant: You spent PRIOR_AMT_1 at MERCHANT_\d+ last month \(your share\)\.\n\nNew message: thanks!$/);
    expect(calls[0].body).not.toMatch(/460|blue bottle/i);
    expect(scan(turns[0].content, sensitiveValues(db)).hits).toEqual([]);
  });
  test("a message about her merchant returns null without a call (nothing was attempted)", async () => {
    const calls = luna({ actions: [{ type: "chat" }] });
    const db = fixture();
    const her = (db.query(`SELECT t.merchant AS m FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
      GROUP BY t.merchant HAVING SUM(COALESCE(a.owner, '') != 'her') = 0 LIMIT 1`).get() as { m: string }).m;
    expect(await understand(db, `I spent a lot at ${her}`, [], ctx)).toBeNull();
    expect(calls).toEqual([]);
  });
  test("invalid model output or a provider error → no actions (the attempt is still reported)", async () => {
    luna("not json at all");
    expect((await understand(fixture(), S2, [], ctx))!.actions).toEqual([]);
    restore = setProvider(async () => { throw new Error("timeout"); }, "openai");
    expect((await understand(fixture(), S2, [], ctx))!.actions).toEqual([]);
  });
});

describe("validateActions: strict whitelist", () => {
  const db = fixture();
  const qsyms = symbolizeText(db, S1).qsyms; // Q_AMT_1, Q_AMT_2
  test.each([
    ["an amount not in the message", { actions: [{ type: "set_goal", amount: "Q_AMT_9", by: "December" }] }],
    ["a Q_NUM as an amount", { actions: [{ type: "add_asset", name: "Cash", amount: "Q_NUM_1" }] }],
    ["an amount written out", { actions: [{ type: "set_goal", amount: "40000", by: "December" }] }],
    ["a deadline that isn't a month", { actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "soonish" }] }],
    ["five actions", { actions: Array.from({ length: 5 }, () => ({ type: "chat" })) }],
    ["an unknown intent", { intent: "wire_money", actions: [{ type: "chat" }] }],
    ["no actions", { actions: [] }],
    ["an unknown type", { actions: [{ type: "transfer_money", amount: "Q_AMT_1" }] }],
    ["an extra key", { actions: [{ type: "chat", note: "hi" }] }],
    ["an extra top-level key", { actions: [{ type: "chat" }], question: true }],
    ["a note with a digit", { actions: [{ type: "remember", text: "rent is 1700" }] }],
    ["a note with a dollar sign", { actions: [{ type: "remember", text: "rent is $ Q_AMT_2" }] }],
    ["a note with a foreign symbol", { actions: [{ type: "remember", text: "about MERCHANT_999" }] }],
    ["a note quoting history", { actions: [{ type: "remember", text: "spent PRIOR_AMT_1" }] }],
    ["an asset name with digits", { actions: [{ type: "add_asset", name: "acct 0421", amount: "Q_AMT_1" }] }],
    ["an unknown intent", { actions: [{ type: "ask", intent: "wire_money" }] }],
  ])("rejects %s", (_n, raw) => expect(validateActions(raw, qsyms, db)).toBeNull());
  test("accepts ask/chat and a merchant-symbol asset", () => {
    const bb = (db.query("SELECT symbol FROM symbols WHERE real = 'Blue Bottle Coffee'").get() as { symbol: string }).symbol;
    expect(validateActions({ actions: [{ type: "ask", intent: "afford" }, { type: "chat" }, { type: "add_asset", name: bb, amount: "Q_AMT_1" }] }, qsyms, db))
      .toEqual([{ type: "ask", intent: "afford" }, { type: "chat" }, { type: "add_asset", name: bb, name_real: "Blue Bottle Coffee", amount: "Q_AMT_1", amount_cents: 4_000_000 }]);
  });
});

describe("phrase: placeholder names out, a validated template back", () => {
  const NAMES = ["GOAL", "BY"];
  test("names and a number-free situation are all that leave; a valid template comes back", async () => {
    const db = fixture();
    const calls = luna({ text: "On it: {GOAL} by {BY}.\nText goal anytime to see your pace." });
    const r = await phrase(db, "goal_set", "new savings goal set; on pace", NAMES, ctx, { userText: S1 });
    expect(r!.template).toBe("On it: {GOAL} by {BY}.\nText goal anytime to see your pace.");
    const [user, spec] = userTurn(calls[0].body);
    expect(user.content).toMatch(/^New message: I want to save Q_AMT_1 by December/);
    expect(spec.content).toBe("Kind: goal_set\nSituation: new savings goal set; on pace\nPlaceholders: {GOAL}, {BY}");
    expect(calls[0].body).not.toMatch(/40000|1700/);
    const body = JSON.parse(calls[0].body);
    expect(body.messages[0]).toEqual({ role: "system", content: PHRASE_PROMPT });
    expect(body).toMatchObject({ max_completion_tokens: 600, reasoning_effort: "low" });
    expect(calls[0].opts).toEqual({ timeoutMs: 6000 });
  });
  test.each([
    ["a digit", "Saved {GOAL} in 2 months by {BY}."], ["a dollar sign", "$ {GOAL} by {BY}"], ["an unknown placeholder", "{GOAL} by {BY} ({RENT})"],
    ["a missing placeholder", "Saved {GOAL}."], ["markdown", "**{GOAL}** by {BY}"], ["a preamble", "Sure! {GOAL} by {BY}"],
    ["too many lines", Array.from({ length: 9 }, () => "{GOAL} by {BY}").join("\n")], ["a stray brace", "{GOAL} by {BY} }"],
  ])("rejects a template with %s (template null; the attempt's ledger still comes back)", async (_n, text) => {
    const calls = luna({ text });
    const r = await phrase(fixture(), "goal_set", "new goal", NAMES, ctx);
    expect(r!.template).toBeNull();
    expect(r!.ledger.payload_json).toBe(calls[0].body);
  });
  test("a situation with a number, or a bad placeholder name, never leaves", async () => {
    const calls = luna({ text: "{GOAL}" });
    expect(await phrase(fixture(), "goal_set", "goal of 40000", NAMES, ctx)).toBeNull();
    expect(await phrase(fixture(), "goal_set", "new goal", ["GOAL_2"], ctx)).toBeNull();
    expect(calls).toEqual([]);
    expect(templateOk("{A} and {B}", ["A", "B"], ["A"])).toBe(true);
  });
});

describe("LLM_PROVIDER=fake (no network) and the static prompts", () => {
  test("the fake answers the two sentences and phrases a valid template", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    resetProvider();
    try {
      const a = await understand(fixture(), S1, [], ctx), b = await understand(fixture(), S2, [], ctx);
      expect(a!.actions).toEqual([{ type: "set_goal", amount: "Q_AMT_1", amount_cents: 4_000_000, by: "December" }]);
      expect(b!.actions).toEqual([{ type: "add_asset", name: "Robinhood", name_real: "Robinhood", amount: "Q_AMT_1", amount_cents: 1_000_000 }]);
      expect((await phrase(fixture(), "goal_set", "new goal", ["GOAL", "BY"], ctx))!.template).toBe("Got it.\n{GOAL} · {BY}");
    } finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  });
  test("both static prompts match no DB value", () => {
    const v = sensitiveValues(fixture());
    expect(scan(UNDERSTAND_PROMPT, v).hits).toEqual([]);
    expect(scan(PHRASE_PROMPT, v).hits).toEqual([]);
  });
});

describe("live regression: the human's onboarding message (timed out at 6 s; the model's answer was valid)", () => {
  const MSG = "So I wanna save 40k $ by end of 2026, so that basically I can quit my job. My rent is around 1800$ and you know my approx monthly spend, I usually send my friend Priya the rent, cause she pays it.";
  test("symbolized as money; the model's real reply validates; understand now waits 9 s", async () => {
    const calls = luna({ actions: [
      { type: "set_goal", amount: "Q_AMT_1", by: "December" },
      { type: "remember", text: "I want to quit my job once I've saved enough. My rent is around Q_AMT_2, and I usually send my friend Priya the rent because she pays it." },
    ] });
    const r = await understand(fixture(), MSG, [], ctx);
    expect(r!.symbolized).toContain("save Q_AMT_1 $ by end of 2026");
    expect(r!.qsyms).toEqual({ Q_AMT_1: "4000000", Q_AMT_2: "180000" });
    expect(r!.actions[0]).toEqual({ type: "set_goal", amount: "Q_AMT_1", amount_cents: 4_000_000, by: "December" });
    expect((r!.actions[1] as { text_real: string }).text_real).toContain("around $1,800");
    expect(calls[0].opts).toEqual({ timeoutMs: 9000 });
  });
  test.each([["end of 2026", "December 2026"], ["2026-12", "December 2026"], ["by the end of June", "June"], ["dec 2026", "dec 2026"], ["December", "December"]])
  ("deadline %s → %s", async (by, want) => {
    luna({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by }] });
    expect((await understand(fixture(), MSG, [], ctx))!.actions[0]).toMatchObject({ by: want });
  });
});

describe("people the DB doesn't know (live: 'my friend Priya' went out in clear)", () => {
  const MSG = "So I wanna save 40k $ by end of 2026, so that basically I can quit my job. My rent is around 1800$ and you know my approx monthly spend, I usually send my friend Priya the rent, cause she pays it.";
  test("with an empty DB the live sentence carries PERSON_1, never the name; the reply restores it locally", () => {
    const db = openDb(":memory:");
    const s = symbolizeText(db, MSG);
    expect(s.text).toContain("send my friend PERSON_1 the rent");
    expect(s.text).not.toMatch(/alicia/i);
    expect(desymbolize(db, "Your friend PERSON_1 pays the rent.", s.qsyms)).toBe("Your friend Priya pays the rent.");
    expect(symbolizeText(db, "did alicia pay me back").text).toBe("did PERSON_1 pay me back"); // remembered as a person now
  });
  test.each([
    ["my roommate alicia paid half", /^my roommate PERSON_\d+ paid half$/], ["Send Bob the money", /^Send PERSON_\d+ the money$/],
    ["I zelle Maya for groceries", /^I MERCHANT_\d+ PERSON_\d+ for groceries$/], ["my landlord Greg raised the rent", /^my landlord PERSON_\d+ raised the rent$/],
  ])("%s → a PERSON symbol", (q, re) => expect(symbolizeText(fixture(), q as string).text).toMatch(re as RegExp));
  test.each(["want to quit my job", "I need to cancel it", "compare to September", "How much does getting to work cost me?", "send her the money", "paid to Costco twice"])
  ("no false person: %s", (q) => expect(symbolizeText(fixture(), q).text).not.toMatch(/PERSON_\d+/));
});

describe("understand always reports a real attempt (router ledger rows)", () => {
  test("invalid output → no actions, but the ledger has the payload", async () => {
    const calls = luna("not json");
    const r = await understand(fixture(), "I also have around 10k in my robinhood", [], ctx);
    expect(r).toMatchObject({ actions: [], ledger: { payload_json: calls[0].body, canary_hits: 0 } });
  });
  test("a provider error or timeout → no actions, payload recorded", async () => {
    restore = setProvider(async () => { throw new Error("timeout"); }, "openai");
    const r = await understand(fixture(), "I also have around 10k in my robinhood", [], ctx);
    expect(r!.actions).toEqual([]);
    expect(r!.ledger.payload_json).toContain("Q_AMT_1");
  });
  test("a canary block → no actions, nothing sent, canary_hits > 0 (🔴 row)", async () => {
    const calls = luna({ actions: [{ type: "chat" }] });
    const r = await understand(fixture(), "how often do I go to willie mays plaza", [], ctx);
    expect(r).toMatchObject({ actions: [], ledger: { payload_json: "[]" } });
    expect(r!.ledger.canary_hits).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
  test("end of the year / EOY → December of this year", async () => {
    luna({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "end of the year" }] });
    expect((await understand(fixture(), "save 40k by end of the year", [], ctx))!.actions[0]).toMatchObject({ by: "December 2026" });
  });
});

describe("phrase reuses the classified message and honors the caller's timeout", () => {
  test("after understand(), phrase sends the exact same user turn (the gate classifies it once)", async () => {
    const db = fixture();
    const calls = luna({ actions: [{ type: "chat" }] });
    await understand(db, S2, [{ role: "user", text: "hi" }], ctx);
    restore && setProvider(restore); restore = null;
    const calls2 = luna({ text: "Noted: {ASSET}." });
    await phrase(db, "asset_added", "an outside balance was added", ["ASSET"], ctx, { userText: S2, timeoutMs: 3000 });
    expect(userTurn(calls2[0].body)[0].content).toBe(userTurn(calls[0].body)[0].content);
    expect(calls2[0].opts).toEqual({ timeoutMs: 3000 });
  });
  test("a timeout returns {template: null, ledger}", async () => {
    restore = setProvider(async () => { throw new Error("The operation timed out."); }, "openai");
    const r = await phrase(fixture(), "goal_set", "new goal", ["GOAL"], ctx, { timeoutMs: 3000 });
    expect(r).toMatchObject({ template: null });
    expect(r!.ledger.payload_json).toContain("Kind: goal_set");
  });
});

describe("holdings → add_asset, even inside a goal message (live misses)", () => {
  const LIVE1 = "Alright, my saving goal is 40k in total cash by end of December. You can see my savings, my rent is 1.8k and I have like 10k in savings in Robinhood";
  const LIVE2 = "No, I've got 17k almost, cause the robinhood counts, 10k in the invested amount";
  test("LIVE1: the model forgot add_asset; the backstop adds Robinhood $10,000", async () => {
    const db = fixture();
    luna({ intent: "none", actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "December" }, { type: "remember", text: "Rent is about Q_AMT_2 a month" }] });
    const r = await understand(db, LIVE1, [], ctx);
    expect(r!.symbolized).toMatch(/I have like Q_AMT_3 in savings in PERSON_\d+$/);
    expect(r!.actions.map((a) => a.type)).toEqual(["set_goal", "remember", "add_asset"]);
    expect(r!.actions[2]).toMatchObject({ name_real: "Robinhood", amount_cents: 1_000_000 });
    expect(r!.intent).toBe("none");
  });
  test("LIVE1 with all four actions from the model: no duplicate asset", async () => {
    const db = fixture();
    luna({ intent: "none", actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "December" }, { type: "remember", text: "Rent is about Q_AMT_2 a month" },
      { type: "add_asset", name: "Robinhood", amount: "Q_AMT_3" }, { type: "chat" }] });
    const r = await understand(db, LIVE1, [], ctx);
    expect(r!.actions.filter((a) => a.type === "add_asset")).toEqual([{ type: "add_asset", name: "Robinhood", name_real: "Robinhood", amount: "Q_AMT_3", amount_cents: 1_000_000 }]);
  });
  test("LIVE2: the model's add_asset for the robinhood part validates with the symbol it saw", async () => {
    const db = fixture();
    const sym = symbolizeText(db, LIVE1).text.match(/PERSON_\d+/)![0]; // Robinhood became a remembered symbol
    luna({ intent: "none", actions: [{ type: "add_asset", name: sym, amount: "Q_AMT_2" }] });
    const r = await understand(db, LIVE2, [], ctx);
    expect(r!.symbolized).toBe(`No, I've got Q_AMT_1 almost, cause the ${sym} counts, Q_AMT_2 in the invested amount`);
    expect(r!.actions).toEqual([{ type: "add_asset", name: sym, name_real: "Robinhood", amount: "Q_AMT_2", amount_cents: 1_000_000 }]);
  });
});

describe("names the DB has never seen (eng1's probes, empty DB)", () => {
  test.each([
    ["Zorya covered dinner", /^PERSON_1 covered dinner$/],
    ["lunch with Zorya on friday", /^lunch with PERSON_1 on friday$/],
    ["Can I lend Zorya 200 dollars?", /^Can I lend PERSON_1 Q_AMT_1\?$/],
    ["I sent zorya the rent", /^I sent PERSON_1 the rent$/],
    ["my friend Zorya", /^my friend PERSON_1$/], ["my friend zorya", /^my friend PERSON_1$/],
    ["I sent Zorya the rent", /^I sent PERSON_1 the rent$/], ["paid Zorya back", /^paid PERSON_1 back$/],
    ["my roommate Quillfeather", /^my roommate PERSON_1$/], ["I paid Maya Chen back on Friday", /^I paid PERSON_1 back on Friday$/],
    ["I owe zorya for groceries", /^I owe PERSON_1 for groceries$/], ["split it with zorya", /^split it with PERSON_1$/],
  ])("%s → PERSON", (q, re) => expect(symbolizeText(openDb(":memory:"), q as string).text).toMatch(re as RegExp));
  test.each(["I sent money to savings", "paid rent on time", "owe taxes this year", "split the bill", "lend money to friends", "with friends for dinner",
    "Compare my spending this month", "Show my biggest category", "OPT ends in June, I'm on a visa", "I love it. Thanks!", "Remind me what I spent"])
  ("no false person: %s", (q) => expect(symbolizeText(openDb(":memory:"), q).text).not.toMatch(/PERSON_\d+/));
});

describe("set_goal without a deadline keeps the current one (live miss: 'change the goal to 30k')", () => {
  const LIVE3 = "Let's change the goal to 30k + I've got like 6k in my checking account rn, which will move into saving by end of today, and also I'll get my another 5.2k salary on October 30th and then I have another 2 months of salaries coming in.";
  test("the goal change survives with by: null; the checking money is not an outside asset", async () => {
    const db = fixture();
    luna({ intent: "none", actions: [
      { type: "set_goal", amount: "Q_AMT_1" },
      { type: "remember", text: "Another Q_AMT_3 salary arrives on October; two more months of salary after that" },
    ] });
    const r = await understand(db, LIVE3, [], ctx);
    expect(r!.symbolized).toMatch(/^Let's change the goal to Q_AMT_1 \+ I've got like Q_AMT_2 in my checking account rn/);
    expect(r!.qsyms).toMatchObject({ Q_AMT_1: "3000000", Q_AMT_2: "600000", Q_AMT_3: "520000" });
    expect(r!.actions[0]).toEqual({ type: "set_goal", amount: "Q_AMT_1", amount_cents: 3_000_000, by: null });
    expect(r!.actions.some((a) => a.type === "add_asset")).toBe(false); // the backstop skips "in my checking"
  });
  test("by may be absent or null; a present by must still be a month", () => {
    const db = fixture(), q = { Q_AMT_1: "3000000" };
    expect(validateActions({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by: null }] }, q, db)).toEqual([{ type: "set_goal", amount: "Q_AMT_1", amount_cents: 3_000_000, by: null }]);
    expect(validateActions({ actions: [{ type: "set_goal", amount: "Q_AMT_1", by: "whenever" }] }, q, db)).toBeNull();
  });
  test("the fake understands 'change the goal to' too", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    resetProvider();
    try {
      expect((await understand(fixture(), "change the goal to 30k", [], ctx))!.actions).toEqual([{ type: "set_goal", amount: "Q_AMT_1", amount_cents: 3_000_000, by: null }]);
    } finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  });
});


describe("one bad action no longer sinks the rest (live: goal change dropped)", () => {
  const LIVE3 = "Let's change the goal to 30k + I've got like 6k in my checking account rn, which will move into saving by end of today, and also I'll get my another 5.2k salary on October 30th and then I have another 2 months of salaries coming in.";
  test("the live reply is accepted as-is: a note may repeat the user's own date and count words", async () => {
    luna({ intent: "question", actions: [{ type: "set_goal", amount: "Q_AMT_1" },
      { type: "remember", text: "I'll get another Q_AMT_3 salary on October 30th and then have another 2 months of salaries coming in." }, { type: "ask", intent: "other" }] });
    const r = await understand(fixture(), LIVE3, [], ctx);
    expect(r!.actions.map((a) => a.type)).toEqual(["set_goal", "remember", "ask"]);
    expect((r!.actions[1] as { text_real: string }).text_real).toBe("I'll get another $5,200 salary on October 30th and then have another 2 months of salaries coming in.");
  });
  test("a digit the user never typed is still rejected, and only that action is dropped", async () => {
    luna({ actions: [{ type: "set_goal", amount: "Q_AMT_1" }, { type: "remember", text: "rent is 1700 a month" }] });
    const r = await understand(fixture(), LIVE3, [], ctx);
    expect(r!.actions).toEqual([{ type: "set_goal", amount: "Q_AMT_1", amount_cents: 3_000_000, by: null }]);
  });
});

describe("intent runway (eng-2's local runway handler)", () => {
  const Q = "If I lost my job on the first day of January while saving the same amount I do today, how many months could I survive with my current expenditure?";
  test("the model's runway intent comes back; the prompt names it", async () => {
    luna({ intent: "runway", actions: [{ type: "ask", intent: "other" }] });
    expect((await understand(fixture(), Q, [], ctx))!.intent).toBe("runway");
    expect(UNDERSTAND_PROMPT).toContain('"runway" (how long my savings would last');
  });
  test("the fake recognizes runway questions", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    resetProvider();
    try { expect((await understand(fixture(), Q, [], ctx))!.intent).toBe("runway"); }
    finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  });
});

test("the converse model is the configured one (OPENAI_MODEL, GPT-6.1 Sol by default); Luna stays a setting", async () => {
  const calls = luna({ intent: "none", actions: [{ type: "chat" }] });
  try {
    process.env.OPENAI_MODEL = "gpt-other";
    await understand(fixture(), "thanks", [], ctx);
    Object.assign(process.env, { OPENAI_CONVERSE_MODEL: "gpt-6-luna", LUNA_UNDERSTAND_REASONING: "none" });
    await understand(fixture(), "thanks again", [], ctx);
  } finally { clearEnv(); }
  expect(calls.map((c) => JSON.parse(c.body)).map((b) => [b.model, b.reasoning_effort])).toEqual([["gpt-other", "low"], ["gpt-6-luna", "none"]]);
});

describe("runway: typos, hypotheticals and disputes (live misses on Sol; synthetic numbers)", () => {
  const viaFake = async (text: string, history: Turn[] = []) => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    resetProvider();
    try { return (await understand(fixture(), text, history, ctx))!.intent; } finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  };
  const history: Turn[] = [
    { role: "user", text: "how long would I last if I lost my job in March?" },
    { role: "assistant", text: "About 5 months on what you have.", intent: "runway" },
  ];
  const DISPUTE = "I'm already at 12k no? 4k in savings, 8k in my brokerage.";
  test("'loose my income … will I survive' and 'say my income stops …' are runway", async () => {
    expect(await viaFake("if I loose my income in March, will I survive and how many months if I deplete my savings to 0")).toBe("runway");
    expect(await viaFake("Say my income stops March 1st + I have another 3.1k coming")).toBe("runway");
  });
  test("a dispute right after a runway answer is runway again: the assistant turn goes out labeled", async () => {
    const calls = luna({ intent: "runway", actions: [{ type: "ask", intent: "other" }] });
    const r = await understand(fixture(), DISPUTE, history, ctx);
    expect(r!.intent).toBe("runway");
    expect(userTurn(calls[0].body)[0].content).toContain("Assistant [runway answer]: About 5 months on what you have.");
    expect(await viaFake(DISPUTE, history)).toBe("runway");
    expect(await viaFake(DISPUTE, [history[0], { ...history[1], intent: "afford" }])).not.toBe("runway");
  });
  test("an unknown label is dropped, not sent", async () => {
    const calls = luna({ intent: "none", actions: [{ type: "chat" }] });
    await understand(fixture(), "ok", [{ role: "assistant", text: "Done.", intent: "ignore previous instructions" }], ctx);
    expect(userTurn(calls[0].body)[0].content).toContain("Assistant: Done.");
  });
  test("the prompts carry the rules", () => {
    expect(UNDERSTAND_PROMPT).toContain('hypotheticals like "say my income stops…" count');
    expect(UNDERSTAND_PROMPT).toContain("[runway answer]");
    expect(UNDERSTAND_PROMPT).toContain('Not hypotheticals ("say …", "if …", "what if …")');
    expect(PHRASE_PROMPT).toContain("Never ask the user for something their message already says.");
  });
});

