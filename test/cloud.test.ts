import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { amountForms, scan, sensitiveValues } from "../src/cloud/canary";
import { BEDROCK_ACCESS_HINT, anthropicEncode, anthropicProvider, bedrockEncode, bedrockProvider, egress, openaiEncode, openaiProvider, lastEgressError, resetProvider, selectedBackend, setProvider, type Provider } from "../src/cloud/egress";
import { executePlan, monthRange, validatePlan, CATEGORIES, type Plan } from "../src/cloud/dsl";
import { BLOCKED, CANNED, CLARIFY, SYSTEM_PROMPT, UNREACHABLE, bucket, desymbolize, extractJson, fillTemplate, makeHandleOther, plainText } from "../src/cloud/plan";
import { buildSymbols, symbolizeText } from "../src/cloud/symbolize";
import { DAY } from "../src/handlers/finance";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000); // Oct 22 2026 12:00 PT
const ctx = { now: NOW };
const fixture = () => { const db = openDb(":memory:"); seed(db); return db; };

/** Records every body; answers with the scripted plans in order. */
function recorder(...plans: unknown[]) {
  const bodies: string[] = [];
  const p: Provider = async (body) => {
    bodies.push(body);
    const plan = plans[Math.min(bodies.length - 1, plans.length - 1)];
    return { content: [{ type: "text", text: typeof plan === "string" ? plan : JSON.stringify(plan) }] };
  };
  return { bodies, p };
}

let restore: Provider | null = null;
const use = (p: Provider, enc: "anthropic" | "bedrock" | "openai" = "anthropic") => { restore = setProvider(p, enc); };
afterEach(() => { if (restore) setProvider(restore); restore = null; });

describe("canary", () => {
  test("static system prompt + schema + category list: 0 hits against the full fixture", () => {
    const values = sensitiveValues(fixture());
    expect(values.length).toBeGreaterThan(100);
    const body = JSON.stringify({ max_tokens: 1024, system: SYSTEM_PROMPT, categories: CATEGORIES, messages: [{ role: "user", content: "Question: what changed since M-2?" }] });
    expect(scan(body, values)).toEqual({ checked: values.length, hits: [] });
  });
  test("amount forms; bare whole dollars only from $100", () => {
    expect(amountForms(4312)).toEqual(["43.12", "$43.12", "43,12", "4312", "$43"]);
    expect(amountForms(2850)).toContain("$29"); // rounded too
    expect(amountForms(2800)).toContain("$28");
    expect(amountForms(285000)).toEqual(expect.arrayContaining(["2850.00", "$2850.00", "285000", "2850", "$2850", "2,850", "$2,850", "$2,850.00"]));
    expect(amountForms(-650000)).toContain("$6,500");
  });
  test("codex #8: every *_cents column is inventoried (goal target, receipt subtotal), and $28 blocks", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents) VALUES (1000000, 1, 1, 0)");
    db.run("INSERT INTO receipts(id, source, ts, amount_cents, subtotal_cents) VALUES ('r', 'uber', 1, 2800, 2391)");
    const v = sensitiveValues(db);
    expect(scan("plan to reach 10000.00", v).hits).toContain("10000.00");
    expect(scan("subtotal was 23.91", v).hits).toContain("23.91");
    expect(scan("were rides $28 each", v).hits).toContain("$28");
    expect(scan("were rides 28 each", v).hits).toEqual([]); // bare small integers stay allowed (symbolizer turns them into Q_NUM)
  });
  test("token boundaries, case-insensitive", () => {
    expect(scan("spent at UBER EATS", ["Uber Eats"]).hits).toEqual(["Uber Eats"]);
    expect(scan("MERCHANT_26", ["Uber"]).hits).toEqual([]);
    expect(scan("x143.12", ["43.12"]).hits).toEqual([]);
    expect(scan("total 43.12.", ["43.12"]).hits).toEqual(["43.12"]);
  });
  test("covers merchants, masks, people, addresses (places + receipts) and memos", () => {
    const v = new Set(sensitiveValues(fixture()).map((x) => x.toLowerCase()));
    for (const x of ["blue bottle coffee", "0421", "1550 mission street", "mission street", "1 market street, san francisco, ca 94105", "priya"]) expect(v.has(x)).toBe(true);
    expect([...v].some((x) => x.startsWith("ignore previous instructions"))).toBe(true);
  });
});

