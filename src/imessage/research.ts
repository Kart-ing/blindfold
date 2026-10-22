// "Is this $400 Arc'teryx jacket worth it?": eng3's research() reads the web's reviews (cloud, through egress; it
// never sees the price), and the money verdict is always local. One reply: what reviews say, then money-wise.
// If research fails or runs past the cap, the reply is the local verdict and one line saying reviews weren't read.
import type { Database } from "bun:sqlite";
import type { Ctx, Reply } from "../handlers/types.ts";
import { affordReply } from "../handlers/afford.ts";
import { affordability, deliveryAvgCents, parseAmountCents, parseLifetimeYears } from "../handlers/finance.ts";
import { fill } from "../voice/phrase.ts";
import { askConsent } from "./consent.ts";

export type ResearchFn = (db: Database, text: string, ctx: Ctx) => Promise<Reply>;
type ConsentFn = typeof askConsent;
export const RESEARCH_DOWN = "I couldn't look up reviews right now.";

/** Same cues as eng3's fake: reviews, worth it, what's a good …, recommend. */
export const isResearchQuestion = (t: string) =>
  /\b(?:reviews?|ratings?|worth it|worth the (?:money|price)|what'?s a good|recommend(?:ation)?s?)\b/i.test(t.replace(/[‘’]/g, "'"));

let override: ((askConsent: ConsentFn) => ResearchFn | null) | undefined;
/** Tests: build the research function from the (pausing) consent function; null = unavailable. */
export const setResearch = (f: typeof override) => { override = f; };
async function load(ask: ConsentFn): Promise<ResearchFn | null> {
  if (override !== undefined) return override(ask);
  try {
    const m: any = await import("../cloud/research.ts");
    return typeof m.makeResearch === "function" ? m.makeResearch({ askConsent: ask }) : typeof m.research === "function" ? m.research : null;
  } catch { return null; }
}

/** The local afford verdict for a price in the text, as plain text (no wording call: research is slow enough). */
export function affordVerdict(db: Database, text: string, now: number): string | null {
  const price = parseAmountCents(text);
  const a = price === null ? null : affordability(db, price, now);
  if (!a) return null;
  const { facts, fallback } = affordReply(a, deliveryAvgCents(db, now), parseLifetimeYears(text), now);
  return fill(fallback, facts);
}

export async function researchReply(db: Database, text: string, ctx: Ctx): Promise<Reply> {
  const verdict = affordVerdict(db, text, ctx.now);
  const down = (tier: Reply["tier"], ledger?: Reply["ledger"]): Reply =>
    ({ text: verdict ? `${verdict}\n${RESEARCH_DOWN}` : RESEARCH_DOWN, tier, ...(ledger ? { ledger } : {}) });
  // The cap counts lookup time only: while research waits for a consent answer, the clock stops.
  let waiting = false;
  const pausing: ConsentFn = async (...a) => { waiting = true; try { return await askConsent(...a); } finally { waiting = false; } };
  const fn = await load(pausing);
  if (!fn) return down("local");
  const cap = Number(process.env.RESEARCH_REPLY_MS ?? 8000);
  let timer: ReturnType<typeof setInterval> | undefined;
  const timedOut = new Promise<"timeout">((res) => {
    let used = 0;
    timer = setInterval(() => { if (!waiting) used += 50; if (used >= cap) res("timeout"); }, 50);
  });
  const r = await Promise.race([fn(db, text, ctx).catch(() => null), timedOut]).finally(() => clearInterval(timer));
  // A timed-out lookup may already have sent its query: say so in the ledger rather than claim nothing left.
  if (r === "timeout") return down("cloud", { payload_json: JSON.stringify({ research: "timed out; the query may have been sent" }) });
  if (!r?.text) return down("local");
  return { ...r, text: verdict ? `${r.text}\n\nMoney-wise: ${verdict}` : r.text };
}
