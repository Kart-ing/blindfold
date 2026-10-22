// `bun run src/ingest/seed-real.ts [--db data/real.db] [--no-fm]`: data/real.db, all real (tasks/statements.md, real-mail.md).
// Bank side: the owner's statements in ../Bank Statments (eng3's parsers), deduped across files, categorized, logged in
// ingest_log. Receipts: their ride and food emails (src/ingest/real.ts), matched to the real card charges. Every account is
// the owner's (no shared card). Prints counts and money totals only, never statement or mail text.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { openDb } from "../db";
import { attributeAll } from "../attribution/engine";
import { localModelsOn } from "../imessage/fm";
import { categorizeAll, p2pMemo } from "./categorize";
import { matchReceipts } from "./match";
import { classifyMailbox, dedupe, inferHomeWork, labelFor, localDay, realAddressesFor, RECEIPT_KINDS, type RealMail } from "./real";

const root = join(import.meta.dir, "../..");
export const STATEMENTS_DIR = join(root, "..", "Bank Statments");
const SOURCE: Record<string, string> = { ride: "uber", eats: "uber_eats", doordash: "doordash" };
export const WINDOW_START = Math.floor(Date.parse("2026-08-01T00:00:00-07:00") / 1000); // first month the checking statements cover

export type StmtAccount = { key: string; institution: string; type: string; subtype: string; mask: string };
export type StmtRow = { account_key: string; ts: number; posted_ts?: number | null; amount_cents: number; description: string;
  bank_category?: string | null; category_hint?: string | null; page?: number; line?: number };
export type StmtResult = { source: string; accounts: StmtAccount[]; rows: StmtRow[];
  balances?: { account_key: string; opening_cents: number | null; closing_cents: number | null; period_start: number | null; period_end: number | null }[];
  recon?: { account_key: string; ok: boolean; diff_cents: number | null }[] };

/** Statement files under dir: Capital One CSV exports, Capital One 360 PDFs, Citi PDFs. */
export function statementFiles(dir: string): { path: string; kind: "capone_csv" | "capone_360_pdf" | "citi_pdf" }[] {
  const out: { path: string; kind: "capone_csv" | "capone_360_pdf" | "citi_pdf" }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.csv$/i.test(f)) out.push({ path: p, kind: "capone_csv" });
      else if (/\.pdf$/i.test(f)) out.push({ path: p, kind: /citi/i.test(relative(dir, p)) ? "citi_pdf" : "capone_360_pdf" });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function pdfText(path: string): string {
  const r = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
  if (r.exitCode !== 0) throw new Error("pdftotext failed");
  return r.stdout.toString();
}

export type StatementStats = { files: number; duplicateFiles: number; parsed: number; failed: number; accounts: number; rows: number;
  rowDuplicates: number; beforeWindow: number; reconOk: number; reconFail: number; byVia: Record<string, number>; uncategorized: number;
  savingsAtStart: number | null };

const emptyStats = (): StatementStats => ({ files: 0, duplicateFiles: 0, parsed: 0, failed: 0, accounts: 0, rows: 0, rowDuplicates: 0,
  beforeWindow: 0, reconOk: 0, reconFail: 0, byVia: {}, uncategorized: 0, savingsAtStart: null });

/** The statement files under dir, parsed. A file whose fingerprint is in `seen` (or repeats an earlier file) is skipped. */
async function parseStatements(dir: string, seen: Set<string>, st: StatementStats) {
  const P = await import("./statements"); // eng3's parsers (pure): text in, rows out
  const parsed: { sha: string; rel: string; res: StmtResult }[] = [];
  for (const f of statementFiles(dir)) {
    st.files++;
    const bytes = readFileSync(f.path);
    try {
      const text = f.kind === "capone_csv" ? bytes.toString("utf8") : pdfText(f.path);
      const res: StmtResult = f.kind === "capone_csv" ? P.parseCapOneCsv(text) : f.kind === "capone_360_pdf" ? P.parseCapOne360Pdf(text)
        : P.parseCitiPdf(text, { year: Number(/\b(20\d\d)\b/.exec(basename(f.path))?.[1] ?? /\b(\d\d)\b/.exec(basename(f.path))?.[1]?.padStart(4, "20") ?? 2026) });
      const sha = P.statementFingerprint(res as never);
      if (seen.has(sha)) { st.duplicateFiles++; continue; }
      seen.add(sha);
      parsed.push({ sha, rel: relative(dir, f.path), res });
      st.parsed++;
    } catch { st.failed++; } // never log the file's text
  }
  return parsed;
}

