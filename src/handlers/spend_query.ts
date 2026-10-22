// "How much did I spend on food last month?" / "top 3 merchants in September". On-device only: fm extraction (keyword
// fallback) → a one- or two-step plan in the cloud DSL → validatePlan → executePlan → a local reply. Nothing leaves the Mac.
import type { Database } from "bun:sqlite";
import type { Ctx, Handler, Reply } from "./types.ts";
import { fm as defaultFm, type Fm } from "../imessage/fm.ts";
import { localParts } from "../imessage/clock.ts";
import { CATEGORIES, executePlan, validatePlan, type Step } from "../cloud/dsl.ts";
import { fillTemplate } from "../cloud/plan.ts";
import { usd } from "./finance.ts";
import { realFor, symbolizeText } from "../cloud/symbolize.ts";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const KEYWORDS: [RegExp, string][] = [
  [/\b(food|eat(ing)?|restaurants?|dinner|lunch|breakfast|coffee|groceries|grocery|takeout|delivery|drinks?)\b/, "FOOD_AND_DRINK"],
  [/\b(rides?|uber|lyft|transport(ation)?|commut(e|ing)|gas|taxi|transit)\b/, "TRANSPORTATION"],
  [/\b(shopping|clothes|clothing|merchandise|stuff)\b/, "GENERAL_MERCHANDISE"],
  [/\b(rent|utilities|electric(ity)?|internet|phone bill)\b/, "RENT_AND_UTILITIES"],
  [/\b(entertainment|movies?|streaming|subscriptions?|concerts?)\b/, "ENTERTAINMENT"],
  [/\b(health|medical|doctor|pharmacy)\b/, "MEDICAL"],
  [/\b(beauty|personal care|gym|fitness|haircut)\b/, "PERSONAL_CARE"],
  [/\b(travel|flights?|hotels?|trips?)\b/, "TRAVEL"],
  [/\b(home improvement|furniture)\b/, "HOME_IMPROVEMENT"],
];

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["total", "top_merchants"], description: "total: how much was spent. top_merchants: where the most was spent." },
    category: { type: "string", enum: ["any", ...CATEGORIES.map((c) => c.toLowerCase())] },
    period: { type: "string", description: "this_month, last_month, or a month name like september" },
    n: { type: "integer", description: "how many merchants, default 3" },
  },
  required: ["kind", "category", "period"],
};

type Query = { kind: "total" | "top_merchants"; category: string | null; month: number; n: number; merchant: string | null };

const NON_SPEND = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);

/** k for M-k when the text names a period ("last month" = the previous complete PT month, "this month", "September",
 *  "2026-09"); null when it names none. */
export function periodFromText(text: string, now: number): number | null {
  const p = text.toLowerCase();
  if (/\b(last|previous|prior)[\s_]+month\b/.test(p)) return 1;
  if (/\bthis[\s_]+month\b/.test(p)) return 0;
  const ym = /\b(20\d\d)-(\d{2})\b/.exec(p); // the model sometimes answers "2026-09"
  if (ym) { const lp = localParts(now); const k = lp.y * 12 + lp.m - 1 - (Number(ym[1]) * 12 + Number(ym[2]) - 1); return k >= 0 && k <= 12 ? k : null; }
  // "may" only after in/during/for, so "may I" isn't May.
  const i = MONTHS.findIndex((m) => m === "may" ? /\b(in|during|for|since) may\b/.test(p) : new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(p));
  return i < 0 ? null : ((localParts(now).m - 1 - i) + 12) % 12; // most recent occurrence of that month
}
/** k for M-k: months back from now (local time). Unknown → this month. */
const monthsBack = (period: string, now: number): number => periodFromText(period, now) ?? 0;

export function keywordQuery(text: string, now: number): Query {
  const t = text.toLowerCase();
  const n = Number(t.match(/\btop\s+(\d{1,2})\b/)?.[1] ?? 3);
  return {
    kind: /\btop\b|\bmost\b|\bwhere\b|\bmerchants?\b/.test(t) ? "top_merchants" : "total",
    category: KEYWORDS.find(([re]) => re.test(t))?.[1] ?? null,
    month: monthsBack(t, now), n: Math.min(Math.max(n, 1), 10), merchant: null,
  };
}

