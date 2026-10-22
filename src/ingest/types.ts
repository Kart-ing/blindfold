import type { Database } from "bun:sqlite";

export type Owner = "me" | "her" | "shared" | "unknown";
export type Account = {
  id: string; name: string; mask: string; issuer: string; type: string; subtype: string;
  shared: number; owner: Owner; balance_cents: number; balance_ts: number;
};
export type Transaction = {
  id: string; account_id: string; ts: number; amount_cents: number; merchant: string;
  category: string; payment_channel: string; wallet?: string | null; memo?: string | null;
};
export type Place = { label: string; address: string; lat: number; lng: number };
export type Receipt = {
  id: string; source: string; email_id: string; ts: number; amount_cents: number;
  pickup_label: string | null; dropoff_label: string | null; items: number | null;
  subtotal_cents: number | null; raw_path: string;
};

// Keep only bank fields needed for local reasoning. In particular, no address,
// email body, or provider payload is copied into transactions.raw_json.
export function ingestTransactions(db: Database, transactions: Transaction[]): number {
  const put = db.query(`INSERT INTO transactions
    (id, account_id, ts, amount_cents, merchant, category, payment_channel, wallet, memo, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, ts=excluded.ts,
      amount_cents=excluded.amount_cents, merchant=excluded.merchant, category=excluded.category,
      payment_channel=excluded.payment_channel, wallet=excluded.wallet, memo=excluded.memo,
      raw_json=excluded.raw_json`);
  db.transaction(() => {
    for (const t of transactions) {
      if (!Number.isSafeInteger(t.amount_cents) || !Number.isSafeInteger(t.ts)) {
        throw new Error(`Invalid transaction amount or timestamp: ${t.id}`);
      }
      const safe = { id: t.id, account_id: t.account_id, ts: t.ts, amount_cents: t.amount_cents,
        merchant: t.merchant, category: t.category, payment_channel: t.payment_channel,
        wallet: t.wallet ?? null, memo: t.memo ?? null };
      put.run(t.id, t.account_id, t.ts, t.amount_cents, t.merchant, t.category,
        t.payment_channel, t.wallet ?? null, t.memo ?? null, JSON.stringify(safe));
    }
  })();
  return transactions.length;
}

export function ingestAccounts(db: Database, accounts: Account[]): void {
  const put = db.query(`INSERT INTO accounts
    (id, name, mask, issuer, type, subtype, shared, owner, balance_cents, balance_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, mask=excluded.mask, issuer=excluded.issuer, type=excluded.type,
    subtype=excluded.subtype, shared=excluded.shared, owner=excluded.owner,
    balance_cents=excluded.balance_cents, balance_ts=excluded.balance_ts`);
  db.transaction(() => {
    for (const a of accounts) put.run(a.id, a.name, a.mask, a.issuer, a.type, a.subtype,
      a.shared, a.owner, a.balance_cents, a.balance_ts);
  })();
}
