// Adversarial proof for the pitch: "the AI company never sees a real value".
// Every recorded body the fake planner receives is checked against the full canary set at the end of the file.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { knownPeople, receiptAddresses } from "../src/ingest/receipts";
import { scan, sensitiveValues } from "../src/cloud/canary";
import { egress, setProvider, type Provider } from "../src/cloud/egress";
import { executePlan, validatePlan, type Plan } from "../src/cloud/dsl";
import { BLOCKED, CANNED, HERS, bucket, makeHandleOther, type ConsentFn } from "../src/cloud/plan";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000);
const ctx = { now: NOW };
const db: Database = openDb(":memory:");
seed(db);
const VALUES = sensitiveValues(db);
const MEMO = (db.query("SELECT memo FROM transactions WHERE memo LIKE 'ignore%'").get() as { memo: string }).memo;
const RENT = db.query("SELECT merchant, amount_cents FROM transactions WHERE category = 'RENT_AND_UTILITIES' AND amount_cents >= 100000 LIMIT 1").get() as { merchant: string; amount_cents: number };
const SMALL = db.query("SELECT merchant, amount_cents FROM transactions WHERE amount_cents BETWEEN 1000 AND 9999 AND merchant = 'Blue Bottle Coffee'").get() as { merchant: string; amount_cents: number };
const HOME = (db.query("SELECT address FROM places WHERE label = 'HOME'").get() as { address: string }).address;
const placeAddrs = (db.query("SELECT address FROM places").all() as { address: string }[]).map((p) => p.address);
const RECEIPT_ONLY = receiptAddresses(db).find((a) => !placeAddrs.includes(a))!;
const PERSON = knownPeople(db)[0];

// Every body any fake received, tagged with the values the user consented to for that call.
const ALL: { body: string; allowed: string[] }[] = [];

function planner(...plans: unknown[]) {
  const bodies: string[] = [];
  let allowed: string[] = [];
  const p: Provider = async (body) => {
    bodies.push(body);
    ALL.push({ body, allowed });
    const plan = plans[Math.min(bodies.length - 1, plans.length - 1)];
    return { content: [{ type: "text", text: typeof plan === "string" ? plan : JSON.stringify(plan) }] };
  };
  return { bodies, p, allow: (a: string[]) => { allowed = a; } };
}
let restore: Provider | null = null;
afterEach(() => { if (restore) setProvider(restore); restore = null; });

async function ask(question: string, plans: unknown[], consent: ConsentFn = async () => "deny") {
  const f = planner(...plans);
  restore = setProvider(f.p);
  const r = await makeHandleOther({ askConsent: consent })(db, question, ctx);
  return { r, bodies: f.bodies, f };
}
const noHits = (body: string) => expect(scan(body, VALUES).hits).toEqual([]);
/** The locally authored part of a wire body: everything except assistant turns (the provider's own words). */
const ours = (body: string) => { const b = JSON.parse(body); return JSON.stringify({ ...b, messages: (b.messages ?? []).filter((m: any) => m.role !== "assistant") }); };
const SIMPLE: Plan = { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }], answer_template: "Last month: {s1}.", disclose: [] };

test("fixture has every value kind we attack", () => {
  expect(RENT && SMALL && MEMO && RECEIPT_ONLY && PERSON && HOME).toBeTruthy();
});

