// "what is an Uber?" about a merchant in your own data: answered locally from the ledger of transactions.
import type { Database } from "bun:sqlite";
import { friendlyUsd } from "../handlers/afford.ts";
import { MY_SHARE } from "../handlers/finance.ts";
import { TZ } from "./clock.ts";

const norm = (s: string) => s.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** A merchant in the data matching a typed name (exact, ignoring case and punctuation, else a unique prefix). */
export function resolveMerchant(db: Database, typed: string): string | null {
  const q = norm(typed);
  if (!q) return null;
  const names = (db.query("SELECT DISTINCT merchant FROM transactions WHERE merchant IS NOT NULL").all() as { merchant: string }[]).map((r) => r.merchant);
  const exact = names.find((n) => norm(n) === q);
  if (exact) return exact;
  const prefix = names.filter((n) => norm(n).startsWith(`${q} `));
  return prefix.length === 1 ? prefix[0] : null;
}

/** The merchant a "what is / who is X?" question names, if it's one in the data. */
export function merchantNamed(db: Database, text: string): string | null {
  const m = /^\s*(?:what|who)(?:['’]s|\s+is|\s+are)\s+(?:an?\s+|the\s+)?(.+?)\s*\??\s*$/i.exec(text);
  return m ? resolveMerchant(db, m[1]) : null;
}

/** Local answer for a known merchant, or null to route the question normally. Her-only merchants stay on her side. */
export function merchantLookup(db: Database, text: string): string | null {
  const name = merchantNamed(db, text);
  if (!name) return null;
  const r = db.query(`SELECT COUNT(*) AS n, MIN(t.ts) AS first, COALESCE(SUM(t.amount_cents * ${MY_SHARE}), 0) AS mine,
      COALESCE(SUM(CASE WHEN COALESCE(a.owner, 'me') != 'her' THEN 1 ELSE 0 END), 0) AS mine_n
    FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id WHERE t.merchant = ? AND t.amount_cents > 0`).get(name) as
    { n: number; first: number | null; mine: number; mine_n: number };
  if (!r.n) return null;
  if (!r.mine_n) return `${name} is on her side of the card, so I keep it out of your numbers.`;
  const since = new Date(r.first! * 1000).toLocaleDateString("en-US", { month: "long", timeZone: TZ });
  return `${name} is one you've paid ${r.mine_n} time${r.mine_n === 1 ? "" : "s"} since ${since}, ~${friendlyUsd(Math.round(r.mine))} total (your share).`;
}
