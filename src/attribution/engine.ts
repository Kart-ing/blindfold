import type { Database } from "bun:sqlite";
import { merchantFamily } from "../ingest/match";
import { lookupLocation, relabelReceipts } from "../ingest/receipts";
import type { Owner, Receipt, Transaction } from "../ingest/types";
import { reapplyPreferences } from "../memory/prefs";

/** Rule number -> short human reason (panel + `rules` command). 0 = not a shared account. */
export const RULES: Record<number, string> = {
  0: "personal account",
  1: "you labelled it",
  2: "Apple Pay on Amex",
  3: "ride receipt HOME<->WORK",
  4: "single-person food order",
  5: "multi-person food order (split)",
  6: "weekday work hours",
  7: "default",
  8: 'your standing preference ("Sephora is always hers"); never overrides 1',
};

export type Attribution = { txn_id: string; owner: Owner; rule: number; confidence: number; receipt_id: string | null; labelled_by_user: number; needs_prompt: number };
type JoinedTransaction = Transaction & { shared: number; issuer: string };
const validOwners: Owner[] = ["me", "her", "shared", "unknown"];

function duringWorkHours(ts: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ts * 1000));
  const get = (kind: string) => parts.find(p => p.type === kind)!.value;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat", "Sun"].includes(get("weekday")) && minute >= 9 * 60 && minute < 18 * 60;
}

function assign(db: Database, txnId: string): Attribution {
  const t = db.query<JoinedTransaction, [string]>(`SELECT t.*, a.shared, a.issuer FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(txnId);
  if (!t) throw new Error(`Unknown transaction or account: ${txnId}`);
  const existing = db.query<Attribution, [string]>("SELECT * FROM attributions WHERE txn_id=?").get(txnId);
  const receiptId = existing?.receipt_id ?? null;
  const r = receiptId ? db.query<Receipt, [string]>("SELECT * FROM receipts WHERE id=?").get(receiptId) : null;
  let owner: Owner = "me", rule = 7, confidence = 0.5, labelled = 0;
  if (existing?.labelled_by_user && validOwners.includes(existing.owner)) {
    owner = existing.owner; rule = 1; confidence = 1; labelled = 1;
  } else if (!t.shared) {
    // Rule 0 denotes the PRD's unconditional non-shared-account ownership.
    rule = 0; confidence = 1;
  } else if (t.wallet?.toLowerCase() === "apple_pay" && /^(?:amex|american express)$/i.test(t.issuer)) {
    owner = "her"; rule = 2; confidence = 0.99;
  } else if (r && (r.source === "uber" || r.source === "lyft") &&
    ((r.pickup_label === "HOME" && r.dropoff_label === "WORK") || (r.pickup_label === "WORK" && r.dropoff_label === "HOME"))) {
    rule = 3; confidence = 0.98;
  } else if (r && (r.source === "uber_eats" || r.source === "doordash") &&
    ((r.items != null && r.items <= 1) || (r.subtotal_cents != null && r.subtotal_cents <= 3000))) {
    rule = 4; confidence = 0.9;
  } else if (r && (r.source === "uber_eats" || r.source === "doordash")) {
    owner = "shared"; rule = 5; confidence = 0.9;
  } else if (duringWorkHours(t.ts)) {
    rule = 6; confidence = 0.65;
  }
  const family = merchantFamily(t.merchant ?? "");
  const otherRide = (family === "uber" || family === "lyft") && r && (r.pickup_label === "OTHER" || r.dropoff_label === "OTHER");
  const needsPrompt = !!t.shared && !labelled && owner !== "her" && (((rule === 6 || rule === 7) && t.amount_cents > 7500) || !!otherRide);
  const result: Attribution = { txn_id: txnId, owner, rule, confidence, receipt_id: receiptId, labelled_by_user: labelled, needs_prompt: Number(needsPrompt) };
  db.query(`INSERT INTO attributions (txn_id, owner, rule, confidence, receipt_id, labelled_by_user, needs_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(txn_id) DO UPDATE SET owner=excluded.owner,
    rule=excluded.rule, confidence=excluded.confidence, receipt_id=excluded.receipt_id,
    labelled_by_user=excluded.labelled_by_user, needs_prompt=excluded.needs_prompt`)
    .run(txnId, owner, rule, confidence, receiptId, labelled, result.needs_prompt);
  return result;
}

/** Re-attributes one transaction using its stored receipt match (see matchReceipts). */
export function attribute(db: Database, txnId: string): Attribution {
  return assign(db, txnId);
}

/** Never overwrites labelled_by_user=1 rows. */
export function attributeAll(db: Database): Attribution[] {
  const out = db.transaction(() =>
    db.query<{ id: string }, []>("SELECT id FROM transactions ORDER BY ts, id").all().map(t => assign(db, t.id)))();
  // Standing preferences ("X is always hers", rule 8) go last, so a re-ingest never drops them. Re-read: a preference can
  // change the rule without changing the owner.
  reapplyPreferences(db);
  return out.map(a => db.query<Attribution, [string]>("SELECT * FROM attributions WHERE txn_id = ?").get(a.txn_id)!);
}

/** User label: rule 1, labelled_by_user=1, needs_prompt=0. */
export function setOwner(db: Database, txnId: string, owner: "me" | "her" | "shared"): Attribution {
  if (!["me", "her", "shared"].includes(owner)) throw new Error(`Invalid owner: ${owner}`);
  if (!db.query("SELECT 1 FROM transactions WHERE id = ?").get(txnId)) throw new Error(`Unknown transaction: ${txnId}`);
  db.query(`INSERT INTO attributions (txn_id, owner, rule, confidence, labelled_by_user, needs_prompt) VALUES (?, ?, 1, 1, 1, 0)
    ON CONFLICT(txn_id) DO UPDATE SET owner = excluded.owner, rule = 1, confidence = 1, labelled_by_user = 1, needs_prompt = 0`).run(txnId, owner);
  return db.query<Attribution, [string]>("SELECT * FROM attributions WHERE txn_id = ?").get(txnId)!;
}

/** `home is <addr>` / `work is <addr>`: local lookup only, then re-geofence receipts and re-attribute. */
export function setPlace(db: Database, label: "HOME" | "WORK", address: string): { ok: boolean; reason?: string } {
  if (label !== "HOME" && label !== "WORK") return { ok: false, reason: "label must be HOME or WORK" };
  const loc = lookupLocation(address);
  if (!loc) return { ok: false, reason: "address not found in the local lookup table" };
  db.query(`INSERT INTO places (label, address, lat, lng) VALUES (?, ?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET address = excluded.address, lat = excluded.lat, lng = excluded.lng`).run(label, loc.address, loc.lat, loc.lng);
  relabelReceipts(db);
  attributeAll(db);
  return { ok: true };
}
