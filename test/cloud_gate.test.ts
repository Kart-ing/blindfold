// The local privacy gate (src/cloud/gate.ts): every user turn we author goes through it before the cloud; it fails closed.
import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { egress, setProvider, type Provider } from "../src/cloud/egress";
import { familyOf, gateTimeoutMs, layaGate, parseGate, setGate, type Entity, type Gate } from "../src/cloud/gate";
import { desymbolize, makeHandleOther } from "../src/cloud/plan";
import { understand } from "../src/cloud/converse";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000);
const ctx = { now: NOW };
let restore: Provider | null = null;
afterEach(() => { if (restore) setProvider(restore); restore = null; setGate(null); });
function record(json: object = { content: [{ type: "text", text: "{}" }] }) {
  const bodies: string[] = [];
  restore = setProvider(async (b) => { bodies.push(b); return json; }, "openai");
  return bodies;
}
/** A fake classifier: tags the given words wherever they occur. */
const fakeGate = (tags: Record<string, string>, score = 0.9): Gate => async (text) => {
  const out: Entity[] = [];
  for (const [word, label] of Object.entries(tags)) for (const m of text.matchAll(new RegExp(word, "g"))) out.push({ text: word, label, score, start: m.index!, end: m.index! + word.length });
  return out;
};
const userTurn = (body: string) => (JSON.parse(body).messages as { role: string; content: string }[]).find((m) => m.role === "user")!.content;

describe("gate: entities become symbols before the cloud", () => {
  test("a name the DB and the cues don't know becomes PERSON_n (empty DB), and replies restore it", async () => {
    const db = openDb(":memory:");
    setGate(fakeGate({ Priya: "PERSON" }));
    const bodies = record();
    await egress(db, { messages: [{ role: "user", content: "Priya covers the rent for me" }] });
    expect(userTurn(bodies[0])).toBe("PERSON_1 covers the rent for me");
    expect(desymbolize(db, "PERSON_1 covers it", {})).toBe("Priya covers it");
  });
  test("addresses, cities, emails, phones and account numbers; dates stay; amounts become words", async () => {
    const db = openDb(":memory:");
    setGate(fakeGate({ "742 Evergreen Terrace": "STREET_ADDRESS", Springfield: "CITY", "jo@example.com": "EMAIL", "555-0100": "PHONE_NUMBER", "9876543210": "ACCOUNT_NUMBER", "next Friday": "DATE", "forty bucks": "AMOUNT" }));
    const bodies = record();
    await egress(db, { messages: [{ role: "user", content: "jo@example.com at 742 Evergreen Terrace, Springfield; acct 9876543210; call 555-0100 next Friday about forty bucks" }] });
    expect(userTurn(bodies[0])).toBe("EMAIL_1 at ADDR_101, ADDR_102; acct ACCOUNT_1; call PHONE_1 next Friday about an amount");
  });
  test("low scores, spans inside our symbols, and consented values are left alone", async () => {
    const db = openDb(":memory:");
    setGate(async (text) => [
      { text: "Maybe", label: "PERSON", score: 0.3, start: text.indexOf("Maybe"), end: text.indexOf("Maybe") + 5 },
      { text: "PERSON", label: "PERSON", score: 0.99, start: text.indexOf("PERSON_3"), end: text.indexOf("PERSON_3") + 6 },
      { text: "2850.00", label: "AMOUNT", score: 0.99, start: text.indexOf("2850.00"), end: text.indexOf("2850.00") + 7 },
    ]);
    const bodies = record();
    await egress(db, { messages: [{ role: "user", content: "Maybe PERSON_3 paid 2850.00" }] }, { allow: ["2850.00"] });
    expect(userTurn(bodies[0])).toBe("Maybe PERSON_3 paid 2850.00");
  });
  test("the same text keeps the same symbol across calls; the canary still runs last", async () => {
    const db = openDb(":memory:"); seed(db);
    setGate(fakeGate({ Priya: "PERSON" }));
    const bodies = record();
    await egress(db, { messages: [{ role: "user", content: "Priya again" }] });
    await egress(db, { messages: [{ role: "user", content: "and Priya" }] });
    const [a, b] = [userTurn(bodies[0]), userTurn(bodies[1])];
    expect(a).toMatch(/^PERSON_\d+ again$/);
    expect(b).toBe(`and ${a.split(" ")[0]}`);
    const blocked = await egress(db, { messages: [{ role: "user", content: "how much at Blue Bottle Coffee" }] }); // gate tags nothing here
    expect(blocked).toMatchObject({ ok: false, error: "blocked" });
  });
});

