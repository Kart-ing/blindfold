// "My rent is the money I send my friend Priya every month": a categorization preference, all local. That person's
// outgoing transfers become RENT_AND_UTILITIES (the Zelle rule usually has them there already), and the reply says
// what that is a month. Changed rows are kept on the memory, so forgetting it puts their categories back.
import type { Database } from "bun:sqlite";
import { ptMonthStart } from "../handlers/finance.ts";
import { localParts } from "../imessage/clock.ts";
import { kUsd } from "../handlers/runway.ts";

const RENT = "RENT_AND_UTILITIES";
const RELATION = String.raw`(?:my\s+)?(?:friend|roommate|room mate|flatmate|landlord|landlady|partner|sister|brother|mom|dad|cousin)?\s*`;

/** The person named next to rent/bills ("…the money I send my friend Priya", "I pay Priya rent"), or null. */
export function rentPayee(text: string): string | null {
  if (!/\b(?:rent|bills?|utilities)\b/i.test(text)) return null;
  const m = text.match(new RegExp(String.raw`\b(?:send|sent|pay|paid|give|gave|transfer|transferred|zelle|venmo)\s+(?:to\s+)?` + RELATION + String.raw`([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)`));
  return m ? m[1].trim() : null;
}

/** Applies the preference; returns the confirmation line, or null when the text isn't one or no transfers match. */
export function applyRentPreference(db: Database, text: string, now: number, memoryId?: number): string | null {
  const name = rentPayee(text);
  if (!name) return null;
  const rows = db.query(`SELECT id, ts, amount_cents AS c, category FROM transactions
      WHERE amount_cents > 0 AND LOWER(COALESCE(memo, '')) LIKE ? ORDER BY ts`).all(`%to ${name.toLowerCase()}%`) as
    { id: string; ts: number; c: number; category: string | null }[];
  if (!rows.length) return null;
  const changed = rows.filter((r) => r.category !== RENT).map((r) => ({ id: r.id, prev: r.category }));
  db.transaction(() => {
    for (const r of changed) db.run("UPDATE transactions SET category = ? WHERE id = ?", [RENT, r.id]);
    if (memoryId !== undefined && changed.length) db.run("UPDATE memories SET txn_ids = ? WHERE id = ?", [JSON.stringify(changed), memoryId]);
  })();
  // A month's worth: the last two full months when they have any, else the average over the months seen.
  const p = localParts(now);
  const start = ptMonthStart(p.y, p.m - 3), end = ptMonthStart(p.y, p.m - 1);
  const recent = rows.filter((r) => r.ts >= start && r.ts < end).reduce((a, r) => a + r.c, 0);
  const months = new Set(rows.map((r) => { const q = localParts(r.ts); return `${q.y}-${q.m}`; })).size;
  const monthly = recent ? recent / 2 : rows.reduce((a, r) => a + r.c, 0) / Math.max(months, 1);
  return `Got it: your transfers to ${name} (~${kUsd(Math.round(monthly))}/mo) are rent.`;
}

/** Forget: puts back categories this preference changed. Returns how many. */
export function revertRentPreference(db: Database, txnIds: string | null): number {
  let list: unknown;
  try { list = JSON.parse(txnIds ?? "null"); } catch { return 0; }
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const r of list) if (r && typeof r === "object" && "prev" in r) { db.run("UPDATE transactions SET category = ? WHERE id = ?", [(r as any).prev, (r as any).id]); n++; }
  return n;
}
