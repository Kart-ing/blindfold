// The fake planner's canned plans (LLM_PROVIDER=fake on stage, and live-cloud-check --dry). Chosen from the SYMBOLIZED
// question only, like a real planner, and never sent anywhere. plan.ts labels every fake reply "[fake planner]".

export const TRIP_PLAN = {
  steps: [
    { id: "s1", op: "balance", filter: { account_type: "depository" } },
    { id: "s2", op: "avg_monthly", filter: { months: 3 } },
    { id: "s3", op: "avg_monthly", filter: { months: 3, direction: "inflow" } },
    { id: "s4", op: "diff", inputs: ["s3", "s2"] },
    { id: "s5", op: "project", inputs: ["s1", "s4"], months: 2 },
    { id: "s6", op: "compare", inputs: ["s5", "Q_AMT_1"] },
  ],
  answer_template: "{s6:Yes, that trip fits.|Not comfortably yet.}\nAt this pace you'd have about {s5} in the bank by December, against {Q_AMT_1}.\nText \"goal\" to see your savings plan.",
  disclose: [],
};

export const SUBSCRIPTIONS_PLAN = { steps: [{ id: "s1", op: "recurring" }], answer_template: "You pay these every month: {s1}.\nWorth a look: any you haven't used lately.", disclose: [] };

/** golden: SYSTEM_PROMPT's worked example ("what changed since August"), the default. */
export function fakePlanFor(questionSym: string, golden: object): object {
  if (/subscri|recurring|every month/i.test(questionSym)) return SUBSCRIPTIONS_PLAN;
  if (/\bQ_AMT_1\b/.test(questionSym) && /afford|trip|buy|enough/i.test(questionSym)) return TRIP_PLAN;
  return golden;
}