describe("egress", () => {
  test("is the only code that reaches an LLM over the network", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(f) && files.push(p); } };
    walk(join(import.meta.dir, "..", "src"));
    walk(join(import.meta.dir, "..", "scripts"));
    const offenders = files.filter((f) => !f.endsWith(join("src", "cloud", "egress.ts"))).filter((f) => {
      const src = readFileSync(f, "utf8");
      if (/api\.anthropic\.com|@anthropic-ai\/|openai|bedrock-runtime/i.test(src)) return true;
      // The local privacy gate may call exactly its own service on 127.0.0.1:8089, nothing else.
      if (f.endsWith(join("cloud", "gate.ts"))) return !(src.match(/https?:\/\/[^\s"'`]+/g) ?? []).every((u) => u.startsWith("http://127.0.0.1:8089/"));
      // The model lister may call the Bedrock control plane only (no prompts, no data), and nothing else on AWS.
      if (f.endsWith(join("scripts", "bedrock-models.ts"))) return !(src.match(/[\w.${}-]*amazonaws\.com/g) ?? []).every((h) => h === "bedrock.${region}.amazonaws.com");
      if (/amazonaws\.com/i.test(src)) return true;
      // The bank data source (not an LLM) may fetch, but only plaid.com hosts.
      if (f.endsWith(join("ingest", "plaid.ts"))) {
        const urls = src.match(/https?:\/\/[^\s"'`]+/g) ?? [];
        return !urls.length || !urls.every((u) => /^https:\/\/(sandbox|production)\.plaid\.com\//.test(u + "/"));
      }
      // Outbound fetch( calls. Bun.serve's `fetch(req) {` handler definitions are servers, not egress. (src/panel/*.html is browser → local panel.)
      return src.split("\n").some((l) => /(?<![\w.])fetch\s*\(/.test(l) && !/^\s*(async\s+)?fetch\s*\([^)]*\)\s*(:\s*[^{]+)?\{/.test(l));
    });
    expect(offenders).toEqual([]);
  });
  test("a hit blocks: the provider is never called", async () => {
    const db = fixture();
    const { bodies, p } = recorder({});
    use(p);
    const r = await egress(db, { messages: [{ role: "user", content: "what about blue bottle coffee" }] });
    expect(r.ok).toBe(false);
    expect(r.canary.hits).toContain("Blue Bottle Coffee");
    expect(bodies).toEqual([]);
  });
  test("clean payload is sent byte-for-byte as scanned, with the pinned model", async () => {
    const db = fixture();
    const { bodies, p } = recorder({ ok: 1 });
    use(p);
    const r = await egress(db, { system: SYSTEM_PROMPT, messages: [{ role: "user", content: "Question: how did MERCHANT_4 change?" }] });
    expect(r.ok).toBe(true);
    expect(r.canary.hits).toEqual([]);
    expect(bodies).toEqual([r.body]);
    expect(JSON.parse(bodies[0]).model).toBe("claude-sonnet-5-5");
  });
  test("egress never writes ledger rows", async () => {
    const db = fixture();
    use(recorder({}).p);
    await egress(db, { messages: [{ role: "user", content: "fine" }] });
    await egress(db, { messages: [{ role: "user", content: "Uber Eats" }] });
    expect((db.query("SELECT COUNT(*) AS c FROM ledger").get() as { c: number }).c).toBe(0);
  });
});

describe("symbolize", () => {
  test("merchants (partial forms), masks, places, people, amounts, long numbers", () => {
    const db = fixture();
    const { text, qsyms } = symbolizeText(db, "Did blue bottle or UBER EATS cost more than $43.12? Card 0421, from 1550 Mission Street, Priya owes me, call 4155550100");
    expect(text).not.toMatch(/blue bottle|uber|0421|mission|priya|43\.12|4155550100/i);
    expect(text).toMatch(/MERCHANT_\d+ or MERCHANT_\d+ cost more than Q_AMT_1\? Card ACCOUNT_\d, from HOME, PERSON_\d owes me, call Q_NUM_1/);
    expect(qsyms).toEqual({ Q_AMT_1: "4312", Q_NUM_1: "4155550100" });
  });
  test("symbols are stable across rebuilds", () => {
    const db = fixture();
    buildSymbols(db);
    const before = db.query("SELECT * FROM symbols ORDER BY symbol").all();
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES ('n1','checking',?,500,'AAA New Shop')", [NOW]);
    buildSymbols(db);
    const after = db.query("SELECT * FROM symbols ORDER BY symbol").all();
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.length).toBe(before.length + 1);
  });
});

/** Small hand-built DB: exact numbers for the executor. */
function small() {
  const db = openDb(":memory:");
  db.run("INSERT INTO accounts VALUES ('chk','Checking','1111','chase','depository','checking',0,'me',300000,?)", [NOW]);
  db.run("INSERT INTO accounts VALUES ('amex','Amex','4417','amex','credit','credit card',1,'shared',90000,?)", [NOW]);
  let n = 0;
  const tx = (ts: number, cents: number, merchant: string, cat: string, owner?: string) => {
    const id = `t${n++}`;
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?,?,?,?,?,?)", [id, "amex", ts, cents, merchant, cat]);
    if (owner) db.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES (?,?,7,0.5)", [id, owner]);
  };
  const [sep] = monthRange(NOW, 1), [oct] = monthRange(NOW, 0);
  tx(sep + DAY, 10000, "Cafe", "FOOD_AND_DRINK", "me");
  tx(sep + 2 * DAY, 4000, "Cafe", "FOOD_AND_DRINK", "shared"); // counts 2000
  tx(sep + 3 * DAY, 99900, "Boutique", "GENERAL_MERCHANDISE", "her"); // counts 0
  tx(sep + 4 * DAY, 5000, "Diner", "FOOD_AND_DRINK"); // unattributed counts 100%
  tx(sep + 5 * DAY, 50000, "Visa Payment", "LOAN_PAYMENTS", "me"); // not spend
  tx(oct + DAY, 3000, "Cafe", "FOOD_AND_DRINK", "me");
  tx(oct + DAY, -650000, "Payroll", "INCOME");
  tx(NOW + DAY, 7777, "Cafe", "FOOD_AND_DRINK", "me"); // future: never counted
  buildSymbols(db);
  return db;
}

describe("dsl", () => {
  const run = (db: ReturnType<typeof small>, plan: unknown, q: Record<string, string> = {}) => {
    const v = validatePlan(plan);
    if (!v.ok) throw new Error(v.error);
    return executePlan(db, v.plan, ctx, q);
  };
  test("sum uses MY_SHARE: her 0, shared half, unattributed full; card payments excluded", () => {
    const r = run(small(), { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }, { id: "s2", op: "sum", filter: { month: "M-1", category: "food_and_drink" } }], answer_template: "{s1} {s2}" });
    expect(r.s1).toEqual({ kind: "cents", v: 17000 });
    expect(r.s2).toEqual({ kind: "cents", v: 17000 });
  });
  test("her charge never shows, even as a merchant symbol", () => {
    const r = run(small(), { steps: [{ id: "s1", op: "group_by", by: "merchant_sym", filter: { month: "M-1" } }], answer_template: "{s1}" });
    expect(r.s1.kind).toBe("list");
    expect((r.s1.v as any[]).map((x) => x.cents)).toEqual([12000, 5000]);
    expect((r.s1.v as any[]).every((x) => /^MERCHANT_\d+$/.test(x.key))).toBe(true);
  });
  test("income, diff, compare with Q_ symbol, project, balance", () => {
    const r = run(small(), { steps: [
      { id: "s1", op: "sum", filter: { direction: "inflow", month: "M-0" } },
      { id: "s2", op: "sum", filter: { month: "M-0" } },
      { id: "s3", op: "diff", inputs: ["s1", "s2"] },
      { id: "s4", op: "compare", inputs: ["s3", "Q_AMT_1"] },
      { id: "s5", op: "balance", filter: { account_type: "depository" } },
      { id: "s6", op: "project", inputs: ["s5", "s3"], months: 2 },
      { id: "s7", op: "balance" },
    ], answer_template: "{s4:yes|no} {s6}" }, { Q_AMT_1: "1000000" });
    expect(r.s1.v).toBe(650000);
    expect(r.s2.v).toBe(3000);
    expect(r.s3.v).toBe(647000);
    expect(r.s4).toEqual({ kind: "bool", v: false });
    expect(r.s6.v).toBe(300000 + 2 * 647000);
    expect(r.s7.v).toBe(300000 - 45000); // credit owed is a liability (codex #14)
  });
  test("avg_monthly over complete months", () => {
    const r = run(small(), { steps: [{ id: "s1", op: "avg_monthly", filter: { months: 2, category: "FOOD_AND_DRINK" } }], answer_template: "{s1}" });
    expect(r.s1.v).toBe(Math.round(17000 / 2)); // Aug + Sep; October excluded
  });
  test.each([
    ["unknown op", { steps: [{ id: "s1", op: "drop_table" }], answer_template: "x" }],
    ["sql in category", { steps: [{ id: "s1", op: "sum", filter: { category: "FOOD'; DROP TABLE ledger;--" } }], answer_template: "x" }],
    ["unknown filter key", { steps: [{ id: "s1", op: "sum", filter: { where: "1=1" } }], answer_template: "x" }],
    ["forward ref", { steps: [{ id: "s1", op: "diff", inputs: ["s2", "s2"] }, { id: "s2", op: "sum" }], answer_template: "x" }],
    ["self ref", { steps: [{ id: "s1", op: "top_n", inputs: ["s1"], n: 3 }], answer_template: "x" }],
    ["50 steps", { steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, op: "count" })), answer_template: "x" }],
    ["bad brace", { steps: [{ id: "s1", op: "sum" }], answer_template: "{memo}" }],
    ["long template", { steps: [{ id: "s1", op: "sum" }], answer_template: "a".repeat(301) }],
    ["extra key", { steps: [{ id: "s1", op: "sum" }], answer_template: "x", sql: "SELECT 1" }],
  ])("rejects %s", (_name, plan) => expect(validatePlan(plan).ok).toBe(false));
});

