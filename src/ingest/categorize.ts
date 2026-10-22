// Statement lines → merchant + Plaid PFC primary category (tasks/statements.md). Rules first, then (LOCAL_MODELS=on only) the on-device model
// (bin/fm) for whatever is left, cached by description so reruns are instant. Generic patterns only: no real data here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localModelsOn } from "../imessage/fm";

export const CATEGORIES = [
  "INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "BANK_FEES", "ENTERTAINMENT", "FOOD_AND_DRINK", "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT", "MEDICAL", "PERSONAL_CARE", "GENERAL_SERVICES", "GOVERNMENT_AND_NON_PROFIT", "TRANSPORTATION", "TRAVEL",
  "RENT_AND_UTILITIES",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Categorized = { merchant: string; category: Category | null; via: "rule" | "hint" | "fm" | "none"; wallet: string | null };

const CARD_PAYMENT = /citi card online payment|capital one (mobile )?pmt|crcardpmt|ccb payment|autopay|payment[ -]+thank you|online payment|card payment/i;
const TRANSFER_360 = /\b360\b.*(checking|savings)|(transfer|deposit|withdrawal) (to|from) .*(checking|savings)|internal transfer/i;
const PAYROLL = /payroll|direct dep|dir dep|salary|\bgusto\b|\badp\b|paychex|workday/i;
const INTEREST_IN = /interest (paid|earned|credit)|monthly interest/i;
const FEE = /\bfee\b|interest charge|finance charge/i;

/** [pattern, merchant (null = cleaned description), category] — first match wins. */
const MERCHANTS: [RegExp, string | null, Category][] = [
  [/uber\s*\*?\s*eats|ubereats/i, "Uber Eats", "FOOD_AND_DRINK"],
  [/uber\s*\*?\s*one\b/i, "Uber One", "GENERAL_SERVICES"],
  [/\buber\b/i, "Uber", "TRANSPORTATION"],
  [/\blyft\b/i, "Lyft", "TRANSPORTATION"],
  [/doordash/i, "DoorDash", "FOOD_AND_DRINK"],
  [/grubhub|caviar|postmates|seamless/i, null, "FOOD_AND_DRINK"],
  [/safeway|trader joe|whole foods|kroger|instacart|sprouts|grocery|market\b/i, null, "FOOD_AND_DRINK"],
  [/starbucks|coffee|cafe|restaurant|pizza|burger|taco|sushi|kitchen|grill|bar\b/i, null, "FOOD_AND_DRINK"],
  [/netflix|spotify|hulu|disney|youtube|hbo|max\.com|apple\.com\/bill|steam|playstation|cinema|theater|ticketmaster/i, null, "ENTERTAINMENT"],
  [/amazon|amzn|target|walmart|costco|best buy|ikea|ebay|etsy/i, null, "GENERAL_MERCHANDISE"],
  [/shell|chevron|exxon|arco|\b76\b|valero|clipper|bart\b|caltrain|\bmuni\b|parking|toll/i, null, "TRANSPORTATION"],
  [/pg&e|pge\b|comcast|xfinity|verizon|at&t|att\*|t-mobile|tmobile|electric|water bill|internet/i, null, "RENT_AND_UTILITIES"],
  [/\brent\b|apartments|property mgmt|leasing/i, null, "RENT_AND_UTILITIES"],
  [/airline|airlines|delta|united|alaska air|southwest|jetblue|hotel|airbnb|marriott|hilton|expedia/i, null, "TRAVEL"],
  [/pharmacy|cvs|walgreens|clinic|medical|dental|hospital/i, null, "MEDICAL"],
  [/gym|fitness|salon|barber|spa\b/i, null, "PERSONAL_CARE"],
];
/** Capital One's CSV Category column → PFC primary. */
const HINTS: Record<string, Category> = {
  dining: "FOOD_AND_DRINK", grocery: "FOOD_AND_DRINK", merchandise: "GENERAL_MERCHANDISE", "gas/automotive": "TRANSPORTATION",
  "other travel": "TRAVEL", airfare: "TRAVEL", lodging: "TRAVEL", "car rental": "TRAVEL", entertainment: "ENTERTAINMENT",
  "health care": "MEDICAL", "phone/cable": "RENT_AND_UTILITIES", utilities: "RENT_AND_UTILITIES", "professional services": "GENERAL_SERVICES",
  "other services": "GENERAL_SERVICES", insurance: "GENERAL_SERVICES", "fee/interest charge": "BANK_FEES", "payment/credit": "LOAN_PAYMENTS",
};

/** "SQ *BLUE BOTTLE #123 SAN FRANCISCO CA" → "Blue Bottle". */
export function cleanMerchant(desc: string): string {
  const s = desc.replace(/^(aplpay|apple pay)\s+/i, "").replace(/^(withdrawal|deposit|debit card purchase|purchase|pos|ach)\s+((from|to|at)\s+)?/i, "").replace(/^(sq|tst|py|sp|paypal|pp|dd|ic|in|bt)\s*\*\s*/i, "")
    .replace(/#\s*\d+.*$/, "").replace(/\*\s*\d[\w-]*.*$/, "").replace(/\s+\d[\d\s-]*.*$/, "").replace(/\s+[A-Z][a-z]+\s+[A-Z]{2}$/, "").replace(/\s+[A-Z]{2}$/, "")
    .replace(/[*_]+/g, " ").replace(/\s+/g, " ").trim();
  const words = (s || desc).split(" ").slice(0, 3);
  return words.map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

const cardIssuer = (desc: string) =>
  /citi/i.test(desc) ? "Citi" : /capital one|capone|crcardpmt/i.test(desc) ? "Capital One" : /chase/i.test(desc) ? "Chase"
    : /amex|american express/i.test(desc) ? "Amex" : /discover/i.test(desc) ? "Discover" : null;

const NAME_END = /^(on|for|conf|ref|id|memo|via)$/i;
const NOT_A_NAME = /^(bank|account|checking|savings|card|debit|credit|wallet|balance|my|your|the)$/i;
/**
 * "Zelle money sent to JANE Q DOE" → "Zelle to Jane Q Doe". The merchant is only "Zelle", so the person goes in the memo,
 * where knownPeople() finds them: every part of the name is then symbolized and canaried. Null when the line names no one.
 * PayPal card lines name merchants (they stay merchants).
 */
export function p2pMemo(desc: string): string | null {
  const app = /\b(zelle|venmo)\b/i.exec(desc)?.[1];
  const m = app ? /\b(to|from)\s+(.+)$/i.exec(desc) : null;
  if (!app || !m) return null;
  const words: string[] = [];
  for (const raw of m[2].trim().split(/\s+/)) {
    const w = raw.replace(/,$/, "");
    if (words.length === 5 || NAME_END.test(w) || !/^[A-Za-z][A-Za-z'.-]*$/.test(w)) break;
    words.push(w[0].toUpperCase() + w.slice(1).toLowerCase());
  }
  if (!words.length || NOT_A_NAME.test(words[0])) return null;
  return `${app[0].toUpperCase()}${app.slice(1).toLowerCase()} ${m[1].toLowerCase()} ${words.join(" ")}`;
}

/** Rules only (synchronous). outflow: amount_cents > 0. */
export function categorizeByRule(desc: string, outflow: boolean, hint: string | null): Categorized {
  const wallet = /^(aplpay|apple pay)\b/i.test(desc) ? "apple_pay" : null;
  // The bank's own text as the merchant, never a generic label ("Transfer", "Card payment"): the leak canary treats every
  // merchant as sensitive, and generic words also occur in the planner's static prompt.
  // "<issuer> card payment": finance.ts only treats a checking-side LOAN_PAYMENTS row as a card payment (not spending) when the
  // merchant reads like one.
  if (CARD_PAYMENT.test(desc)) return { merchant: `${cardIssuer(desc) ?? cleanMerchant(desc)} card payment`, category: "LOAN_PAYMENTS", via: "rule", wallet };
  if (TRANSFER_360.test(desc)) return { merchant: cleanMerchant(desc), category: outflow ? "TRANSFER_OUT" : "TRANSFER_IN", via: "rule", wallet };
  if (!outflow && PAYROLL.test(desc)) return { merchant: cleanMerchant(desc), category: "INCOME", via: "rule", wallet };
  // The owner pays rent and bills by Zelle, so Zelle out is spending; Zelle in stays a transfer.
  if (/zelle/i.test(desc)) return { merchant: "Zelle", category: outflow ? "RENT_AND_UTILITIES" : "TRANSFER_IN", via: "rule", wallet };
  if (!outflow && INTEREST_IN.test(desc)) return { merchant: cleanMerchant(desc), category: "INCOME", via: "rule", wallet };
  if (outflow && FEE.test(desc)) return { merchant: cleanMerchant(desc), category: "BANK_FEES", via: "rule", wallet };
  for (const [re, merchant, category] of MERCHANTS) if (re.test(desc)) return { merchant: merchant ?? cleanMerchant(desc), category, via: "rule", wallet };
  const h = hint ? HINTS[hint.trim().toLowerCase()] : undefined;
  if (h) return { merchant: cleanMerchant(desc), category: h, via: "hint", wallet };
  return { merchant: cleanMerchant(desc), category: null, via: "none", wallet };
}

const FM_BIN_DEFAULT = join(import.meta.dir, "..", "..", "bin", "fm");
/** One bin/fm call. null unless LOCAL_MODELS=on (no local models by default), and on any failure. */
async function fmCategory(desc: string, timeoutMs: number): Promise<Category | null> {
  if (!localModelsOn()) return null;
  try {
    const proc = Bun.spawn([process.env.FM_BIN ?? FM_BIN_DEFAULT, "extract"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write(JSON.stringify({ prompt: `Which spending category is this bank or card transaction?\n${desc}`,
      schema: { type: "object", properties: { category: { type: "string", enum: [...CATEGORIES] } }, required: ["category"] } }));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    const c = JSON.parse(out)?.json?.category;
    return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : null;
  } catch { return null; }
}

/**
 * Rules for every line, then, only with LOCAL_MODELS=on, bin/fm (one at a time, 3s each) for the uncategorised outflows,
 * cached by description in `cachePath` (under data/, gitignored). By default (no local models) only the rules and earlier
 * cached answers apply, and the cache isn't written. Returns one result per input, in order.
 */
export async function categorizeAll(lines: { desc: string; outflow: boolean; hint: string | null }[], cachePath: string,
  opts: { useFm?: boolean; concurrency?: number; timeoutMs?: number } = {}): Promise<Categorized[]> {
  const cache: Record<string, Category | null> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const out = lines.map((l) => categorizeByRule(l.desc, l.outflow, l.hint));
  const todo = [...new Set(lines.filter((l, i) => out[i].category === null && l.outflow).map((l) => l.desc))].filter((d) => !(d in cache));
  if (opts.useFm !== false && localModelsOn() && todo.length) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 1, todo.length) }, async () => { // one worker: shared on-device model
      while (next < todo.length) { const d = todo[next++]; cache[d] = await fmCategory(d, opts.timeoutMs ?? 3000); }
    }));
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  return out.map((c, i) => (c.category === null && cache[lines[i].desc] ? { ...c, category: cache[lines[i].desc]!, via: "fm" } : c));
}
