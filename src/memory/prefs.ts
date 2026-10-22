// Memories that change behaviour: "<merchant> is always mine|hers|split" relabels that merchant's shared-card
// charges. Rule 8 sits above rules 2–7 but never touches explicit per-charge labels (rule 1, labelled_by_user=1);
// forgetting the memory re-runs the attribution engine for exactly the charges it moved.
import type { Database } from "bun:sqlite";
import { attribute } from "../attribution/engine.ts";

export const PREF_RULE = 8;
export type Owner = "me" | "her" | "shared";
const OWNER: Record<string, Owner> = { mine: "me", me: "me", hers: "her", her: "her", split: "shared", shared: "shared" };

/** "Sephora is always hers", "Sephora's always mine", "always split Uber", with or without "remember (that)". */
export function parsePreference(raw: string): { merchant: string; owner: Owner } | null {
  const t = raw.trim().replace(/^remember\s+(?:that\s+)?/i, "").replace(/[.!]+$/, "").trim();
  let m = /^(.+?)(?:\s+is|['’]s)\s+always\s+(mine|me|hers|her|split|shared)$/i.exec(t);
  if (m) return { merchant: m[1].trim(), owner: OWNER[m[2].toLowerCase()] };
  m = /^always\s+(split)\s+(.+)$/i.exec(t);
  if (m) return { merchant: m[2].trim(), owner: "shared" };
  return null;
}

/** Applies a preference to every shared-card charge at the merchant: `changed` moved owner, `touched` now carry rule 8. */
export function applyPreference(db: Database, merchant: string, owner: Owner): { changed: string[]; touched: string[] } {
  const rows = db.query(`SELECT t.id, a.owner AS owner FROM transactions t JOIN accounts acct ON acct.id = t.account_id
      LEFT JOIN attributions a ON a.txn_id = t.id
      WHERE acct.shared = 1 AND LOWER(t.merchant) = LOWER(?) AND t.amount_cents > 0 AND COALESCE(a.labelled_by_user, 0) = 0`)
    .all(merchant) as { id: string; owner: string | null }[];
  const changed: string[] = [];
  db.transaction(() => {
    for (const r of rows) {
      db.run(`INSERT INTO attributions(txn_id, owner, rule, confidence, labelled_by_user, needs_prompt) VALUES (?, ?, ?, 1.0, 0, 0)
          ON CONFLICT(txn_id) DO UPDATE SET owner = excluded.owner, rule = excluded.rule, confidence = 1.0, needs_prompt = 0`,
        [r.id, owner, PREF_RULE]);
      if (r.owner !== owner) changed.push(r.id);
    }
  })();
  // Every touched charge (not only the moved ones) goes back to the engine on forget, since all now carry rule 8.
  return { changed, touched: rows.map((r) => r.id) };
}

/** Back to the usual rules: re-runs the engine for the charges a preference set, unless relabelled by hand since. */
export function revertPreference(db: Database, txnIds: string[]): number {
  let n = 0;
  db.transaction(() => {
    for (const id of txnIds) {
      const a = db.query("SELECT rule, labelled_by_user FROM attributions WHERE txn_id = ?").get(id) as { rule: number; labelled_by_user: number } | null;
      if (!a || a.labelled_by_user || a.rule !== PREF_RULE) continue;
      attribute(db, id);
      n++;
    }
  })();
  return n;
}

/**
 * Re-applies every standing preference, e.g. at the end of attributeAll() after an ingest, which recomputes
 * unlabelled charges and would otherwise drop rule 8. Updates each memory's charge list. Returns charges moved.
 */
export function reapplyPreferences(db: Database): number {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
  if (!exists) return 0;
  const prefs = db.query("SELECT id, merchant, owner FROM memories WHERE kind = 'owner_pref' ORDER BY created_ts, id").all() as
    { id: number; merchant: string; owner: Owner }[];
  let moved = 0;
  for (const p of prefs) {
    const { changed, touched } = applyPreference(db, p.merchant, p.owner);
    moved += changed.length;
    db.run("UPDATE memories SET txn_ids = ? WHERE id = ?", [JSON.stringify(touched), p.id]);
  }
  return moved;
}