describe("handleOther", () => {
  const good: Plan = { steps: [{ id: "s1", op: "sum", filter: { category: "FOOD_AND_DRINK", month: "M-1" } }], answer_template: "Food last month: {s1}.", disclose: [] };
  test("happy path: plans in the cloud, answers locally, ledger meta filled", async () => {
    const db = fixture();
    const { bodies, p } = recorder(good);
    use(p);
    const r = await makeHandleOther()(db, "what did blue bottle cost me", ctx);
    expect(r.tier).toBe("cloud");
    expect(r.text).toMatch(/^Food last month: \$[\d,.]+\.$/);
    expect(bodies.length).toBe(1);
    expect(r.ledger!.payload_json).toBe(bodies[0]);
    expect(r.ledger!.question_sym).toMatch(/what did MERCHANT_\d+ cost me/);
    expect(r.ledger!.canary_hits).toBe(0);
    expect(r.ledger!.canary_checked).toBeGreaterThan(100);
    expect(r.text).not.toBe("");
    expect(bodies[0]).not.toContain(r.text); // the filled answer never goes to the cloud
  });
  test("one retry with the validator error, then the canned reply", async () => {
    const { bodies, p } = recorder({ steps: [{ id: "s1", op: "nope" }], answer_template: "x" });
    use(p);
    const r = await makeHandleOther()(fixture(), "hmm", ctx);
    expect(r.text).toBe(CANNED);
    expect(bodies.length).toBe(2);
    expect(bodies[1]).toContain("rejected: unknown op");
  });
  test("a question the symbolizer can't clean is blocked before the network", async () => {
    const { bodies, p } = recorder(good);
    use(p);
    const r = await makeHandleOther()(fixture(), "rides from 1550 Mission Street, San Francisco, CA 94103 via Mission Street", ctx);
    if (r.text !== BLOCKED) expect(JSON.stringify(bodies)).not.toMatch(/mission|1550|94103/i);
    else expect(r.ledger!.canary_hits).toBeGreaterThan(0);
    if (r.text === BLOCKED) expect(bodies).toEqual([]);
  });
  test("blocked egress → canned reply with hits in the ledger", async () => {
    // A receipt-only street the symbolizer doesn't know (no house number, so no ADDR_n): the canary stops it.
    const { bodies, p } = recorder(good);
    use(p);
    const r = await makeHandleOther({ askConsent: async () => "deny" })(fixture(), "how often do I go to willie mays plaza", ctx);
    expect(r.text).toBe(BLOCKED);
    expect(bodies.length).toBe(0);
    expect(r.ledger!.canary_hits).toBeGreaterThan(0);
  });
  test("disclose denied → bucket words go out, partial counted", async () => {
    const db = fixture();
    const { bodies, p } = recorder({ ...good, disclose: ["s1"] }, good);
    use(p);
    const r = await makeHandleOther({ askConsent: async () => "deny" })(db, "is my food spending high", ctx);
    expect(bodies.length).toBe(2);
    const sent = executePlan(db, good, ctx).s1.v as number;
    expect(bodies[1]).toContain(bucket(sent));
    expect(bodies[1]).not.toContain((sent / 100).toFixed(2));
    expect(r.ledger).toMatchObject({ exact_disclosed: 0, partial_count: 1, canary_hits: 0 });
    expect(r.ledger!.consent).toBe("spend:food_and_drink:deny");
  });
});

describe("demo U4: what changed since August (golden plan)", () => {
  // The example in SYSTEM_PROMPT is the plan we want a real model to produce; keep it valid and runnable.
  const golden = JSON.parse(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.lastIndexOf("{\"steps\"")));
  test("the prompt's example plan validates", () => {
    expect(validatePlan(golden)).toMatchObject({ ok: true });
  });
  test("diff of two category lists: per-key change, biggest moves first", () => {
    const db = fixture();
    const r = executePlan(db, (validatePlan(golden) as any).plan, ctx);
    const s3 = r.s3 as any;
    expect(s3.kind).toBe("list");
    expect(s3.signed).toBe(true);
    const abs = s3.v.map((x: any) => Math.abs(x.cents));
    expect(abs).toEqual([...abs].sort((a: number, b: number) => b - a));
    const aug = new Map((r.s1 as any).v.map((x: any) => [x.key, x.cents])), sep = new Map((r.s2 as any).v.map((x: any) => [x.key, x.cents]));
    for (const x of s3.v) expect(x.cents).toBe(((sep.get(x.key) as number) ?? 0) - ((aug.get(x.key) as number) ?? 0));
    expect(r.s7.v).toBe((r.s6.v as number) - (r.s5.v as number));
  });
  test("end to end with a fake planner returning the golden plan", async () => {
    const { bodies, p } = recorder(golden);
    use(p);
    const r = await makeHandleOther()(fixture(), "What changed in my spending since August?", ctx);
    expect(r.tier).toBe("cloud");
    expect(r.text).toMatch(/^Spending went from \$[\d,.]+ in August to \$[\d,.]+ in September \(-?\$[\d,.]+\)\.\nBiggest moves: [a-z ]+ [+-]\$[\d,.]+.*\.\nWant one of those broken down by merchant\? Just ask\.$/);
    expect(bodies[0]).toContain("(M-0 is October.)");
    expect(r.ledger!.canary_hits).toBe(0);
  });
  test("list diff validation: list with number is rejected", () => {
    expect(validatePlan({ steps: [{ id: "s1", op: "group_by", by: "category" }, { id: "s2", op: "sum" }, { id: "s3", op: "diff", inputs: ["s1", "s2"] }], answer_template: "x" }).ok).toBe(false);
  });
});

