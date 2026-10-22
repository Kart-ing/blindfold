// Stage fallback: LLM_PROVIDER=fake. End to end through the real router: the reply says "[fake planner]", the row is
// tier cloud with a ledger entry, and the `ledger` line and panel data say nothing left the Mac.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { route } from "../src/imessage/router";
import { noFm } from "../src/imessage/fm";
import { egress, resetProvider, selectedBackend } from "../src/cloud/egress";
import { BLOCKED, FAKE_LABEL, makeHandleOther } from "../src/cloud/plan";
import { privacyLine, symbolsSentToday } from "../src/cloud/privacy";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000);
const ctx = { now: NOW };
// The planner path on its own: VOICE=plain, whatever .env (loaded by bun test) says, so Luna isn't asked first.
const env = { LLM_PROVIDER: process.env.LLM_PROVIDER, VOICE: process.env.VOICE };
const restoreEnv = (k: keyof typeof env) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; };
beforeAll(() => { process.env.LLM_PROVIDER = "fake"; process.env.VOICE = "plain"; resetProvider(); });
afterAll(() => { restoreEnv("LLM_PROVIDER"); restoreEnv("VOICE"); resetProvider(); });
const fixture = () => { const db = openDb(":memory:"); seed(db); return db; };
const lastRow = (db: ReturnType<typeof fixture>) =>
  db.query("SELECT tier, intent, question_sym, payload_json, canary_checked, canary_hits FROM ledger ORDER BY id DESC LIMIT 1").get() as
    { tier: string; intent: string; question_sym: string; payload_json: string; canary_checked: number; canary_hits: number };

describe("fake planner through the router", () => {
  test("U4: labelled reply, tier cloud, one ledger row marked provider fake", async () => {
    const db = fixture();
    const r = await route(db, "What changed since August?", ctx, { fm: noFm });
    expect(r.tier).toBe("cloud");
    expect(r.text).toMatch(/^\[fake planner\] Spending went from \$[\d,.]+ in August to \$[\d,.]+ in September/);
    const row = lastRow(db);
    expect(row).toMatchObject({ tier: "cloud", intent: "other", question_sym: "What changed since August?", canary_hits: 0 });
    expect(row.canary_checked).toBeGreaterThan(100);
    expect(JSON.parse(row.payload_json).provider).toBe("fake");
    expect((db.query("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n).toBe(1);
  });
  test("the ledger line and the panel data say nothing left the Mac", async () => {
    const db = fixture();
    await route(db, "What changed since August?", ctx, { fm: noFm });
    await route(db, "Which subscriptions am I paying for every month?", ctx, { fm: noFm });
    expect(privacyLine(db, NOW)).toBe("Cloud today: nothing left your Mac. 2 answered by the fake planner (demo mode: canned plans, nothing sent).");
    const st = symbolsSentToday(db, NOW);
    expect(st).toMatchObject({ calls: 0, fake: 2, symbols: [] }); // panel: st.calls === 0 → "Nothing has gone to the cloud today."
  });
  test("each demo question gets its own canned plan, all labelled", async () => {
    const db = fixture();
    const subs = await route(db, "Which subscriptions am I paying for every month?", ctx, { fm: noFm });
    expect(subs.text).toMatch(/^\[fake planner\] You pay these every month: .*Netflix/);
    const trip = await makeHandleOther()(db, "Is a $1,200 trip in December doable?", ctx);
    expect(trip.text).toMatch(/^\[fake planner\] (Yes, that trip fits\.|Not comfortably yet\.)\nAt this pace you'd have about \$[\d,.]+ in the bank by December, against \$1,200\.\nText "goal" to see your savings plan\.$/);
  });
  test("the canary still runs, and BLOCKED is not labelled (the planner was never consulted)", async () => {
    const r = await makeHandleOther()(fixture(), "how often do I go to willie mays plaza", ctx);
    expect(r.text).toBe(BLOCKED);
    expect(r.ledger!.canary_hits).toBeGreaterThan(0);
  });
  test("selected backend reports itself as fake", () => {
    expect(selectedBackend()).toMatchObject({ name: "fake" });
    expect(FAKE_LABEL).toBe("[fake planner]");
  });
});

describe("bun test never reaches a real provider", () => {
  test("bedrock with no FIN_TEST_NETWORK: the send is refused, nothing goes out", async () => {
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "bedrock";
    resetProvider();
    try {
      const res = await egress(fixture(), { messages: [{ role: "user", content: "hi" }] });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("network disabled under bun test");
    } finally { process.env.LLM_PROVIDER = prev; resetProvider(); }
  });
});
