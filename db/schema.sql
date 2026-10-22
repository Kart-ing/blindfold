-- CONTRACT: frozen 12:35 Oct 22. Changes only via fin-agent-lead.
PRAGMA journal_mode=WAL;
-- balance_cents: current balance as of balance_ts (for credit: amount owed).
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT, mask TEXT, issuer TEXT, type TEXT, subtype TEXT, shared INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT 'me', balance_cents INTEGER, balance_ts INTEGER);
-- amount_cents: positive = outflow (Plaid convention). ts = unix seconds UTC.
-- category: Plaid personal_finance_category PRIMARY, e.g. INCOME, TRANSFER_IN, TRANSFER_OUT, LOAN_PAYMENTS, RENT_AND_UTILITIES, FOOD_AND_DRINK, TRANSPORTATION, ENTERTAINMENT, GENERAL_MERCHANDISE.
CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), ts INTEGER NOT NULL, amount_cents INTEGER NOT NULL, merchant TEXT, category TEXT, payment_channel TEXT, wallet TEXT, memo TEXT, raw_json TEXT);
-- raw addresses live only in the .eml at raw_path; reasoning uses labels HOME/WORK/OTHER
CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, source TEXT NOT NULL, email_id TEXT, ts INTEGER NOT NULL, amount_cents INTEGER NOT NULL, pickup_label TEXT, dropoff_label TEXT, items INTEGER, subtotal_cents INTEGER, raw_path TEXT);
CREATE TABLE IF NOT EXISTS places(label TEXT PRIMARY KEY, address TEXT, lat REAL, lng REAL);
-- owner in (me, her, shared, unknown)
CREATE TABLE IF NOT EXISTS attributions(txn_id TEXT PRIMARY KEY REFERENCES transactions(id), owner TEXT NOT NULL, rule INTEGER NOT NULL, confidence REAL NOT NULL, receipt_id TEXT, labelled_by_user INTEGER NOT NULL DEFAULT 0, needs_prompt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY, target_cents INTEGER NOT NULL, deadline INTEGER NOT NULL, created_ts INTEGER NOT NULL, savings_at_creation_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS symbols(symbol TEXT PRIMARY KEY, real TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consents(scope TEXT PRIMARY KEY, grant_kind TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tier TEXT NOT NULL, intent TEXT, question_sym TEXT, payload_json TEXT, exact_disclosed INTEGER NOT NULL DEFAULT 0, partial_count INTEGER NOT NULL DEFAULT 0, canary_checked INTEGER, canary_hits INTEGER, consent TEXT);
CREATE TABLE IF NOT EXISTS nudges(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, period_key TEXT NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL, txn_ids TEXT, UNIQUE(kind, period_key));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
-- outbound/inbound iMessage log + pending prompts (owned by eng-2)
CREATE TABLE IF NOT EXISTS prompts(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT, text TEXT, sent_ts INTEGER, answered TEXT, answered_ts INTEGER);
-- Memory v1 (tasks/memory.md; design adapted from CopilotKit/OpenDots, MIT). Local only; read with "memories", delete with "forget".
-- kind 'owner_pref' rows ("Sephora is always hers") change attribution (rule 8); other kinds are plain notes.
CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_ts INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'note', merchant TEXT, owner TEXT, txn_ids TEXT);
-- Internal ledger maintenance (tasks/statements.md): one row per imported statement file. Re-imports are idempotent by
-- file_sha; transactions carry their provenance in raw_json ({file_sha, page, line}). recon_* = statement vs computed.
CREATE TABLE IF NOT EXISTS ingest_log(file_sha TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL, account_id TEXT, period_start INTEGER, period_end INTEGER, rows INTEGER NOT NULL, opening_cents INTEGER, closing_cents INTEGER, recon_ok INTEGER, ingested_ts INTEGER NOT NULL);
-- Balances the user tells us about by text ("I also have around 10k in my robinhood"): counted toward the goal as
-- savings. memory_id ties each one to its memories row, so "forget N" removes it too.
CREATE TABLE IF NOT EXISTS manual_assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_ts INTEGER NOT NULL, memory_id INTEGER);