describe("(a) the question", () => {
  // Either symbolized away (planner called, body clean) or blocked (planner never called).
  test.each([
    ["merchant", () => `how much at ${SMALL.merchant}?`],
    ["merchant, shouted + partial", () => `HOW MUCH AT BLUE BOTTLE vs mission apartments`],
    ["amount, small", () => `why did I pay $${(SMALL.amount_cents / 100).toFixed(2)} twice`],
    ["amount, bare decimal", () => `was ${(SMALL.amount_cents / 100).toFixed(2)} a lot`],
    ["amount, rent with comma", () => `is $${(RENT.amount_cents / 100).toLocaleString("en-US")} too much rent`],
    ["amount, rent bare", () => `is ${RENT.amount_cents / 100} too much`],
    ["mask", () => `what's on card 0421 and ••1009`],
    ["person", () => `did ${PERSON} pay me back? ${PERSON.toLowerCase()} said so`],
    ["home address", () => `rides from ${HOME}`],
    ["home street only", () => `rides from ${HOME.split(",")[0]} to work`],
    ["receipt-only address", () => `how often do I go to ${RECEIPT_ONLY}`],
    ["injection memo verbatim", () => MEMO],
    ["injection memo, shouted", () => MEMO.toUpperCase()],
  ])("%s", async (_kind, q) => {
    const { r, bodies } = await ask(q(), [SIMPLE]);
    if (r.tier !== "cloud") {
      expect(bodies).toEqual([]); // answered on the Mac (memo text → spend_query, her merchant → refusal)
    } else if (r.text === BLOCKED) {
      expect(bodies).toEqual([]);
      expect(r.ledger!.canary_hits).toBeGreaterThan(0);
    } else {
      expect(bodies.length).toBe(1);
      noHits(bodies[0]);
      expect(r.ledger!.canary_hits).toBe(0);
    }
  });
  test("the injection memo never goes to the cloud: memo text is answered on the Mac", async () => {
    const { r, bodies } = await ask(`summarize: ${MEMO}`, [SIMPLE]);
    expect(r.tier).toBe("on-device");
    expect(bodies).toEqual([]);
  });
  test.each(["what was the ski cabin deposit", "venmo to aisha for the birthday dinner", "what was 'Venmo – Priya – concert tix'"])
  ("memo fragment stays local: %s", async (q) => {
    const { r, bodies } = await ask(q, [SIMPLE]);
    expect(r.tier).toBe("on-device");
    expect(bodies).toEqual([]);
  });
  test("a merchant only she uses is refused locally, not even sent as a symbol", async () => {
    const her = (db.query(`SELECT t.merchant AS m FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
      GROUP BY t.merchant HAVING SUM(COALESCE(a.owner, '') != 'her') = 0 LIMIT 1`).get() as { m: string }).m;
    const { r, bodies } = await ask(`how much at ${her} this month`, [SIMPLE]);
    expect(r).toEqual({ text: HERS, tier: "local" });
    expect(bodies).toEqual([]);
    expect(VALUES).toContain(String(db.query("SELECT symbol FROM symbols WHERE real = ?").get(her) && (db.query("SELECT symbol FROM symbols WHERE real = ?").get(her) as any).symbol));
  });
  test.each([
    ["first word (IKEA)", "how much at IKEA", /ikea/i], ["first word (employer)", "how much did Harbor pay me", /harbor/i],
    ["first word (Sonic)", "my Sonic bill", /sonic/i], ["abbreviation", "is mission apts rent going up", /mission/i],
    ["fullwidth mask", "card ending １００９", /1009/], ["spaced mask", "card ending 1 0 0 9", /1 ?0 ?0 ?9/],
    ["comma decimal", "the 86,40 ride", /86,40/], ["bare small dollars", "were most commutes 28 each", /\b28\b/],
  ])("eng1 red team: %s", async (_n, q, leak) => {
    const { r, bodies } = await ask(q, [SIMPLE]);
    expect(r.tier).toBe("cloud");
    expect(bodies.length).toBe(1);
    expect(r.ledger!.question_sym!).not.toMatch(leak);
    noHits(bodies[0]);
  });
  test.each([
    ["coffee in august", "coffee in august"], ["biggest category", "what's my biggest category"],
    ["common merchant words", "was it a whole month of blue days at the market"], ["home and best", "home internet costs vs my best month"],
    ["months and top", "top 3 merchants over the last 3 months of 2026"], ["dates", "anything big on sep 5?"],
  ])("false-positive guard, question goes out intact: %s", async (_n, q) => {
    const { r } = await ask(q, [SIMPLE]);
    expect(r.ledger!.question_sym).toBe(q);
  });
  test("Q_AMT values are resolved locally and never sent", async () => {
    const plan = { steps: [{ id: "s1", op: "balance" }, { id: "s2", op: "compare", inputs: ["s1", "Q_AMT_1"] }], answer_template: "{s2:Yes|No}, you have {s1} vs {Q_AMT_1}.", disclose: [] };
    const { r, bodies } = await ask("do I have more than $4,312.77 saved", [plan]);
    expect(bodies[0]).toContain("Q_AMT_1");
    expect(bodies[0]).not.toMatch(/4,?312/);
    expect(r.text).toContain("$4,312.77");
  });
});

