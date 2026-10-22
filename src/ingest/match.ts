import type { Database } from "bun:sqlite";
import type { Receipt, Transaction } from "./types";

export type MerchantFamily = "uber" | "lyft" | "uber_eats" | "doordash";
export function merchantFamily(merchant: string): MerchantFamily | null {
  if (/uber\s*[*_-]?\s*eats/i.test(merchant)) return "uber_eats";
  if (/door\s*dash/i.test(merchant)) return "doordash";
  if (/\blyft\b/i.test(merchant)) return "lyft";
  if (/\buber\b/i.test(merchant)) return "uber";
  return null;
}
export type ReceiptMatch = { txn_id: string; receipt_id: string; amount_delta_cents: number; time_delta_seconds: number; tip_adjusted: boolean };

/** Global closest-amount, then closest-time allocation; every receipt and every transaction is used once. */
export function findMatches(db: Database): ReceiptMatch[] {
  const transactions = db.query<Transaction, []>("SELECT * FROM transactions WHERE amount_cents > 0 ORDER BY ts, id").all();
  const receipts = db.query<Receipt, []>("SELECT * FROM receipts ORDER BY ts, id").all();
  const candidates: ReceiptMatch[] = [];
  for (const t of transactions) {
    const family = merchantFamily(t.merchant ?? "");
    if (!family) continue;
    for (const r of receipts) {
      if (merchantFamily(r.source) !== family) continue;
      const amountDelta = Math.abs(t.amount_cents - r.amount_cents), timeDelta = Math.abs(t.ts - r.ts);
      if (timeDelta > 48 * 3600) continue;
      // A final ride receipt can include a separately posted tip. Require a
      // matching sibling charge, rather than widening every ride's tolerance.
      const tipAdjusted = (family === "uber" || family === "lyft") && r.amount_cents > t.amount_cents &&
        amountDelta <= Math.round(t.amount_cents * 0.20) && transactions.some(other =>
          other.id !== t.id && other.account_id === t.account_id && merchantFamily(other.merchant ?? "") === family &&
          other.ts >= t.ts && other.ts - t.ts <= 72 * 3600 &&
          Math.abs(other.amount_cents - amountDelta) <= 50);
      if (amountDelta <= 50 || tipAdjusted) candidates.push({ txn_id: t.id, receipt_id: r.id,
        amount_delta_cents: amountDelta, time_delta_seconds: timeDelta, tip_adjusted: amountDelta > 50 });
    }
  }
  candidates.sort((a, b) => a.amount_delta_cents - b.amount_delta_cents || a.time_delta_seconds - b.time_delta_seconds || a.txn_id.localeCompare(b.txn_id) || a.receipt_id.localeCompare(b.receipt_id));
  const usedTxn = new Set<string>(), usedReceipt = new Set<string>();
  return candidates.filter(m => {
    if (usedTxn.has(m.txn_id) || usedReceipt.has(m.receipt_id)) return false;
    usedTxn.add(m.txn_id); usedReceipt.add(m.receipt_id); return true;
  });
}

/** Persists matches as attributions.receipt_id (owner is filled in by attributeAll). User labels keep their row. */
export function matchReceipts(db: Database): number {
  const matches = findMatches(db);
  db.transaction(() => {
    db.run("UPDATE attributions SET receipt_id = NULL");
    const put = db.query(`INSERT INTO attributions (txn_id, owner, rule, confidence, receipt_id) VALUES (?, 'unknown', 7, 0, ?)
      ON CONFLICT(txn_id) DO UPDATE SET receipt_id = excluded.receipt_id`);
    for (const m of matches) put.run(m.txn_id, m.receipt_id);
  })();
  return matches.length;
}