async function extract(fm: Fm, text: string, now: number): Promise<Query> {
  const fallback = keywordQuery(text, now);
  const out = await fm.extract(`Extract the spending question from this text message: ${JSON.stringify(text)}`, SCHEMA);
  if (!out) return fallback;
  const cat = typeof out.category === "string" ? out.category.toUpperCase() : "";
  return {
    kind: out.kind === "top_merchants" ? "top_merchants" : "total",
    // The words in the text win over the model: a keyword category, else the model's only if it's a spending category
    // (it answered "income" for "how much did I spend last month"). No category = all my spending.
    category: fallback.category ?? (CATEGORIES.includes(cat) && !NON_SPEND.has(cat) ? cat : null),
    // A period named in the text wins too ("last month" is the previous complete month, whatever the model says).
    month: periodFromText(text, now) ?? (typeof out.period === "string" ? monthsBack(out.period, now) : fallback.month),
    n: Number.isInteger(out.n) && (out.n as number) >= 1 && (out.n as number) <= 10 ? (out.n as number) : fallback.n,
    merchant: null,
  };
}

const monthName = (k: number, now: number) => k === 0 ? "this month" : k === 1 ? "last month"
  : `in ${MONTHS[((localParts(now).m - 1 - k) % 12 + 12) % 12].replace(/^./, (c) => c.toUpperCase())}`;

export function makeHandle(fm: Fm = defaultFm): Handler {
  return async (db: Database, text: string, ctx: Ctx): Promise<Reply> => {
    const q = await extract(fm, text, ctx.now);
    // A merchant named in the question ("how much at Blue Bottle") narrows the sum. Symbolized locally only.
    q.merchant = symbolizeText(db, text).text.match(/\bMERCHANT_\d+\b/)?.[0] ?? null;
    const filter: Record<string, unknown> = { month: `M-${q.month}` };
    // A named merchant alone narrows the sum: "uber" is also a transportation keyword, but Uber Eats is food.
    if (q.category && !q.merchant) filter.category = q.category;
    if (q.merchant) filter.merchant_sym = q.merchant;
    const when = monthName(q.month, ctx.now);
    const what = q.merchant ? `at ${realFor(db, q.merchant)}` : q.category ? `on ${q.category.replace(/_/g, " ").toLowerCase()}` : "";
    const steps: Step[] = q.kind === "top_merchants" && !q.merchant
      ? [{ id: "s1", op: "group_by", by: "merchant_sym", filter } as Step, { id: "s2", op: "top_n", inputs: ["s1"], n: q.n }]
      : [{ id: "s1", op: "sum", filter } as Step];
    const template = q.kind === "top_merchants" && !q.merchant
      ? `Top ${q.n} ${what ? what.replace(/^on /, "") + " " : ""}merchants ${when}: {s2}.`.replace(/\s+/g, " ")
      : `You spent {s1} ${what} ${when} (your share).`.replace(/\s+/g, " ");
    const v = validatePlan({ steps, answer_template: template });
    if (!v.ok) return { text: "I couldn't work that one out. Try \"how much on food last month\".", tier: "on-device" };
    const r = executePlan(db, v.plan, ctx);
    const filled = fillTemplate(db, v.plan.answer_template, r, {}, usd); // a spend total to the cent
    if (q.kind === "top_merchants" && !q.merchant) {
      // "Top N" never promises more rows than there are.
      const rows = r.s2?.kind === "list" ? r.s2.v.length : 0;
      if (!rows) return { text: `No spending ${what} ${when}.`.replace(/\s+/g, " "), tier: "on-device" };
      const shown = Math.min(q.n, rows);
      return { text: filled.replace(/^Top \d+ /, `Top ${shown} `).replace(/ merchants /, shown === 1 ? " merchant " : " merchants "), tier: "on-device" };
    }
    return { text: filled, tier: "on-device" };
  };
}

export const handle: Handler = makeHandle();
