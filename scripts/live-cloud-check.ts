// Live smoke for the cloud beat: 3 demo questions through handleOther against the real planner (LLM_PROVIDER).
// Usage: bun run scripts/live-cloud-check.ts   (env keys per LLM_PROVIDER: REQUIRED_ENV in src/cloud/egress.ts;
//        e.g. bedrock: AWS_BEARER_TOKEN_BEDROCK, AWS_REGION, BEDROCK_MODEL_ID). Uses a fresh seeded fixture DB.
//        bun run scripts/live-cloud-check.ts --dry   (no network: canned plans, one per question; checks plumbing, not planner quality)
//        LLM_PROVIDER=fake: canned plans, nothing sent; every reply must carry "[fake planner]". Exits 3 when that holds.
// Prints, per question: symbolized question, canary result, validated plan, final local answer.
// Exit: 0 = live provider OK, 3 = fake planner OK (NOT live), 1 = any failure, 2 = keys missing (nothing sent).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_NOW, rebuild } from "../src/ingest/seed";
import { REQUIRED_ENV, activeBackend, lastEgressError, selectedBackend, setProvider } from "../src/cloud/egress";
import { validatePlan } from "../src/cloud/dsl";
import { BLOCKED, CANNED, FAKE_LABEL, SYSTEM_PROMPT, UNREACHABLE, extractJson, makeHandleOther } from "../src/cloud/plan";
import { SUBSCRIPTIONS_PLAN, TRIP_PLAN } from "../src/cloud/fake";

const QUESTIONS = [
  "What changed in my spending since August?",
  "Can I afford a $1,200 trip in December if I keep spending like the last three months?",
  "Which subscriptions am I paying for every month?",
];
// --dry only: what a good planner should return for each question (the same canned plans as LLM_PROVIDER=fake).
const CANNED_PLANS: object[] = [{} /* SYSTEM_PROMPT's worked example, below */, TRIP_PLAN, SUBSCRIPTIONS_PLAN];

const DRY = process.argv.includes("--dry");
const configured = selectedBackend();
const NEEDS: Record<string, string[]> = REQUIRED_ENV;
const missing = NEEDS[configured.name].filter((k) => !process.env[k]);
if (!DRY && missing.length) {
  console.error(`LLM_PROVIDER=${configured.name}: ${missing.join(", ")} not set (add to .env). Nothing was sent.`);
  process.exit(2);
}

const { db } = rebuild(join(mkdtempSync(join(tmpdir(), "live-cloud-")), "fin.db"));
// Wrap the real provider only to see what came back; egress still scans and sends exactly as in production.
let responses: unknown[] = [];
CANNED_PLANS[0] = JSON.parse(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.lastIndexOf('{"steps"')));
let current = 0;
// Same wire encoding as the configured provider; only the sender is wrapped (or faked in --dry).
const encoding = configured.name; // every backend name is also a wire encoding setProvider knows
const FAKE = configured.name === "fake" && !DRY;
const send = DRY ? async () => ({ content: [{ type: "text", text: "Here you go:\n```json\n" + JSON.stringify(CANNED_PLANS[current]) + "\n```" }] }) : configured.send;
if (DRY) console.log("DRY: plumbing only, the plans are canned (no network, says nothing about planner quality).");
setProvider(async (body) => { const r = await send(body); responses.push(r); return r; }, encoding);
console.log(`provider: ${configured.name}  model: ${configured.model}  wire: ${activeBackend().name}${DRY ? "  (DRY: nothing sent)" : ""}`);
if (FAKE) console.log("FAKE planner: NOT a live check. Nothing is sent; answers are canned and must say \"[fake planner]\".");
const handle = makeHandleOther({ askConsent: async () => "deny" }); // no phone in this check: any disclose gets a bucket

const text = (r: unknown) => ((r as any)?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
let failed = 0;
for (const [i, q] of QUESTIONS.entries()) {
  current = i;
  responses = [];
  const t0 = Date.now();
  const r = await handle(db, q, { now: DEMO_NOW });
  const providerError = lastEgressError();
  const plans = responses.map((x) => extractJson(text(x)));
  const valid = plans.map((p) => validatePlan(p));
  const last = valid.at(-1);
  const plain = r.text.startsWith(`${FAKE_LABEL} `) ? r.text.slice(FAKE_LABEL.length + 1) : r.text;
  const problems = [
    r.tier !== "cloud" && `tier ${r.tier}`,
    [BLOCKED, CANNED, UNREACHABLE].includes(plain) && `reply: ${r.text}`,
    FAKE && !r.text.startsWith(FAKE_LABEL) && "fake-planner reply is not labelled",
    (r.ledger?.canary_hits ?? 0) > 0 && `canary hits ${r.ledger!.canary_hits}`,
    !last?.ok && (providerError ? `provider error: ${providerError}` : `last plan invalid: ${last && !last.ok ? last.error : "no response"}`),
    /[{}]/.test(r.text) && "unfilled placeholder in reply",
  ].filter(Boolean);
  console.log(`\n━━ ${q}`);
  console.log(`  symbolized: ${r.ledger?.question_sym}`);
  console.log(`  canary:     ${r.ledger?.canary_hits ?? "?"} hits / ${r.ledger?.canary_checked ?? "?"} values checked; partial ${r.ledger?.partial_count ?? 0}, exact ${r.ledger?.exact_disclosed ?? 0}`);
  valid.forEach((v, i) => console.log(`  plan ${i + 1}:     ${v.ok ? JSON.stringify(v.plan) : `REJECTED (${v.error}): ${text(responses[i]).slice(0, 300)}`}`));
  console.log(`  answer:     ${r.text}`);
  console.log(`  ${problems.length ? "FAIL: " + problems.join("; ") : "OK"} (${Date.now() - t0} ms, ${responses.length} call${responses.length === 1 ? "" : "s"})`);
  if (problems.length) failed++;
}
console.log(`\n${QUESTIONS.length - failed}/${QUESTIONS.length} passed${DRY ? " (DRY: plumbing only, the plans are canned)" : FAKE ? " (FAKE planner: canned plans, nothing sent, NOT live)" : ""}`);
process.exit(failed ? 1 : FAKE ? 3 : 0);