describe("gate: fails closed", () => {
  test.each([
    ["down", (async () => { throw new Error("ECONNREFUSED"); }) as Gate],
    ["timeout", (async () => { throw new Error("The operation timed out."); }) as Gate],
    ["invalid output", (async () => parseGate({ entities: [{ text: "x" }] })) as Gate],
  ])("%s → nothing sent, NotSent-style result", async (_n, g) => {
    setGate(g);
    const bodies = record();
    const r = await egress(openDb(":memory:"), { messages: [{ role: "user", content: "hello" }] });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(r.error).toMatch(/^gate: unavailable or invalid/);
    expect(bodies).toEqual([]);
  });
  test("the planner falls back locally, and understand reports nothing attempted (null)", async () => {
    setGate(async () => { throw new Error("ECONNREFUSED"); });
    const bodies = record();
    const db = openDb(":memory:"); seed(db);
    expect((await makeHandleOther()(db, "what changed since august", ctx)).text).toMatch(/didn't answer/);
    expect(await understand(db, "I also have around 10k in my robinhood", [], ctx)).toBeNull();
    expect(bodies).toEqual([]);
  });
  test("parseGate is strict; label families", () => {
    expect(() => parseGate({ entities: "nope" })).toThrow();
    expect(() => parseGate({ entities: [{ text: "a", label: "PERSON", score: "high", start: 0, end: 1 }] })).toThrow();
    expect(parseGate({ entities: [], ms: 3 })).toEqual([]);
    expect([familyOf("PER"), familyOf("B-STREET"), familyOf("CREDITCARDNUMBER"), familyOf("DATE"), familyOf("SOMETHING_ELSE")])
      .toEqual([["person", "PERSON"], ["gate_addr", "ADDR"], ["gate_account", "ACCOUNT"], null, ["gate_private", "PRIVATE"]]);
  });
});

describe("gate timeout", () => {
  test("PRIVACY_GATE_TIMEOUT_MS, default 5 s; nonsense falls back to the default", () => {
    const prev = process.env.PRIVACY_GATE_TIMEOUT_MS;
    try {
      delete process.env.PRIVACY_GATE_TIMEOUT_MS; expect(gateTimeoutMs()).toBe(5000);
      process.env.PRIVACY_GATE_TIMEOUT_MS = "7000"; expect(gateTimeoutMs()).toBe(7000);
      process.env.PRIVACY_GATE_TIMEOUT_MS = "soon"; expect(gateTimeoutMs()).toBe(5000);
      process.env.PRIVACY_GATE_TIMEOUT_MS = "-1"; expect(gateTimeoutMs()).toBe(5000);
    } finally { if (prev === undefined) delete process.env.PRIVACY_GATE_TIMEOUT_MS; else process.env.PRIVACY_GATE_TIMEOUT_MS = prev; }
  });
  test("a slow service is cut off at the timeout and nothing is sent (fail closed)", async () => {
    const env = { ...process.env }, realFetch = globalThis.fetch;
    Object.assign(process.env, { LAYA_GATE_KEY: "k", PRIVACY_GATE_TIMEOUT_MS: "50" });
    // A /detect that never answers: only the abort signal can end it.
    globalThis.fetch = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("The operation timed out."))))) as unknown as typeof fetch;
    setGate(layaGate);
    try {
      const bodies = record();
      const t0 = performance.now();
      const r = await egress(openDb(":memory:"), { messages: [{ role: "user", content: "hello" }] });
      expect(r).toMatchObject({ ok: false, sent: false });
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(bodies).toEqual([]);
    } finally { globalThis.fetch = realFetch; process.env = env; }
  });
});

