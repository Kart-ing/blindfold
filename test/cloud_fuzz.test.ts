// False positives cost as much as leaks on stage: ordinary questions with no real values must reach the planner
// intact (question_sym === question), not get blocked, refused, routed local, or canned.
import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";
import { setProvider } from "../src/cloud/egress";
import { BLOCKED, CANNED, HERS, makeHandleOther } from "../src/cloud/plan";
import { numberWords } from "../src/cloud/normalize";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000);
const db = openDb(":memory:");
seed(db);
const PLAN = { steps: [{ id: "s1", op: "sum", filter: { month: "M-1" } }], answer_template: "Last month: {s1}.", disclose: [] };
let calls = 0;
const prev = setProvider(async () => { calls++; return { content: [{ type: "text", text: JSON.stringify(PLAN) }] }; }, "openai");
afterAll(() => setProvider(prev));
const handle = makeHandleOther({ askConsent: async () => "deny" });

const ORDINARY = [
  "What changed in my spending since August?",
  "Am I spending more than last month?",
  "Which category grew the most this quarter?",
  "What's my biggest expense category?",
  "How does this month compare to September?",
  "Where could I cut back to save more?",
  "Is my spending trending up or down?",
  "What do I spend on eating out versus groceries?",
  "How much do my rides cost per week?",
  "Do I have any subscriptions I forgot about?",
  "What did I spend on entertainment over the past three months?",
  "Is my rent a big share of my income?",
  "How much did I save last month?",
  "What's my average monthly spending?",
  "Which week of the month do I spend the most?",
  "Are my utility bills going up?",
  "How much did coffee cost me in October?",
  "Will I hit my savings goal at this pace?",
  "What's my net worth right now?",
  "Should I worry about my credit card balance?",
  // Borderline: words that sit next to the merchant/address stoplists.
  "Is my phone plan too expensive?",
  "What's my total bill this month?",
  "Which was my best month for saving?",
  "How much does getting to work cost me?",
  "Do I spend more on weekends at home?",
];

describe("fuzz: ordinary demo questions go out intact", () => {
  for (const q of ORDINARY) {
    test(q, async () => {
      const before = calls;
      const r = await handle(db, q, { now: NOW });
      expect(r.tier).toBe("cloud");
      expect([BLOCKED, CANNED, HERS]).not.toContain(r.text);
      expect(r.ledger!.question_sym).toBe(numberWords(q)); // only change allowed: "three months" → "3 months"
      expect(r.ledger!.canary_hits).toBe(0);
      expect(calls - before).toBe(1);
    });
  }
});
