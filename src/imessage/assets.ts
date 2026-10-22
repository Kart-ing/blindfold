// "I've got about 10k in Robinhood", read locally: instant, private, and independent of the privacy gate and Luna.
// Only statements about holding money in a named account; questions and goal statements go elsewhere.
import type { Database } from "bun:sqlite";
import { friendlyUsd, fill } from "../handlers/afford.ts";
import { goalStatus } from "../handlers/finance.ts";
import { addAsset } from "../memory/assets.ts";

// Named places (brands) first, most specific wins; generic words after. Merchant display names use brands only.
const BRANDS: [RegExp, string][] = [
  [/\brobin\s?hood\b/i, "Robinhood"], [/\bfidelity\b/i, "Fidelity"], [/\bvanguard\b/i, "Vanguard"], [/\bschwab\b/i, "Schwab"],
  [/\bcoinbase\b/i, "Coinbase"], [/\bwebull\b/i, "Webull"], [/\bwealthfront\b/i, "Wealthfront"], [/\bbetterment\b/i, "Betterment"],
  [/\be\*?trade\b/i, "E*Trade"], [/\bacorns\b/i, "Acorns"], [/\bsofi\b/i, "SoFi"], [/\bmarcus\b/i, "Marcus"],
];
const ACCOUNTS: [RegExp, string][] = [...BRANDS,
  [/\b401\s?\(?k\)?/i, "401(k)"], [/\broth\b/i, "Roth IRA"], [/\bira\b/i, "IRA"], [/\bhsa\b/i, "HSA"],
  [/\bcrypto\b/i, "Crypto"], [/\bbrokerage\b/i, "Brokerage"],
];
const AMOUNT = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k|thousand)?\b\s*\$?/gi;
const HOLDING = /\b(have|has|got|i'?ve|there'?s|holding|hold|sitting|counts|invested|in my|in the|worth)\b/i;
const NOT_A_STATEMENT = /\?|^\s*(how|what|why|when|where|which|who|can|could|should|did|do|does|is|are)\b|\b(spen[dt]|paid|pay|bought|buy|cost|goal|save|saving)\b/i;

const SYMBOL = /\b(?:MERCHANT|PERSON|ACCOUNT|ADDR|PRIVATE)_\d+\b/g;
// Statement noise around a merchant name ("ROBINHOOD SECURITIES CCB PAYMENT", "Withdrawal from ACME BROKERAGE").
const NOISE = /\b(ccb|ach|ppd|web|pos|debit|credit|card|payment|pmt|withdrawal|deposit|transfer|xfer|from|to|online|recurring|purchase|securities|llc|inc|corp|co|id|ref|des)\b|[#*]|\d{3,}/gi;
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** A short display form of a statement merchant: a known account name if one is in it, else the cleaned words. */
export function merchantDisplay(real: string): string {
  const known = BRANDS.find(([re]) => re.test(real));
  if (known) return known[1];
  const cleaned = real.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  return cleaned ? titleCase(cleaned).slice(0, 40) : "";
}

/**
 * The name to store for an outside balance: never a symbol. Uses Luna's name_real, else resolves each symbol through
 * the local symbols table (merchants get the short display form). Null when a symbol can't be resolved.
 */
export function assetDisplayName(db: Database, name: string, nameReal?: string | null): string | null {
  const real = (nameReal ?? "").trim();
  if (real && !SYMBOL.test(real)) { SYMBOL.lastIndex = 0; return merchantDisplay(real) || real.slice(0, 40); }
  SYMBOL.lastIndex = 0;
  let unresolved = false;
  const out = name.replace(SYMBOL, (sym) => {
    const row = db.query("SELECT real, kind FROM symbols WHERE symbol = ?").get(sym) as { real: string; kind: string } | null;
    if (!row) { unresolved = true; return sym; }
    return row.kind === "merchant" ? merchantDisplay(row.real) : row.real;
  }).replace(/\s+/g, " ").trim();
  if (unresolved || !out || /\b[A-Z]+_\d+\b/.test(out)) return null;
  return out.slice(0, 40);
}

export function parseAssetStatement(text: string): { name: string; cents: number } | null {
  if (NOT_A_STATEMENT.test(text) || !HOLDING.test(text)) return null;
  const acct = ACCOUNTS.map(([re, name]) => ({ name, m: re.exec(text) })).find((a) => a.m);
  if (!acct?.m) return null;
  const at = acct.m.index + acct.m[0].length / 2;
  let best: { cents: number; dist: number } | null = null;
  for (const m of text.matchAll(AMOUNT)) {
    if (/^401/.test(m[1]) && /k/i.test(m[3] ?? "") && acct.name === "401(k)") continue; // "401k" is the account, not an amount
    const v = (Number(m[1].replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0)) * (m[3] ? 1000 : 1);
    if (!(v >= 1)) continue;
    const dist = Math.abs((m.index ?? 0) + m[0].length / 2 - at);
    if (!best || dist < best.dist) best = { cents: Math.round(v * 100), dist };
  }
  return best ? { name: acct.name, cents: best.cents } : null;
}

/** Handles a balance statement locally: records it and answers with the goal status. Null if it isn't one. */
export function assetStatement(db: Database, text: string, now: number): string | null {
  const a = parseAssetStatement(text);
  if (!a) return null;
  const { replaced } = addAsset(db, a.name, a.cents, now);
  const head = `${replaced ? "Updated" : "Noted"}: about ${friendlyUsd(a.cents)} in ${a.name}, counted toward your goal.`;
  const s = goalStatus(db, now);
  if (!s) return `${head}\nSet a goal and I'll track it, e.g. "goal 40000 by december".`;
  const assets = (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM manual_assets").get() as { v: number }).v;
  try {
    const { goalStatusReply } = require("../handlers/goal_status.ts");
    const g = goalStatusReply(s, now, assets);
    return `${head}\n${fill(g.fallback, g.facts)}`;
  } catch {
    return head;
  }
}