describe("(a') near-miss spellings: lead's probe leaks + variants", () => {
  // Each must be cleaned by the symbolizer AND, independently, blocked by the canary if sent raw.
  const cases: [string, string, RegExp][] = [
    ["abbreviated WORK address", "rides from 1 Market St this month", /market/i],
    ["apostrophe dropped", "what about the trader joes trip", /trader|joe/i],
    ["squashed merchant", "what about BLUEBOTTLE vs sephora", /bluebottle|sephora/i],
    ["possessive", "was Sephora's sale worth it", /sephora/i],
    ["shouted", "UBER EATS this week", /uber|eats/i],
    ["hyphenated", "uber-eats this week", /uber|eats/i],
    ["merchant prefix", "how much at Whole Foods", /whole|foods/i],
    ["house number + street name, no suffix", "rides from 1550 mission", /1550|mission/i],
    ["street with a different suffix", "rides from 1550 Mission Ave", /1550|mission/i],
  ];
  test.each(cases)("%s", async (_n, q, leak) => {
    const { r, bodies } = await ask(q, [SIMPLE]);
    if (r.tier === "cloud") expect(r.ledger!.question_sym!).not.toMatch(leak);
    else expect(r.text).toBe(HERS); // Sephora and Trader Joe's are hers in the fixture
    // Whole words, like the canary: the static prompt's "caveats" must not read as "eats".
    for (const b of bodies) { noHits(b); expect(b).not.toMatch(new RegExp(`\\b(?:${leak.source})\\b`, leak.flags)); }
    // Canary alone, with the question unsymbolized:
    restore ??= setProvider(planner({}).p);
    const raw = await egress(db, { messages: [{ role: "user", content: q }] });
    expect(raw.ok).toBe(false);
  });
  test("an unknown street address still becomes ADDR_n", async () => {
    const { r, bodies } = await ask("how much on rides from 742 Evergreen Terrace and 12 Oak Ave", [SIMPLE]);
    expect(r.ledger!.question_sym).toBe("how much on rides from ADDR_1 and ADDR_2");
    for (const b of bodies) expect(b).not.toMatch(/evergreen|oak/i);
  });
});