// Rows, deduped across files: a row may appear in several overlapping files; keep the most times it appears in any ONE file,
// so two genuine identical purchases on a day both stay. Ids are stable: the same statements give the same ids.
function dedupeRows(parsed: { sha: string; res: StmtResult }[], from: number, to: number, st: StatementStats) {
  const inserted = new Map<string, number>();
  const rows: { id: string; r: StmtRow; sha: string; source: string }[] = [];
  for (const { sha, res } of parsed) {
    const local = new Map<string, number>();
    for (const r of res.rows) {
      const key = `${r.account_key}|${localDay(r.ts)}|${r.amount_cents}|${r.description.replace(/\s+/g, " ").trim().toLowerCase()}`;
      const n = (local.get(key) ?? 0) + 1;
      local.set(key, n);
      if (n <= (inserted.get(key) ?? 0)) { st.rowDuplicates++; continue; }
      inserted.set(key, n);
      if (r.ts < from || r.ts > to) { st.beforeWindow++; continue; }
      rows.push({ id: `st-${sha256(key).slice(0, 12)}-${n}`, r, sha, source: res.source });
    }
  }
  return rows;
}

/** Parses, dedupes, categorizes and inserts the statements; writes ingest_log. Idempotent by file sha. */
export async function ingestStatements(db: Database, dir: string, opts: { useFm?: boolean; categoriesCache: string; from: number; to: number }): Promise<StatementStats> {
  const st = emptyStats();
  // Keyed by eng3's statementFingerprint (content, not bytes): re-downloads differ in PDF metadata but are the same statement.
  const seen = new Set<string>((db.query("SELECT file_sha FROM ingest_log").all() as { file_sha: string }[]).map((r) => r.file_sha));
  const parsed = await parseStatements(dir, seen, st);
  // Accounts: every one is the owner's (no shared card). Balance = the latest statement's closing balance.
  const accounts = new Map<string, StmtAccount>();
  const latest = new Map<string, { cents: number; ts: number }>();
  for (const { res } of parsed) {
    for (const a of res.accounts) accounts.set(a.key, a);
    for (const b of res.balances ?? []) if (b.closing_cents !== null && b.period_end !== null && (latest.get(b.account_key)?.ts ?? -1) < b.period_end) latest.set(b.account_key, { cents: b.closing_cents, ts: b.period_end });
    for (const r of res.recon ?? []) r.ok ? st.reconOk++ : st.reconFail++;
  }
  const putAcct = db.query(`INSERT INTO accounts (id, name, mask, issuer, type, subtype, shared, owner, balance_cents, balance_ts) VALUES (?, ?, ?, ?, ?, ?, 0, 'me', ?, ?)
    ON CONFLICT(id) DO UPDATE SET balance_cents = excluded.balance_cents, balance_ts = excluded.balance_ts`);
  for (const a of accounts.values()) putAcct.run(a.key, `${a.institution} ${a.subtype}`, a.mask, a.institution.toLowerCase(), a.type, a.subtype, latest.get(a.key)?.cents ?? null, latest.get(a.key)?.ts ?? null);
  st.accounts = accounts.size;
  // Savings on the window's first statement (opening balance), summed over savings accounts: the goal's starting point.
  const savingsKeys = new Set([...accounts.values()].filter((a) => a.subtype === "savings").map((a) => a.key));
  const firsts = new Map<string, { start: number; cents: number }>();
  for (const { res } of parsed) for (const b of res.balances ?? []) {
    if (!savingsKeys.has(b.account_key) || b.opening_cents === null || b.period_start === null || b.period_start < opts.from - 7 * 86400) continue;
    if ((firsts.get(b.account_key)?.start ?? Infinity) > b.period_start) firsts.set(b.account_key, { start: b.period_start, cents: b.opening_cents });
  }
  st.savingsAtStart = firsts.size ? [...firsts.values()].reduce((a, x) => a + x.cents, 0) : null;
  const rows = dedupeRows(parsed, opts.from, opts.to, st);
  const cats = await categorizeAll(rows.map(({ r }) => ({ desc: r.description, outflow: r.amount_cents > 0, hint: r.bank_category ?? null })),
    opts.categoriesCache, { useFm: opts.useFm });
  const putTxn = db.query(`INSERT INTO transactions (id, account_id, ts, amount_cents, merchant, category, payment_channel, wallet, memo, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 'other', ?, ?, ?)`);
  db.transaction(() => rows.forEach(({ id, r, sha, source }, i) => {
    const c = cats[i];
    const category = r.category_hint ?? c.category; // eng3's hint is only set when the statement text is unambiguous
    const via = r.category_hint ? "statement" : c.via;
    st.byVia[via] = (st.byVia[via] ?? 0) + 1;
    if (!category) st.uncategorized++;
    putTxn.run(id, r.account_key, r.ts, r.amount_cents, c.merchant, category, c.wallet, p2pMemo(r.description),
      JSON.stringify({ file_sha: sha, source, page: r.page ?? null, line: r.line ?? null, posted_ts: r.posted_ts ?? null, bank_category: r.bank_category ?? null }));
  }))();
  st.rows = rows.length;
  const putLog = db.query(`INSERT OR REPLACE INTO ingest_log (file_sha, path, source, account_id, period_start, period_end, rows, opening_cents, closing_cents, recon_ok, ingested_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const { sha, rel, res } of parsed) {
    const bs = res.balances ?? [];
    const one = res.accounts.length === 1 ? res.accounts[0].key : null;
    const b1 = one ? bs.find((b) => b.account_key === one) : undefined;
    const starts = bs.map((b) => b.period_start).filter((x): x is number => x !== null), ends = bs.map((b) => b.period_end).filter((x): x is number => x !== null);
    putLog.run(sha, rel, res.source, one, starts.length ? Math.min(...starts) : null, ends.length ? Math.max(...ends) : null, res.rows.length,
      b1?.opening_cents ?? null, b1?.closing_cents ?? null, res.recon?.length ? Number(res.recon.every((x) => x.ok)) : null, Math.floor(Date.now() / 1000));
  }
  return st;
}

/**
 * Sets the Zelle counterparty memo (p2pMemo) on statement rows already in db whose memo is empty, so an existing DB gets the
 * names knownPeople() symbolizes without a rebuild (which would lose its user state). named: such rows in db; missing: not in db.
 */
export async function backfillP2pMemos(db: Database, dir: string): Promise<{ named: number; set: number; missing: number }> {
  const st = emptyStats();
  const rows = dedupeRows(await parseStatements(dir, new Set(), st), -Infinity, Infinity, st);
  const has = db.query("SELECT 1 FROM transactions WHERE id = ?");
  const put = db.query("UPDATE transactions SET memo = ? WHERE id = ? AND memo IS NULL");
  let named = 0, set = 0, missing = 0;
  db.transaction(() => {
    for (const { id, r } of rows) {
      const memo = p2pMemo(r.description);
      if (!memo) continue;
      if (!has.get(id)) { missing++; continue; }
      named++;
      set += put.run(memo, id).changes;
    }
  })();
  return { named, set, missing };
}

/** Builds data/real.db: statements, then receipts matched to their charges, attribution, preferences. */
export async function buildReal(path: string, mails: RealMail[], mailRoot: string, now: number, opts: { useFm?: boolean; goal?: boolean } = {}) {
  if (resolve(path) === resolve(join(root, "data", "fin.db"))) throw new Error("refusing to overwrite the live demo DB");
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
  const db = openDb(path);
  const statements = await ingestStatements(db, STATEMENTS_DIR, { useFm: opts.useFm, categoriesCache: join(root, "data", "statement-categories.json"), from: WINDOW_START, to: now });
  const receipts = dedupe(mails).filter((m) => RECEIPT_KINDS.includes(m.kind) && m.ts !== null && m.total_cents !== null && m.total_cents > 0);
  const inWindow = receipts.filter((m) => m.ts! >= WINDOW_START && m.ts! <= now);
  const places = inferHomeWork(receipts.filter((m) => m.kind === "ride"));
  db.transaction(() => {
    for (const [label, p] of [["HOME", places.home], ["WORK", places.work]] as const) {
      if (p) db.query("INSERT INTO places (label, address, lat, lng) VALUES (?, ?, NULL, NULL)").run(label, p.address);
    }
    const put = db.query(`INSERT INTO receipts (id, source, email_id, ts, amount_cents, pickup_label, dropoff_label, items, subtotal_cents, raw_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
    // email_id is the IMAP uid only: the account folder in the path may be an email address. Labels only, never addresses.
    inWindow.forEach((m, i) => put.run(`receipt-real-${i}`, SOURCE[m.kind], basename(m.key, ".eml"), m.ts, m.total_cents,
      labelFor(m.pickup, places.home, places.work), labelFor(m.dropoff, places.home, places.work), m.subtotal_cents, join(mailRoot, m.key)));
    if (opts.goal !== false) {
      // The demo goal ($10k by June 2027, set Aug 1) with the REAL savings on Aug 1 as its starting point.
      const aug1 = statements.savingsAtStart ?? 0;
      db.query("INSERT INTO goals (id, target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (1, 1000000, ?, ?, ?, 1)")
        .run(Math.floor(Date.parse("2027-06-30T23:59:00-07:00") / 1000), WINDOW_START, aug1);
    }
  })();
  const matched = matchReceipts(db);
  attributeAll(db); // ends with reapplyPreferences
  return { db, statements, receipts, inWindow, places, matched };
}