describe("homoglyphs and leetspeak", () => {
  test.each(["how much at Seph0ra", "how much at \u0405ephora", "1yft rides", "N3tflix", "IK\u0415A", "B1ue B0ttle"])("%s: symbolized and caught raw", (q) => {
    const db = fixture();
    expect(symbolizeText(db, q).text).toMatch(/MERCHANT_\d+/);
    expect(scan(q, sensitiveValues(db)).hits.length).toBeGreaterThan(0);
  });
  test("ordinary numbers are untouched", () => {
    expect(symbolizeText(fixture(), "top 3 in 2026 and 1st week").text).toBe("top 3 in 2026 and 1st week");
  });
});

describe("privacy line (ledger / panel)", () => {
  test("lists only symbol names from today's sent payloads; no real value appears", async () => {
    const db = fixture();
    const { privacyLine, symbolsSentToday } = await import("../src/cloud/privacy");
    expect(privacyLine(db, NOW)).toBe("Cloud today: nothing left your Mac.");
    const plan = { steps: [{ id: "s1", op: "sum", filter: { merchant_sym: "MERCHANT_4" } }], answer_template: "{s1}", disclose: [] };
    use(recorder(plan).p);
    const h = makeHandleOther();
    // Written the way the router writes them: one row per answer, copying Reply.ledger.
    const write = (r: Awaited<ReturnType<typeof h>>) => db.run(`INSERT INTO ledger(ts, tier, intent, question_sym, payload_json, exact_disclosed, partial_count, canary_checked, canary_hits)
      VALUES (?, ?, 'other', ?, ?, ?, ?, ?, ?)`, [NOW - 60, r.tier, r.ledger?.question_sym ?? null, r.ledger?.payload_json ?? null,
      r.ledger?.exact_disclosed ?? 0, r.ledger?.partial_count ?? 0, r.ledger?.canary_checked ?? null, r.ledger?.canary_hits ?? null]);
    write(await h(db, "how much at Blue Bottle Coffee vs $43.12 near 1 Market St", ctx));
    write(await h(db, "summarize: Blue Bottle Coffee", ctx)); // symbolized, fine
    const s = symbolsSentToday(db, NOW);
    expect(s.calls).toBe(2);
    expect(s.symbols).toEqual(["MERCHANT_4", "Q_AMT_1", "WORK"]);
    const line = privacyLine(db, NOW);
    expect(line).toBe("Cloud today: 2 calls. Sent as symbols only: MERCHANT_4, Q_AMT_1, WORK. 0 exact values, 0 partial.");
    expect(scan(line, sensitiveValues(db)).hits).toEqual([]);
    // Yesterday's rows don't count.
    db.run("UPDATE ledger SET ts = ts - 86400");
    expect(privacyLine(db, NOW)).toBe("Cloud today: nothing left your Mac.");
  });
});

describe("Bedrock (GLM via Converse)", () => {
  const plan = { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }], answer_template: "Last month: {s1}.", disclose: [] };
  test("the canary scans the exact Converse body that goes on the wire", async () => {
    const bodies: string[] = [];
    use(async (b) => { bodies.push(b); return { content: [{ type: "text", text: JSON.stringify(plan) }] }; }, "bedrock");
    const r = await makeHandleOther()(fixture(), "how much at Blue Bottle last month?", ctx);
    expect(r.tier).toBe("cloud");
    expect(r.text).toMatch(/^Last month: \$/);
    const body = JSON.parse(bodies[0]);
    expect(Object.keys(body).sort()).toEqual(["inferenceConfig", "messages", "system"]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 1500, temperature: 0 });
    expect(body.system).toEqual([{ text: SYSTEM_PROMPT }]);
    expect(body.messages[0]).toEqual({ role: "user", content: [{ text: expect.stringMatching(/^Question: how much at MERCHANT_\d+ last month\?/) }] });
    expect(r.ledger!.payload_json).toBe(bodies[0]);
  });
  test("a smuggled value is blocked in the Converse encoding too", async () => {
    const bodies: string[] = [];
    use(async (b) => { bodies.push(b); return {}; }, "bedrock");
    const res = await egress(fixture(), { messages: [{ role: "user", content: "Blue Bottle Coffee 0421" }] });
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.body).messages[0].content[0].text).toContain("0421");
    expect(bodies).toEqual([]);
  });
  test("bedrockProvider: URL, bearer header, exact body, response normalized", async () => {
    const env = { ...process.env };
    const realFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    Object.assign(process.env, { AWS_BEARER_TOKEN_BEDROCK: "test-token", AWS_REGION: "us-west-2", BEDROCK_MODEL_ID: "zai.glm-5:3" });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "```json\n{\"steps\":[]}" }, { text: "\n```" }] } }, stopReason: "end_turn" }));
    }) as typeof fetch;
    try {
      const body = bedrockEncode({ system: "sys", messages: [{ role: "user", content: "hi" }] });
      const out = await bedrockProvider(body);
      expect(calls[0].url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/zai.glm-5%3A3/converse");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
      expect(calls[0].init.body).toBe(body);
      expect(out).toEqual({ content: [{ type: "text", text: "```json\n{\"steps\":[]}\n```" }] });
    } finally {
      globalThis.fetch = realFetch;
      process.env = env;
    }
  });
  test("LLM_PROVIDER selects the backend; openai is the default", () => {
    const prev = process.env.LLM_PROVIDER;
    try {
      delete process.env.LLM_PROVIDER; expect(selectedBackend().name).toBe("openai");
      process.env.LLM_PROVIDER = ""; expect(selectedBackend().name).toBe("openai");
      process.env.LLM_PROVIDER = "bedrock"; expect(selectedBackend().name).toBe("bedrock");
      process.env.LLM_PROVIDER = "anthropic"; expect(selectedBackend().name).toBe("anthropic");
      process.env.LLM_PROVIDER = "fake"; expect(selectedBackend().name).toBe("fake");
    } finally { if (prev === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prev; }
  });
});

describe("planner output drift (open-weight models)", () => {
  test.each([
    ["fenced", "```json\n{\"steps\":[1]}\n```"],
    ["prose before and after", "Sure! Here is the plan: {\"steps\":[1]} Hope that helps {:)}"],
    ["reasoning block", "<think>maybe {\"x\":1}</think>\n{\"steps\":[1]}"],
    ["brace inside a string", "{\"steps\":[1],\"answer_template\":\"a } b\"}"],
  ])("%s", (_n, text) => expect(extractJson(text)).toMatchObject({ steps: [1] }));
  test("no JSON → null", () => expect(extractJson("I can't help with that.")).toBeNull());
  test("a chatty planner still gets answered, no retry needed", async () => {
    const plan = { steps: [{ id: "s1", op: "count" }], answer_template: "{s1} purchases.", disclose: [] };
    const { bodies, p } = recorder(`Okay, here's my plan.\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nLet me know!`);
    use(p);
    const r = await makeHandleOther()(fixture(), "how many purchases", ctx);
    expect(r.text).toMatch(/^\d+ purchases\.$/);
    expect(bodies.length).toBe(1);
  });
});