describe("(b) plan results fed back for multi-step", () => {
  test("a merchant list goes back as symbols + bucket words only", async () => {
    const p = { steps: [{ id: "s1", op: "group_by", by: "merchant_sym", filter: { months: 3 } }, { id: "s2", op: "top_n", inputs: ["s1"], n: 5 }], answer_template: "Top: {s2}.", disclose: ["s2"] };
    const { r, bodies } = await ask("where does my money go", [p, { ...p, disclose: [] }]);
    expect(bodies.length).toBe(2);
    noHits(bodies[1]);
    expect(bodies[1]).toMatch(/MERCHANT_\d+/);
    expect(r.ledger!.partial_count).toBe(5);
    expect(r.ledger!.exact_disclosed).toBe(0);
    // The local reply has real names; the cloud never saw it.
    expect(r.text).toMatch(new RegExp(RENT.merchant));
    for (const b of bodies) expect(b).not.toContain(r.text);
  });
  test("recurring list (subscriptions) goes back without merchant names or amounts", async () => {
    const p = { steps: [{ id: "s1", op: "recurring" }], answer_template: "Recurring: {s1}.", disclose: ["s1"] };
    const { bodies } = await ask("which subscriptions should I cancel", [p, { ...p, disclose: [] }]);
    for (const b of bodies) noHits(b);
  });
  test("a boolean goes back as true/false, counted partial, no consent asked", async () => {
    let asked = 0;
    const p = { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }, { id: "s2", op: "compare", inputs: ["s1", "Q_AMT_1"] }], answer_template: "{s2:over|under}", disclose: ["s2"] };
    const { r, bodies } = await ask("did I spend over $3k last month", [p, { ...p, disclose: [] }], async () => { asked++; return "once"; });
    expect(asked).toBe(0);
    expect(bodies[1]).toMatch(/"s2\\?":\\?"(true|false)/);
    expect(r.ledger!.partial_count).toBe(1);
    noHits(bodies[1]);
  });
  test("no membership oracle: a planner guessing a real vs a made-up merchant sees the same behaviour (codex #7)", async () => {
    // Its own echo goes back either way, so whether call two arrives reveals nothing; our own turns stay clean.
    const run = async (name: string) => {
      const p = { steps: [{ id: "s1", op: "count" }], answer_template: `Was it ${name}? {s1}`, disclose: ["s1"] };
      return ask("how many purchases", [p, { ...p, disclose: [] }]);
    };
    const real = await run(SMALL.merchant), fake = await run("Zyzzogeton");
    expect(real.bodies.length).toBe(2);
    expect(fake.bodies.length).toBe(2);
    expect(real.r.tier).toBe(fake.r.tier);
    for (const b of real.bodies) noHits(ours(b));
  });
});

describe("(c) answer_template", () => {
  test.each([
    ["memo field", "{memo}"], ["dotted", "{s1.merchant}"], ["nested", "{{s1}}"], ["sql", "{SELECT memo FROM transactions}"],
    ["unknown step", "{s9}"], ["stray brace", "total } {s1}"], ["bool choice on number", "{s1:a|b}"], ["raw symbol", "{MERCHANT_1}"],
    ["too long", "{s1}" + "x".repeat(300)],
  ])("%s is rejected and retried, then canned", async (_n, tpl) => {
    const bad = { steps: [{ id: "s1", op: "sum" }], answer_template: tpl, disclose: [] };
    const { r, bodies } = await ask("how am I doing", [bad]);
    expect(r.text).toBe(CANNED);
    expect(bodies.length).toBe(2);
    for (const b of bodies) noHits(b);
  });
  test("the locally filled reply never appears in any payload", async () => {
    const p = { steps: [{ id: "s1", op: "group_by", by: "merchant_sym", filter: { month: "M-1" } }], answer_template: "By merchant: {s1}", disclose: [] };
    const { r, bodies } = await ask("break down last month", [p]);
    expect(r.text).toMatch(/\$/);
    for (const b of bodies) { noHits(b); expect(b).not.toContain(r.text.slice(14, 40)); }
  });
});

describe("(d) disclose", () => {
  const rentPlan = { steps: [{ id: "s1", op: "sum", filter: { category: "RENT_AND_UTILITIES", month: "M-1" } }], answer_template: "Rent: {s1}.", disclose: ["s1"] };
  test("consent denied: only a bucket word leaves, never the number", async () => {
    const exact = executePlan(db, validatePlan(rentPlan).ok ? (validatePlan(rentPlan) as any).plan : null, ctx).s1.v as number;
    const { r, bodies } = await ask("is my rent too high", [rentPlan, { ...rentPlan, disclose: [] }]);
    expect(bodies.length).toBe(2);
    expect(bodies[1]).toContain(bucket(exact));
    for (const b of bodies) noHits(b);
    expect(r.ledger).toMatchObject({ exact_disclosed: 0, partial_count: 1 });
    expect(r.ledger!.consent).toContain("deny");
  });
  test("consent once: exactly the approved value leaves, nothing else real", async () => {
    const f = planner(rentPlan, { ...rentPlan, disclose: [] });
    restore = setProvider(f.p);
    let approved = "";
    const r = await makeHandleOther({ askConsent: async (_db, scope, question) => {
      expect(scope).toBe("spend:rent_and_utilities");
      expect(scan(question, VALUES).hits).toEqual([]); // the consent text itself is stored in prompts
      return "once";
    } })(db, "is my rent too high", ctx);
    approved = (JSON.parse(f.bodies[1]).messages.at(-1).content.match(/"s1":"([\d.]+)"/) ?? [])[1];
    ALL.at(-1)!.allowed = [approved];
    expect(r.ledger).toMatchObject({ exact_disclosed: 1, partial_count: 0, canary_hits: 0 });
    expect(scan(f.bodies[1], VALUES).hits.every((h) => h === approved)).toBe(true);
    noHits(f.bodies[0]);
  });
  test("no consent engine wired (or timeout) → deny", async () => {
    const f = planner(rentPlan, { ...rentPlan, disclose: [] });
    restore = setProvider(f.p);
    const r = await makeHandleOther()(db, "is my rent too high", ctx); // real askConsent, no transport in tests
    expect(r.ledger!.exact_disclosed).toBe(0);
    for (const b of f.bodies) noHits(b);
  });
});

