// "the uber was hers", "that nordstrom thing was mine", "split the doordash": relabel a shared-card charge (T0, local).
// Exact commands ("that was hers", 1/2/3) are handled by the router before this; this is the free-text version.
import type { Handler } from "./types";
import { setOwner } from "../attribution/engine";
import { friendlyUsd } from "./afford";

type Owner = "me" | "her" | "shared";
const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Whose it was, from the user's words. "not mine" means hers; split words win over a bare "me" ("split it with me"). */
export function ownerFrom(text: string): Owner | null {
  const t = norm(text);
  if (/\bnot (mine|me|my)\b/.test(t)) return "her";
  if (/\b(split|shared|both|half|halves)\b/.test(t)) return "shared";
  if (/\b(hers|her|girlfriend|gf)\b/.test(t)) return "her";
  if (/\b(mine|me|my|i did|i paid)\b/.test(t)) return "me";
  return null;
}

type Txn = { id: string; merchant: string; amount_cents: number; ts: number };

export const handle: Handler = async (db, text, ctx) => {
  const owner = ownerFrom(text);
  // The charge: the longest shared-card merchant named in the text, its latest charge; else the last who-paid question's.
  const t = ` ${norm(text)} `;
  const merchants = (db.query(`SELECT DISTINCT t.merchant AS m FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.shared = 1 AND t.merchant IS NOT NULL`).all() as { m: string }[]).map((r) => r.m)
    .filter((m) => norm(m).length >= 3 && t.includes(` ${norm(m)} `)).sort((a, b) => b.length - a.length);
  const pick = (sql: string, arg: string | number) => db.query(sql).get(arg, ctx.now) as Txn | null;
  const txn = merchants.length
    ? pick(`SELECT t.id, t.merchant, t.amount_cents, t.ts FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.shared = 1 AND t.merchant = ? AND t.ts <= ? ORDER BY t.ts DESC LIMIT 1`, merchants[0])
    : pick(`SELECT t.id, t.merchant, t.amount_cents, t.ts FROM prompts p JOIN transactions t ON t.id = p.ref
        WHERE p.kind = 'who_paid' AND p.id = (SELECT MAX(id) FROM prompts WHERE kind = 'who_paid') AND ? <> '' AND t.ts <= ?`, "x");

  if (!owner || !txn) return { text: 'Which charge, and whose? e.g. "the Uber on Friday was hers".', tier: "local" };
  setOwner(db, txn.id, owner);
  // A who-paid question about this charge is answered by this, so close it.
  db.run("UPDATE prompts SET answered = ?, answered_ts = ? WHERE kind = 'who_paid' AND ref = ? AND answered IS NULL", [owner, ctx.now, txn.id]);
  const day = new Date(txn.ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  const whose = owner === "me" ? "yours" : owner === "her" ? "hers, so it won't count toward your spending" : "split 50/50";
  return { text: `Got it: the ${friendlyUsd(txn.amount_cents)} ${txn.merchant} on ${day} is ${whose}.`, tier: "local" };
};