describe("blocked calls in the ledger", () => {
  test("BLOCKED is tier cloud with canary_hits > 0, and privacyLine counts it", async () => {
    const db = fixture();
    const { privacyLine } = await import("../src/cloud/privacy");
    const { p } = recorder({ steps: [{ id: "s1", op: "count" }], answer_template: "{s1}", disclose: [] });
    use(p);
    const r = await makeHandleOther()(db, "how often do I go to willie mays plaza", ctx);
    expect(r.text).toBe(BLOCKED);
    expect(r.tier).toBe("cloud");
    expect(r.ledger!.canary_hits).toBeGreaterThan(0);
    db.run("INSERT INTO ledger(ts, tier, intent, payload_json, canary_checked, canary_hits) VALUES (?, ?, 'other', ?, ?, ?)",
      [NOW - 60, r.tier, r.ledger!.payload_json!, r.ledger!.canary_checked!, r.ledger!.canary_hits!]);
    expect(privacyLine(db, NOW)).toMatch(/1 blocked by the leak check\.$/);
    expect(scan(privacyLine(db, NOW), sensitiveValues(db)).hits).toEqual([]);
  });
});

describe("strict question symbols (codex #12, plan side)", () => {
  test("a template naming a Q_AMT the question doesn't have → canned, not $0", async () => {
    const { p } = recorder({ steps: [{ id: "s1", op: "count" }], answer_template: "{s1} vs {Q_AMT_9}", disclose: [] });
    use(p);
    expect((await makeHandleOther()(fixture(), "how many purchases", ctx)).text).toBe(CANNED);
  });
  test("a step input naming a missing Q_AMT → canned, not a crash", async () => {
    const { p } = recorder({ steps: [{ id: "s1", op: "sum" }, { id: "s2", op: "compare", inputs: ["s1", "Q_AMT_9"], cmp: "gt" }], answer_template: "{s2:yes|no}", disclose: [] });
    use(p);
    expect((await makeHandleOther()(fixture(), "did I spend a lot", ctx)).text).toBe(CANNED);
  });
});

describe("Bedrock errors are surfaced, never with the token", () => {
  const withFetch = async (status: number, body: string, fn: () => Promise<void>) => {
    const env = { ...process.env }, realFetch = globalThis.fetch;
    // FIN_TEST_NETWORK opts this test into the real provider code path; fetch is mocked, so nothing leaves.
    Object.assign(process.env, { LLM_PROVIDER: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "SECRET-TOKEN-123", AWS_REGION: "us-west-1", BEDROCK_MODEL_ID: "us.zai.glm-5.3", FIN_TEST_NETWORK: "1" });
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
    resetProvider();
    try { await fn(); } finally { globalThis.fetch = realFetch; process.env = env; resetProvider(); }
  };
  test("400 Operation not allowed → status, message and the console hint", async () => {
    await withFetch(400, JSON.stringify({ message: "Operation not allowed" }), async () => {
      const res = await egress(fixture(), { system: "s", messages: [{ role: "user", content: "hi" }] });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(`planner HTTP 400: Operation not allowed (${BEDROCK_ACCESS_HINT})`);
      expect(lastEgressError()).toBe(res.error!);
    });
  });
  test("403 → region/expiry hint; a token echoed by the server is redacted", async () => {
    await withFetch(403, "The security token SECRET-TOKEN-123 is invalid", async () => {
      const res = await egress(fixture(), { messages: [{ role: "user", content: "hi" }] });
      expect(res.error).toContain("planner HTTP 403: The security token [token] is invalid");
      expect(res.error).toContain("AWS_REGION");
      expect(res.error).not.toContain("SECRET-TOKEN-123");
    });
  });
  test("handleOther still answers with the plain unreachable reply (no internals on the phone)", async () => {
    await withFetch(400, JSON.stringify({ message: "Operation not allowed" }), async () => {
      const r = await makeHandleOther()(fixture(), "what changed since august", ctx);
      expect(r.text).toMatch(/didn't answer/);
      expect(lastEgressError()).toContain("Model catalog");
    });
  });
});

describe("Anthropic backup path (LLM_PROVIDER=anthropic), mocked", () => {
  test("URL, key header, exact body, pinned model; an echoed key is redacted from errors", async () => {
    const env = { ...process.env }, realFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    process.env.ANTHROPIC_API_KEY = "sk-test-SECRET";
    let status = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return status === 200 ? new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }))
        : new Response("bad key sk-test-SECRET", { status });
    }) as unknown as typeof fetch;
    try {
      const body = anthropicEncode({ system: "s", messages: [{ role: "user", content: "hi" }] });
      expect(JSON.parse(body).model).toBe("claude-sonnet-5-5");
      expect(await anthropicProvider(body)).toEqual({ content: [{ type: "text", text: "{}" }] });
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-SECRET");
      expect(calls[0].init.body).toBe(body);
      status = 401;
      const err = await anthropicProvider(body).then(() => "", (e) => String(e.message));
      expect(err).toBe("planner HTTP 401: bad key [token]");
    } finally { globalThis.fetch = realFetch; process.env = env; }
  });
});