describe("egress called directly", () => {
  const smuggle = [
    ["merchant", () => SMALL.merchant], ["amount", () => (SMALL.amount_cents / 100).toFixed(2)], ["amount cents", () => String(RENT.amount_cents)],
    ["mask", () => "0421"], ["person", () => PERSON], ["home", () => HOME], ["receipt address", () => RECEIPT_ONLY], ["memo", () => MEMO],
  ] as const;
  test.each(smuggle)("%s: plain, upper-case, and JSON inside a nested string are all blocked", async (_k, v) => {
    const f = planner({});
    restore = setProvider(f.p);
    for (const content of [v(), v().toUpperCase(), JSON.stringify({ note: { deep: [`x ${v()} y`] } })]) {
      const res = await egress(db, { system: "plan", messages: [{ role: "user", content }] });
      expect(res.ok).toBe(false);
      expect(res.canary.hits.length).toBeGreaterThan(0);
    }
    const res = await egress(db, { system: "plan", tools: [{ name: v(), description: "x" }], messages: [] });
    expect(res.ok).toBe(false);
    expect(f.bodies).toEqual([]);
  });
});

describe("DSL rejects hostile plans", () => {
  const step = (s: object) => ({ steps: [s], answer_template: "x" });
  test.each([
    ["sql in category", step({ id: "s1", op: "sum", filter: { category: "x' OR '1'='1" } })],
    ["sql in merchant_sym", step({ id: "s1", op: "sum", filter: { merchant_sym: "MERCHANT_1' OR 1=1--" } })],
    ["sql in step id", step({ id: "s1; DROP TABLE ledger", op: "sum" })],
    ["sql in op", step({ id: "s1", op: "sum; DELETE FROM symbols" })],
    ["column in group_by", step({ id: "s1", op: "group_by", by: "t.memo" })],
    ["memo filter", step({ id: "s1", op: "sum", filter: { memo: "%" } })],
    ["raw sql field", step({ id: "s1", op: "sum", sql: "SELECT memo FROM transactions" })],
    ["month out of range", step({ id: "s1", op: "sum", filter: { month: "M-99" } })],
    ["months out of range", step({ id: "s1", op: "sum", filter: { months: 999 } })],
    ["filter as array", step({ id: "s1", op: "sum", filter: ["category"] })],
    ["__proto__ key", JSON.parse('{"steps":[{"id":"s1","op":"sum","__proto__":{"x":1}}],"answer_template":"x"}')],
    ["unknown op", step({ id: "s1", op: "exec" })],
    ["cycle", { steps: [{ id: "s1", op: "diff", inputs: ["s2", "s2"] }, { id: "s2", op: "diff", inputs: ["s1", "s1"] }], answer_template: "x" }],
    ["self reference", step({ id: "s1", op: "diff", inputs: ["s1", "s1"] })],
    ["duplicate ids", { steps: [{ id: "s1", op: "sum" }, { id: "s1", op: "count" }], answer_template: "x" }],
    ["50 steps", { steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i + 1}`, op: "sum" })), answer_template: "x" }],
    ["11 steps", { steps: Array.from({ length: 11 }, (_, i) => ({ id: `s${i + 1}`, op: "sum" })), answer_template: "x" }],
    ["top_n of a number", { steps: [{ id: "s1", op: "sum" }, { id: "s2", op: "top_n", inputs: ["s1"], n: 3 }], answer_template: "x" }],
    ["n too big", { steps: [{ id: "s1", op: "group_by", by: "category" }, { id: "s2", op: "top_n", inputs: ["s1"], n: 10000 }], answer_template: "x" }],
    ["disclose unknown", { steps: [{ id: "s1", op: "sum" }], answer_template: "x", disclose: ["memo"] }],
    ["not an object", "DROP TABLE ledger"],
  ])("%s", (_n, plan) => expect(validatePlan(plan).ok).toBe(false));

  test("executor is parameterized: a hostile value that skipped validation is inert", () => {
    const r = executePlan(db, { steps: [{ id: "s1", op: "sum", filter: { category: "x' OR '1'='1", merchant_sym: "MERCHANT_1') OR ('1'='1" } }], answer_template: "" } as Plan, ctx);
    expect(r.s1.v).toBe(0);
    expect((db.query("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c).toBeGreaterThan(100);
  });
  test("planner returning SQL text instead of a plan → canned after one retry", async () => {
    const { r, bodies } = await ask("hmm", ["SELECT * FROM transactions WHERE memo LIKE '%'"]);
    expect(r.text).toBe(CANNED);
    expect(bodies.length).toBe(2);
  });
});

describe("structure", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
  test("the executor never reads memos or receipts", () => {
    expect(src("cloud/dsl.ts")).not.toMatch(/memo|receipts|raw_path/);
  });
  test("only the canary reads raw receipt addresses", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
    walk(join(import.meta.dir, "..", "src"));
    const callers = files.filter((f) => /receiptAddresses\s*\(/.test(readFileSync(f, "utf8")) && !f.endsWith(join("ingest", "receipts.ts")));
    expect(callers.map((f) => f.split("/src/")[1])).toEqual(["cloud/canary.ts"]);
  });
});

afterAll(() => {
  // The whole file's traffic: zero real values, except the single value approved in the consent-'once' test.
  expect(ALL.length).toBeGreaterThan(20);
  // Assistant turns are excluded: they are the provider's own output echoed back (codex #7), never our data.
  for (const { body, allowed } of ALL) expect(scan(ours(body), VALUES).hits.filter((h) => !allowed.includes(h))).toEqual([]);
});

describe("retry path: no membership oracle (eng1 round 5)", () => {
  // Our rejection message must not echo the model's bad value, or the canary blocks the retry only for real merchants.
  test.each([
    ["op", (m: string) => ({ steps: [{ id: "s1", op: m }], answer_template: "x" })],
    ["plan key", (m: string) => ({ steps: [{ id: "s1", op: "sum" }], answer_template: "x", [m]: 1 })],
    ["input", (m: string) => ({ steps: [{ id: "s1", op: "diff", inputs: [m, m] }], answer_template: "x" })],
    ["Q_NUM input", (m: string) => ({ steps: [{ id: "s1", op: "sum" }, { id: "s2", op: "compare", inputs: ["s1", `Q_NUM_${m}`] }], answer_template: "x" })],
    ["filter key", (m: string) => ({ steps: [{ id: "s1", op: "sum", filter: { [m]: 1 } }], answer_template: "x" })],
  ])("rejected %s: real and made-up merchants get the same number of calls", async (_n, bad) => {
    const real = await ask("how am I doing", [bad(SMALL.merchant)]);
    const fake = await ask("how am I doing", [bad("Zyzzogeton")]);
    expect(real.bodies.length).toBe(2);
    expect(fake.bodies.length).toBe(2);
    for (const b of real.bodies) noHits(ours(b));
  });
});