/** Real addresses found in any column other than receipts.raw_path and places.address (must be 0). */
export function addressLeaks(db: Database): number {
  const needles = new Set<string>();
  for (const { raw_path } of db.query("SELECT raw_path FROM receipts WHERE raw_path IS NOT NULL").all() as { raw_path: string }[]) {
    for (const a of realAddressesFor(raw_path)) { needles.add(a.toLowerCase()); const street = a.split(",")[0].trim().toLowerCase(); if (street.length >= 8) needles.add(street); }
  }
  let hits = 0;
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    for (const row of db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[]) {
      for (const [col, v] of Object.entries(row)) {
        if ((name === "receipts" && col === "raw_path") || (name === "places" && col === "address") || typeof v !== "string") continue;
        const s = v.toLowerCase();
        for (const n of needles) if (s.includes(n)) hits++;
      }
    }
  }
  return hits;
}

if (import.meta.main) {
  process.env.VOICE = "plain";
  const i = process.argv.indexOf("--db");
  const path = i > 0 ? process.argv[i + 1] : join(root, "data", "real.db");
  const useFm = localModelsOn() && !process.argv.includes("--no-fm"); // bin/fm only with LOCAL_MODELS=on
  console.log(`local models: ${useFm ? "on (bin/fm for what the rules can't place)" : "off (rules + cache only)"}`);
  const mailRoot = join(root, "data", "real-mail");
  const now = Math.floor(Date.now() / 1000);
  const { mails } = await classifyMailbox(mailRoot, { useFm });
  const count = (xs: RealMail[], f: (m: RealMail) => string) => xs.reduce((acc, m) => ({ ...acc, [f(m)]: (acc[f(m)] ?? 0) + 1 }), {} as Record<string, number>);
  console.log(`mail: ${mails.length} · by path ${JSON.stringify(count(mails, (m) => m.via))} · by kind ${JSON.stringify(count(mails, (m) => m.kind))}`);
  const { db, statements: s, receipts, inWindow, places, matched } = await buildReal(path, mails, mailRoot, now, { useFm });
  console.log(`statements: ${s.files} files (${s.duplicateFiles} duplicate files skipped, ${s.parsed} parsed, ${s.failed} failed) · ${s.accounts} accounts · reconciliation ${s.reconOk} ok / ${s.reconFail} off`);
  console.log(`  rows: ${s.rows} kept · ${s.rowDuplicates} cross-file duplicates · ${s.beforeWindow} outside Aug 1–now · categories via ${JSON.stringify(s.byVia)} · uncategorized ${s.uncategorized}`);
  console.log("  accounts by type:", JSON.stringify(db.query("SELECT type, subtype, COUNT(*) AS n FROM accounts GROUP BY 1, 2").all()));
  const month = "strftime('%Y-%m', ts, 'unixepoch', '-7 hours')";
  console.log("  per month:", JSON.stringify(db.query(`SELECT ${month} AS m, COUNT(*) AS n,
      ROUND(SUM(CASE WHEN category = 'INCOME' THEN -amount_cents ELSE 0 END) / 100.0, 2) AS income,
      ROUND(SUM(CASE WHEN amount_cents > 0 AND COALESCE(category, '') NOT IN ('INCOME','TRANSFER_IN','TRANSFER_OUT','LOAN_PAYMENTS') THEN amount_cents ELSE 0 END) / 100.0, 2) AS spend
    FROM transactions GROUP BY 1 ORDER BY 1`).all()));
  console.log("  where money goes per month ($):", JSON.stringify(db.query(`SELECT ${month} AS m,
      ROUND(SUM(CASE WHEN category = 'LOAN_PAYMENTS' AND amount_cents > 0 THEN amount_cents ELSE 0 END) / 100.0, 2) AS card_payments,
      ROUND(SUM(CASE WHEN a.type = 'credit' AND amount_cents > 0 AND COALESCE(category, '') NOT IN ('LOAN_PAYMENTS','TRANSFER_OUT') THEN amount_cents ELSE 0 END) / 100.0, 2) AS card_purchases,
      ROUND(SUM(CASE WHEN merchant = 'Zelle' AND amount_cents > 0 THEN amount_cents ELSE 0 END) / 100.0, 2) AS zelle_out_as_rent,
      ROUND(SUM(CASE WHEN category = 'TRANSFER_OUT' THEN amount_cents ELSE 0 END) / 100.0, 2) AS transfers_out
    FROM transactions t JOIN accounts a ON a.id = t.account_id GROUP BY 1 ORDER BY 1`).all()));
  const sav = db.query("SELECT COALESCE(SUM(balance_cents), 0) AS c FROM accounts WHERE subtype = 'savings'").get() as { c: number };
  console.log(`  savings balance (latest closing): $${(sav.c / 100).toFixed(2)}`);
  console.log(`receipts: ${receipts.length} after dedupe · ${inWindow.length} in window · ${matched} matched to a card or debit charge`);
  console.log(`  HOME/WORK: ${places.morning} weekday-morning rides · HOME ${places.home ? Math.round(places.home.share * 100) + "%" : "none"} · WORK ${places.work ? Math.round(places.work.share * 100) + "%" : "none"}`);
  const charges = db.query(`SELECT t.merchant AS m, COUNT(*) AS n, SUM(a.receipt_id IS NOT NULL) AS with_receipt FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
    WHERE t.merchant IN ('Uber', 'Uber Eats', 'DoorDash', 'Lyft') AND t.amount_cents > 0 GROUP BY 1`).all();
  console.log("  ride/food charges (with a matched receipt):", JSON.stringify(charges));
  const oct = Math.floor(Date.parse("2026-10-01T00:00:00-07:00") / 1000);
  const commute = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents), 0) AS c FROM transactions t JOIN attributions a ON a.txn_id = t.id JOIN receipts r ON r.id = a.receipt_id
    WHERE r.source = 'uber' AND ((r.pickup_label = 'HOME' AND r.dropoff_label = 'WORK') OR (r.pickup_label = 'WORK' AND r.dropoff_label = 'HOME')) AND t.ts >= ?`).get(oct) as { n: number; c: number };
  console.log(`October commute (matched HOME<->WORK rides): ${commute.n} rides, $${(commute.c / 100).toFixed(2)}`);
  console.log(`address strings outside raw_path/places: ${addressLeaks(db)} (statement merchant names can contain a street; mail text never enters transactions)`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // Replies are checked on a throwaway copy: ticks record nudges (once per day/month) and must not use up real.db's.
  const copy = join(mkdtempSync(join(tmpdir(), "real-report-")), "real.db");
  copyFileSync(path, copy);
  const rdb = openDb(copy);
  const { DEMO_NOW } = await import("./seed");
  const { affordability } = await import("../handlers/finance");
  const { handle: afford } = await import("../handlers/afford");
  for (const [label, at] of [["demo clock 12:00", DEMO_NOW], ["now", now]] as const) {
    const a = affordability(rdb, 40000, at);
    console.log(a ? `afford $400 @ ${label}: ${a.verdict} · paceGap ${a.paceGap} · netMonthly ${a.netMonthly} · savings ${a.savings}\n  ${JSON.stringify((await afford(rdb, "Can I buy a $400 jacket?", { now: at })).text)}` : `afford @ ${label}: no goal`);
  }
  const { MemoryTransport } = await import("../imessage/transport");
  const { noFm } = await import("../imessage/fm");
  const { makeAgent } = await import("../main");
  const tr = new MemoryTransport();
  const agent = makeAgent(rdb, tr, { cli: true, fm: noFm, now: () => DEMO_NOW });
  await tr.start(agent.onText);
  for (const q of ["tick 08:30", "tick 17:30"]) { await tr.receive(q); console.log(`${q}: ${JSON.stringify(tr.sent.splice(0))}`); }
  rdb.close();
}