describe("OpenAI (GPT-6.1 Sol via Chat Completions)", () => {
  const PLAN = { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }], answer_template: "Last month: {s1}.", disclose: [] };
  /** Runs fn with OpenAI env set and fetch mocked; nothing leaves the machine. */
  const withOpenAI = async (respond: (url: string, init: RequestInit) => Response, fn: (calls: { url: string; init: RequestInit }[]) => Promise<void>) => {
    const env = { ...process.env }, realFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    Object.assign(process.env, { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-proj-SECRET-999", FIN_TEST_NETWORK: "1" });
    delete process.env.OPENAI_MODEL; delete process.env.OPENAI_REASONING_EFFORT;
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); }) as unknown as typeof fetch;
    resetProvider();
    try { await fn(calls); } finally { globalThis.fetch = realFetch; process.env = env; resetProvider(); }
  };
  const chat = (content: string | null) => new Response(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content } }] }));

  test("encode: system first, then our turns; model, completion budget and reasoning effort (env-overridable)", () => {
    const env = { ...process.env };
    try {
      delete process.env.OPENAI_MODEL; delete process.env.OPENAI_REASONING_EFFORT;
      const b = JSON.parse(openaiEncode({ max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: "user", content: "Q" }, { role: "assistant", content: "A" }] }));
      expect(Object.keys(b).sort()).toEqual(["max_completion_tokens", "messages", "model", "reasoning_effort"]);
      expect(b).toMatchObject({ model: "gpt-6.1-sol", max_completion_tokens: 4000, reasoning_effort: "low" });
      expect(b.messages).toEqual([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "Q" }, { role: "assistant", content: "A" }]);
      Object.assign(process.env, { OPENAI_MODEL: "gpt-other", OPENAI_REASONING_EFFORT: "medium" });
      expect(JSON.parse(openaiEncode({ messages: [] }))).toMatchObject({ model: "gpt-other", reasoning_effort: "medium", messages: [] });
    } finally { process.env = env; }
  });
  test("provider: URL, bearer header, byte-identical body, response normalized", async () => {
    await withOpenAI(() => chat("{\"steps\":[]}"), async (calls) => {
      const body = openaiEncode({ system: "s", messages: [{ role: "user", content: "hi" }] });
      expect(await openaiProvider(body)).toEqual({ content: [{ type: "text", text: "{\"steps\":[]}" }] });
      expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
      expect(calls[0].init.method).toBe("POST");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-proj-SECRET-999");
      expect(calls[0].init.body).toBe(body);
    });
  });
  test("a null content (refusal) normalizes to empty text, which the planner path treats as no plan", async () => {
    await withOpenAI(() => chat(null), async () => {
      expect(await openaiProvider(openaiEncode({ messages: [] }))).toEqual({ content: [{ type: "text", text: "" }] });
      expect((await makeHandleOther()(fixture(), "how am I doing", ctx)).text).toBe(CANNED);
    });
  });
  test("the key is redacted when the server echoes it in an error", async () => {
    await withOpenAI(() => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-SECRET-999.", code: "invalid_api_key" } }), { status: 401 }), async () => {
      const res = await egress(fixture(), { messages: [{ role: "user", content: "hi" }] });
      expect(res.error).toBe("planner HTTP 401: Incorrect API key provided: [token].");
      expect(JSON.stringify(res)).not.toContain("SECRET-999");
    });
  });
  test("a 404 model message reaches lastEgressError; the phone gets the plain reply", async () => {
    const msg = "The model `gpt-6.1-sol` does not exist or you do not have access to it.";
    await withOpenAI(() => new Response(JSON.stringify({ error: { message: msg, type: "invalid_request_error", code: "model_not_found" } }), { status: 404 }), async () => {
      const r = await makeHandleOther()(fixture(), "what changed since august", ctx);
      expect(r.text).toBe(UNREACHABLE);
      expect(lastEgressError()).toBe(`planner HTTP 404: ${msg}`);
    });
  });
  test("end to end: the canary scans the Chat Completions body, which is what gets sent and logged", async () => {
    const bodies: string[] = [];
    use(async (b) => { bodies.push(b); return { content: [{ type: "text", text: JSON.stringify(PLAN) }] }; }, "openai");
    const r = await makeHandleOther()(fixture(), "how much at Blue Bottle last month?", ctx);
    expect(r.text).toMatch(/^Last month: \$/);
    const body = JSON.parse(bodies[0]);
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toMatch(/^Question: how much at MERCHANT_\d+ last month\?/);
    expect(r.ledger!.payload_json).toBe(bodies[0]);
    expect(r.ledger!.canary_hits).toBe(0);
  });
  test("a smuggled value is blocked in the Chat Completions encoding too", async () => {
    const bodies: string[] = [];
    use(async (b) => { bodies.push(b); return {}; }, "openai");
    const res = await egress(fixture(), { messages: [{ role: "user", content: "Blue Bottle Coffee 0421" }] });
    expect(res.ok).toBe(false);
    expect(bodies).toEqual([]);
  });
  test("privacyLine lists only the question's symbols, not the system prompt's HOME/WORK/Q_AMT_1", async () => {
    const db = fixture();
    const { privacyLine } = await import("../src/cloud/privacy");
    use(async () => ({ content: [{ type: "text", text: JSON.stringify(PLAN) }] }), "openai");
    const r = await makeHandleOther()(db, "how much at Blue Bottle last month?", ctx);
    db.run("INSERT INTO ledger(ts, tier, intent, payload_json, canary_checked, canary_hits) VALUES (?, 'cloud', 'other', ?, ?, 0)", [NOW - 60, r.ledger!.payload_json!, r.ledger!.canary_checked!]);
    expect(privacyLine(db, NOW)).toMatch(/^Cloud today: 1 call\. Sent as symbols only: MERCHANT_\d+\. 0 exact values, 0 partial\.$/);
  });
  test("bun test guard covers openai: no FIN_TEST_NETWORK, no send", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "openai";
    resetProvider();
    try {
      const res = await egress(fixture(), { messages: [{ role: "user", content: "hi" }] });
      expect(res.error).toContain("network disabled under bun test");
    } finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  });
});

