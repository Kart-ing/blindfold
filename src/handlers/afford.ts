import type { Handler } from "./types";
import { affordability, deliveryAvgCents, monthYear, parseAmountCents, parseLifetimeYears, usd, type Afford } from "./finance";

type Phrase = (kind: string, situation: string, facts: Record<string, string>, fallback: string,
  opts?: { required?: string[]; timeoutMs?: number }) => Promise<{ text: string; voiced: boolean }>;

/**
 * eng-2's on-device phrasing (src/voice/phrase.ts) runs only under VOICE=device. Under VOICE=cloud the router's Luna
 * layer words the reply from these same facts, and under VOICE=plain the fallback is filled locally.
 */
async function loadPhrase(): Promise<Phrase | null> {
  if (process.env.VOICE !== "device") return null;
  try { return (await import("../voice/phrase.ts")).phrase ?? null; } catch { return null; }
}

/** Texting-style money: "$40", "$155", "$1,200", "$10k"; cents only under $10. */
export function friendlyUsd(c: number): string {
  const d = Math.abs(c) / 100, sign = c < 0 ? "-" : "";
  if (d >= 10_000 && d % 1000 === 0) return `${sign}$${d / 1000}k`;
  if (d < 10) return `${sign}${usd(Math.abs(c))}`;
  return `${sign}$${Math.round(d).toLocaleString("en-US")}`;
}
/** "June" when it's within a year of now, else "June 2028". */
export function friendlyMonth(ts: number, now: number): string {
  const month = new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", timeZone: "America/Los_Angeles" });
  return ts - now < 330 * 86_400 ? month : `${month} ${new Date(ts * 1000).toLocaleDateString("en-US", { year: "numeric", timeZone: "America/Los_Angeles" })}`;
}

export const fill = (t: string, facts: Record<string, string>) => t.replace(/\{([A-Z_]+)\}/g, (m, k: string) => facts[k] ?? m);

const SKIP_MAX = 24; // ~3 a month until a typical goal date; beyond that it isn't a realistic suggestion

/**
 * Everything the reply says, decided here from computed numbers: the verdict, why, and up to two options
 * (a price ceiling that keeps the goal on track; delivery dinners that would cover the shortfall).
 * The phrasing model only sees placeholder names and the number-free `situation`.
 */
export function affordReply(a: Afford, deliveryAvg: number | null, lifetimeYears: number | null = null, now = Math.floor(Date.now() / 1000)) {
  const behind = a.paceGap < 0;
  const onTime = a.newGoalTs !== null && monthYear(a.newGoalTs) === monthYear(a.goal.deadline) || a.newGoalTs !== null && a.newGoalTs <= a.goal.deadline;
  const facts: Record<string, string> = {
    PRICE: friendlyUsd(a.price),
    GAP: friendlyUsd(Math.abs(a.paceGap)),
    TARGET: friendlyUsd(a.goal.target_cents),
    GOAL_DATE: friendlyMonth(a.goal.deadline, now),
  };
  if (a.newGoalTs !== null) facts.NEW_GOAL_DATE = friendlyMonth(a.newGoalTs, now);

  const lead = { OK: "Yes, go for it.", TIGHT: "Tight, but doable.", NO: "I'd hold off for now." }[a.verdict];
  // A goal set moments ago (or one that's exactly on track) has no real gap: say "on pace", not "$0 ahead".
  const onPace = Math.abs(a.paceGap) < 500;
  const where = onPace ? "You're right on pace for your {TARGET} {GOAL_DATE} goal"
    : `You're {GAP} ${behind ? "behind" : "ahead"} on your {TARGET} {GOAL_DATE} goal`;
  const pace = a.newGoalTs === null ? `${where}, and at this pace the {PRICE} would put it out of reach.`
    : onTime ? `${where}, and you'd still hit it on time with the {PRICE} buy.`
    : `${where}, and the {PRICE} would push it to {NEW_GOAL_DATE}.`;
  const effect = "";

  const options: string[] = [];
  const optionKinds: string[] = [];
  if (a.verdict !== "OK") {
    const ceiling = Math.floor((a.projected - a.goal.target_cents) / 1000) * 1000; // headroom, rounded down to $10
    if (ceiling >= 2000 && ceiling < a.price) {
      facts.CEILING = friendlyUsd(ceiling);
      options.push("• Anything under {CEILING} keeps you on track");
      optionKinds.push("price_ceiling");
    }
    const shortfall = a.goal.target_cents - a.afterPurchase;
    if (deliveryAvg && shortfall > 0) {
      const n = Math.ceil(shortfall / deliveryAvg);
      if (n <= SKIP_MAX) {
        facts.SKIP_N = String(n);
        facts.SKIP_COST = friendlyUsd(n * deliveryAvg);
        options.push(`• ${options.length ? "Or s" : "S"}kip {SKIP_N} delivery dinner${n === 1 ? "" : "s"} before {GOAL_DATE} (~{SKIP_COST}) and it's covered`);
        optionKinds.push("skip_deliveries");
      }
    }
  }

  // The user's own framing: "it would last me 20 years" → cost per year, said once, without changing the verdict.
  let perYear = "";
  if (lifetimeYears) {
    facts.PER_YEAR = friendlyUsd(Math.round(a.price / lifetimeYears));
    facts.YEARS = String(lifetimeYears);
    perYear = " If it really lasts {YEARS} years, that's only ~{PER_YEAR} a year.";
  }
  const lines = [lead, `${pace}${effect}${perYear}`];
  if (options.length) lines.push("", "If you still want it:", ...options);
  lines.push("", 'Want the full plan? Text "goal".');
  const fallback = lines.join("\n");

  const situation = [
    `verdict ${a.verdict.toLowerCase()}`,
    onPace ? "on savings pace" : `${behind ? "behind" : "ahead of"} savings pace`,
    a.newGoalTs === null ? "buying it makes the goal unreachable at this pace" : onTime ? "buying it keeps the goal date" : "buying it delays the goal date",
    optionKinds.length ? `options to offer: ${optionKinds.join(", ")}` : "no cheaper option fits",
    ...(lifetimeYears ? ["the user says it will last for years; acknowledge the cost per year once"] : []),
    'close by offering the full plan (text "goal")',
  ].join("; ");
  // Required = exactly the placeholders the fallback uses (an unused fact, e.g. NEW_GOAL_DATE when the date holds, isn't forced).
  const required = [...new Set([...fallback.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]))];
  for (const k of Object.keys(facts)) if (!required.includes(k)) delete facts[k];
  return { facts, fallback, situation, required };
}

export const handle: Handler = async (db, text, ctx) => {
  const price = parseAmountCents(text);
  if (price === null) return { text: "How much is it? e.g. \"can I buy a $400 jacket\"", tier: "local" };
  const a = affordability(db, price, ctx.now);
  if (!a) return { text: "Set a savings goal first, e.g. \"goal 10000 by june\".", tier: "local" };

  const r = affordReply(a, deliveryAvgCents(db, ctx.now), parseLifetimeYears(text), ctx.now);
  const phrase = await loadPhrase();
  if (phrase) {
    const out = await phrase("afford", r.situation, r.facts, r.fallback, { required: r.required, timeoutMs: 6000 }).catch(() => null);
    if (out) return { text: out.text, tier: out.voiced ? "on-device" : "local" };
  }
  return { text: fill(r.fallback, r.facts), tier: "local" };
};
