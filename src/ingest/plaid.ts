// Real bank data behind DATA_SOURCE=plaid. Plain fetch, no SDK. Access tokens stay in the local settings table.
//   bun run src/ingest/plaid.ts --sandbox-link   # sandbox only: create an Item and store its access token
//   bun run src/ingest/plaid.ts                  # sync accounts + transactions, then match + attribute
//
// Apple Pay: Plaid's transaction object has no wallet field (payment_channel is online/in store/other).
// Amex prints "AplPay <merchant>" on statements for Apple Pay purchases, so the only signal is that prefix in
// original_description / name, IF Plaid passes Amex's raw descriptor through. Sandbox data can't show this;
// unverified against a real Amex Item. Without it, real data falls back to the low-confidence prompt (PRD §4).
import type { Database } from "bun:sqlite";
import { openDb } from "../db";
import { attributeAll } from "../attribution/engine";
import { matchReceipts } from "./match";
import { ingestAccounts, ingestTransactions, type Account, type Transaction } from "./types";

const HOST = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };
const AMEX_INSTITUTION = "ins_10";

type PlaidAccount = { account_id: string; name: string; official_name?: string | null; mask?: string | null; type: string; subtype?: string | null;
  balances: { current?: number | null } };
export type PlaidTxn = { transaction_id: string; account_id: string; amount: number; date: string; authorized_datetime?: string | null;
  datetime?: string | null; name?: string | null; merchant_name?: string | null; original_description?: string | null;
  payment_channel?: string | null; personal_finance_category?: { primary?: string } | null; pending?: boolean };

const APPLE_PAY = /^\s*apl\s*pay\b/i;

/** Plaid -> our row. Amount sign already matches (positive = outflow). Date-only rows get noon PT. */
export function mapTransaction(t: PlaidTxn): Transaction {
  const desc = `${t.original_description ?? ""} ${t.name ?? ""}`;
  const when = t.authorized_datetime ?? t.datetime ?? `${t.date}T12:00:00-07:00`;
  return { id: `plaid-${t.transaction_id}`, account_id: `plaid-${t.account_id}`, ts: Math.floor(Date.parse(when) / 1000),
    amount_cents: Math.round(t.amount * 100), merchant: t.merchant_name ?? (t.name ?? "").replace(APPLE_PAY, "").trim(),
    category: t.personal_finance_category?.primary ?? "OTHER", payment_channel: t.payment_channel ?? "other",
    wallet: APPLE_PAY.test(t.original_description ?? "") || APPLE_PAY.test(t.name ?? "") ? "apple_pay" : null, memo: null };
}

export function mapAccount(a: PlaidAccount, institutionId: string, sharedIds: Set<string>, now: number): Account {
  const amex = institutionId === AMEX_INSTITUTION || /amex|american express/i.test(`${a.name} ${a.official_name ?? ""}`);
  const shared = sharedIds.has(a.account_id) || sharedIds.has(a.mask ?? "") ? 1 : 0;
  return { id: `plaid-${a.account_id}`, name: a.official_name ?? a.name, mask: a.mask ?? "", issuer: amex ? "amex" : institutionId,
    type: a.type, subtype: a.subtype ?? "", shared, owner: shared ? "shared" : "me",
    balance_cents: Math.round((a.balances.current ?? 0) * 100), balance_ts: now };
}

async function plaid<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const env = (process.env.PLAID_ENV ?? "sandbox") as keyof typeof HOST;
  const { PLAID_CLIENT_ID: client_id, PLAID_SECRET: secret } = process.env;
  if (!client_id || !secret) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET missing from .env");
  const res = await fetch(`${HOST[env]}${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, secret, ...body }) });
  const json = await res.json() as T & { error_message?: string };
  if (!res.ok) throw new Error(`Plaid ${path}: ${json.error_message ?? res.status}`);
  return json;
}

const setting = (db: Database, key: string) => (db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const put = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

/** Sandbox only: Item at the Amex test institution, token stored locally. */
export async function sandboxLink(db: Database): Promise<void> {
  const { public_token } = await plaid<{ public_token: string }>("/sandbox/public_token/create",
    { institution_id: AMEX_INSTITUTION, initial_products: ["transactions"] });
  const { access_token } = await plaid<{ access_token: string }>("/item/public_token/exchange", { public_token });
  put(db, "plaid_access_token", access_token);
}

/** Pulls accounts + all transactions via /transactions/sync, then runs match + attribution. `settings.plaid_shared` = comma list of account ids or masks. */
export async function syncPlaid(db: Database, now: number): Promise<{ accounts: number; transactions: number }> {
  const access_token = setting(db, "plaid_access_token");
  if (!access_token) throw new Error("no plaid_access_token in settings (run --sandbox-link)");
  const shared = new Set((setting(db, "plaid_shared") ?? "").split(",").map(s => s.trim()).filter(Boolean));
  const acct = await plaid<{ accounts: PlaidAccount[]; item: { institution_id?: string } }>("/accounts/get", { access_token });
  ingestAccounts(db, acct.accounts.map(a => mapAccount(a, acct.item.institution_id ?? "", shared, now)));
  let cursor = setting(db, "plaid_cursor") ?? undefined, added: PlaidTxn[] = [], more = true;
  while (more) {
    const page = await plaid<{ added: PlaidTxn[]; modified: PlaidTxn[]; next_cursor: string; has_more: boolean }>("/transactions/sync", { access_token, cursor });
    added = added.concat(page.added, page.modified);
    cursor = page.next_cursor; more = page.has_more;
  }
  ingestTransactions(db, added.filter(t => !t.pending).map(mapTransaction));
  if (cursor) put(db, "plaid_cursor", cursor);
  matchReceipts(db);
  attributeAll(db);
  return { accounts: acct.accounts.length, transactions: added.length };
}

if (import.meta.main) {
  const db = openDb();
  if (process.argv.includes("--sandbox-link")) await sandboxLink(db);
  console.log(JSON.stringify(await syncPlaid(db, Math.floor(Date.now() / 1000))));
  db.close();
}