describe("replies never show symbols (live bug: 'what is an Uber?')", () => {
  test("the exact live reply is desymbolized locally", async () => {
    const db = fixture();
    const uber = (db.query("SELECT symbol FROM symbols WHERE kind = 'merchant' AND real = 'Uber'").get() as { symbol: string } | null)?.symbol
      ?? (buildSymbols(db), (db.query("SELECT symbol FROM symbols WHERE kind = 'merchant' AND real = 'Uber'").get() as { symbol: string }).symbol);
    const tpl = `${uber} is an anonymized merchant label with {s1} matching transactions. The label alone doesn't identify the business.`;
    const bodies: string[] = [];
    use(async (b) => { bodies.push(b); return { content: [{ type: "text", text: JSON.stringify({ steps: [{ id: "s1", op: "count", filter: { merchant_sym: uber } }], answer_template: tpl, disclose: [] }) }] }; });
    const r = await makeHandleOther()(db, "what is an Uber?", ctx);
    expect(r.ledger!.question_sym).toBe(`what is an ${uber}?`);
    expect(r.text).toMatch(/^Uber is an anonymized merchant label with \d+ matching transactions\./);
    expect(r.text).not.toMatch(/MERCHANT_\d+/);
    for (const b of bodies) expect(b).not.toMatch(/\bUber\b/); // nothing desymbolized ever went out
  });
  test("every symbol kind → what the user calls it; her-only merchants and unknowns stay generic", () => {
    const db = fixture();
    buildSymbols(db);
    const sym = (real: string, kind: string) => (db.query("SELECT symbol FROM symbols WHERE kind = ? AND real = ?").get(kind, real) as { symbol: string }).symbol;
    const her = (db.query(`SELECT t.merchant AS m FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
      GROUP BY t.merchant HAVING SUM(COALESCE(a.owner, '') != 'her') = 0 LIMIT 1`).get() as { m: string }).m;
    const q = { Q_AMT_1: "120000", Q_NUM_1: "2027", ADDR_1: "742 Evergreen Terrace" };
    const t = `${sym("Blue Bottle Coffee", "merchant")} vs ${sym(her, "merchant")}, card ${sym("0421", "account")}, ${sym("Priya", "person")}, HOME to WORK, ADDR_1, Q_AMT_1 by Q_NUM_1, MERCHANT_999, Q_AMT_7`;
    expect(desymbolize(db, t, q)).toBe("Blue Bottle Coffee vs a merchant, card ••0421, Priya, home to work, 742 Evergreen Terrace, $1,200 by 2027, a merchant, that amount");
  });
  test("compare choice text is desymbolized; filled values are not re-scanned", async () => {
    const db = fixture();
    buildSymbols(db);
    const bb = (db.query("SELECT symbol FROM symbols WHERE real = 'Blue Bottle Coffee'").get() as { symbol: string }).symbol;
    const out = fillTemplate(db, `{s1:${bb} wins|nope} {s2}`, { s1: { kind: "bool", v: true }, s2: { kind: "cents", v: 1250 } }, {});
    expect(out).toBe("Blue Bottle Coffee wins $13"); // computed amounts: whole dollars
  });
  test("no code path sends a desymbolized reply back: retry and disclose turns stay symbolized", async () => {
    const db = fixture();
    buildSymbols(db);
    const bb = (db.query("SELECT symbol FROM symbols WHERE real = 'Blue Bottle Coffee'").get() as { symbol: string }).symbol;
    const bodies: string[] = [];
    const plans = [
      { steps: [{ id: "s1", op: "nope" }], answer_template: `${bb} x` },                                                        // rejected → retry
      { steps: [{ id: "s1", op: "count", filter: { merchant_sym: bb } }], answer_template: `${bb}: {s1}`, disclose: ["s1"] }, // disclose → follow-up
      { steps: [{ id: "s1", op: "count", filter: { merchant_sym: bb } }], answer_template: `${bb}: {s1} visits`, disclose: [] },
    ];
    use(async (b) => { bodies.push(b); return { content: [{ type: "text", text: JSON.stringify(plans[bodies.length - 1]) }] }; });
    const r = await makeHandleOther({ askConsent: async () => "deny" })(db, "how often do I go to Blue Bottle", ctx);
    expect(bodies.length).toBe(3);
    expect(r.text).toMatch(/^Blue Bottle Coffee: \d+ visits$/);
    for (const b of bodies) expect(b).not.toMatch(/blue bottle/i);
  });
});

describe("clarify: non-money messages never get the model's chit-chat", () => {
  test.each([
    ["clarify plan", { steps: [], answer_template: null, clarify: true }],
    ["empty steps with chit-chat (the live bug)", { steps: [], answer_template: "lol same, idk either 😅" }],
  ])("%s → the fixed help line, one call, no retry", async (_n, plan) => {
    const { bodies, p } = recorder(plan, { steps: [{ id: "s1", op: "count" }], answer_template: "chit-chat prose {s1}", disclose: [] });
    use(p);
    const r = await makeHandleOther()(fixture(), "nah fam idk what that is", ctx);
    expect(r).toMatchObject({ text: CLARIFY, tier: "cloud" });
    expect(bodies.length).toBe(1);
    expect(r.ledger!.payload_json).toBe(bodies[0]);
  });
  test("validator: empty steps only in the exact clarify shape", () => {
    expect(validatePlan({ steps: [], answer_template: null, clarify: true })).toMatchObject({ ok: true, plan: { clarify: true, steps: [] } });
    for (const bad of [
      { steps: [], answer_template: "hi" },
      { steps: [], answer_template: "hi", clarify: true },
      { steps: [{ id: "s1", op: "count" }], answer_template: null, clarify: true },
      { steps: [], answer_template: null, clarify: "yes" },
      { steps: [], answer_template: null, clarify: true, disclose: ["s1"] },
    ]) expect(validatePlan(bad).ok).toBe(false);
  });
});

describe("voice: cloud replies read like a text, not a document", () => {
  test("plainText strips markdown, makes bullets •, keeps negative amounts and at most one blank line", () => {
    expect(plainText("## Total\n**$12** this month\n- Costco\n* Uber\n+ Lyft\n\n\n\n-$5 refund  ")).toBe("Total\n$12 this month\n• Costco\n• Uber\n• Lyft\n\n-$5 refund");
    expect(plainText("Use `group_by` __now__")).toBe("Use group_by now");
  });
  test("a markdown-y planner template reaches the phone as plain text", async () => {
    const plan = { steps: [{ id: "s1", op: "count" }], answer_template: "**{s1} purchases** last month.\n- Want a breakdown? Just ask.", disclose: [] };
    const { p } = recorder(plan);
    use(p);
    expect((await makeHandleOther()(fixture(), "how many purchases", ctx)).text).toMatch(/^\d+ purchases last month\.\n• Want a breakdown\? Just ask\.$/);
  });
  test("the prompt asks for the voice, and its example follows it: answer first, at most one next step, short lines", () => {
    expect(SYSTEM_PROMPT).toContain("Voice: a sharp friend texting. The answer goes in the first line.");
    const golden = JSON.parse(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.lastIndexOf('{"steps"'))).answer_template as string;
    const lines = golden.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.filter((l) => l.endsWith("?") || /just ask/i.test(l)).length).toBe(1);
    expect(golden).not.toMatch(/\*\*|^#|`|\bsure\b|here's/im);
  });
});

describe("messy real-statement merchants (synthetic) don't block ordinary questions", () => {
  const messy = () => {
    const db = fixture();
    const names = ["Debit Card Purchase - SAMPLE CAFE 123456", "Monthly Interest Paid", "THE PLAN SHOP", "LATE FEE - AUG PAYMENT PAST DUE",
      "SOME LANE - CITY CA", "AUGUST HALL", "Withdrawal From EXAMPLE CO card payment", "ATM Cash Deposit"];
    names.forEach((m, i) => db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'checking', ?, 1234, ?, 'GENERAL_MERCHANDISE')", [`messy${i}`, NOW - 86_400 * (i + 1), m]));
    return db;
  };
  test("the static prompt matches none of their values; ordinary questions go out intact", async () => {
    const db = messy();
    expect(scan(SYSTEM_PROMPT, sensitiveValues(db)).hits).toEqual([]);
    const plan = { steps: [{ id: "s1", op: "count" }], answer_template: "{s1}", disclose: [] };
    for (const q of ["What changed in my spending since August?", "Which subscriptions am I paying for every month?", "is the plan on track for this month"]) {
      const { p } = recorder(plan);
      use(p);
      const r = await makeHandleOther()(db, q, ctx);
      expect([r.tier, r.text === BLOCKED, r.ledger!.question_sym]).toEqual(["cloud", false, q]);
    }
  });
  test("their full names still block or get symbolized; generic fragments alone identify nothing", () => {
    const db = messy();
    expect(symbolizeText(db, "how much at sample cafe?").text).toMatch(/MERCHANT_\d+/);
    expect(scan("Debit Card Purchase - SAMPLE CAFE 123456", sensitiveValues(db)).hits.length).toBeGreaterThan(0);
    expect(scan("about the plan and my card payment in August", sensitiveValues(db)).hits).toEqual([]);
  });
  test("a static prompt that ever matches a DB value fails closed", async () => {
    const db = fixture();
    const { bodies, p } = recorder({});
    use(p);
    const res = await egress(db, { system: "You plan answers. Blue Bottle Coffee.", messages: [{ role: "user", content: "hi" }] });
    expect(res).toMatchObject({ ok: false, error: "blocked" });
    expect(bodies).toEqual([]);
  });
});

describe("divide: runway arithmetic on the device (live: Sol asked to disclose for it)", () => {
  const runwayExample = () => {
    const i = SYSTEM_PROMPT.indexOf('{"steps": [{"id": "s1", "op": "balance"');
    return JSON.parse(SYSTEM_PROMPT.slice(i, SYSTEM_PROMPT.indexOf("\n", i)));
  };
  test("amount ÷ monthly amount = months; amount ÷ amount = ratio; mismatches rejected", () => {
    const base = [{ id: "s1", op: "balance", filter: { account_type: "depository" } }, { id: "s2", op: "avg_monthly", filter: { months: 3 } }, { id: "s3", op: "sum", filter: { month: "M-1" } }];
    const ok = (extra: object[], tpl: string) => validatePlan({ steps: [...base, ...extra], answer_template: tpl });
    expect(ok([{ id: "s4", op: "divide", inputs: ["s1", "s2"] }], "{s4}").ok).toBe(true);
    expect(ok([{ id: "s4", op: "divide", inputs: ["s1", "s3"] }], "{s4}").ok).toBe(true);
    expect(ok([{ id: "s4", op: "divide", inputs: ["Q_AMT_1", "s2"] }], "{s4}").ok).toBe(true);
    expect(ok([{ id: "s4", op: "count" }, { id: "s5", op: "divide", inputs: ["s4", "s1"] }], "{s5}").ok).toBe(false); // count ÷ cents
    expect(ok([{ id: "s4", op: "group_by", by: "category" }, { id: "s5", op: "divide", inputs: ["s4", "s1"] }], "{s5}").ok).toBe(false);
    expect(ok([{ id: "s4", op: "divide", inputs: ["s1", "s2"] }, { id: "s5", op: "compare", inputs: ["s4", "Q_AMT_1"], cmp: "gt" }], "{s5:a|b}").ok).toBe(false); // months vs dollars
    expect(ok([{ id: "s4", op: "divide", inputs: ["s1"] }], "{s4}").ok).toBe(false);
  });
  test("executes and renders: months, ratio, and a runway that never runs out", () => {
    const db = small();
    const plan = validatePlan({ steps: [
      { id: "s1", op: "balance", filter: { account_type: "depository" } }, { id: "s2", op: "avg_monthly", filter: { months: 2, category: "FOOD_AND_DRINK" } },
      { id: "s3", op: "divide", inputs: ["s1", "s2"] }, { id: "s4", op: "sum", filter: { month: "M-1" } }, { id: "s5", op: "divide", inputs: ["s4", "s1"] },
      { id: "s6", op: "avg_monthly", filter: { months: 2, category: "TRAVEL" } }, { id: "s7", op: "divide", inputs: ["s1", "s6"] },
    ], answer_template: "{s3} · {s5} · {s7}" }) as any;
    const r = executePlan(db, plan.plan, ctx);
    expect(r.s3).toEqual({ kind: "months", v: 300000 / 8500 });
    expect(r.s5.kind).toBe("ratio");
    expect(r.s7).toEqual({ kind: "months", v: Infinity });
    expect(fillTemplate(db, plan.plan.answer_template, r, {})).toBe("about 35 months · 6% · more than ten years");
  });
  test("the prompt's runway example validates, and the live question gets an answer with no disclosure", async () => {
    const plan = runwayExample();
    expect(validatePlan(plan).ok).toBe(true);
    let asked = 0;
    const { bodies, p } = recorder(plan);
    use(p);
    const r = await makeHandleOther({ askConsent: async () => { asked++; return "deny"; } })(fixture(),
      "If I lost my job on the first day of January while saving the same amount I do today, how many months could I survive with my current expenditure?", ctx);
    expect(r.text).toMatch(/which covers about \d+(\.\d)? months of your current spending\.\nText goal to see your full plan\.$/);
    expect([asked, bodies.length, r.ledger!.exact_disclosed]).toEqual([0, 1, 0]);
  });
});

describe("balance includes the balances the user told us about (manual_assets)", () => {
  test("cash and net worth count them; card debt doesn't", () => {
    const db = small();
    const run = (f: object) => executePlan(db, (validatePlan({ steps: [{ id: "s1", op: "balance", filter: f }], answer_template: "{s1}" }) as any).plan, ctx).s1.v;
    const before = [run({ account_type: "depository" }), run({}), run({ account_type: "credit" })];
    db.run("INSERT INTO manual_assets(name, amount_cents, created_ts) VALUES ('Robinhood', 1000000, ?)", [NOW]);
    expect([run({ account_type: "depository" }), run({}), run({ account_type: "credit" })]).toEqual([before[0] + 1000000, before[1] + 1000000, before[2]]);
  });
});

test("planner answers show computed amounts in whole dollars (live: \"$16,221.98\"); the user's own amounts stay as typed", () => {
  const db = small();
  const r = { s1: { kind: "cents", v: 1_622_198 }, s2: { kind: "cents", v: 450 } } as any;
  expect(fillTemplate(db, "You'd have about {s1} left, {s2} a day; you said {Q_AMT_1}.", r, { Q_AMT_1: "4312" })).toBe("You'd have about $16,222 left, $4.50 a day; you said $43.12.");
  expect(SYSTEM_PROMPT).toContain('Never ask for something the question already says ("down to zero" is how much to keep).');
});

