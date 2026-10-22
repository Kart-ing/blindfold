// Parsers for the user's own bank and card statements (tasks/statements.md). Pure: text in, rows out. PDF text comes from
// `pdftotext -layout`. Real statements never enter git; tests use synthetic snippets that copy the layouts.
// Convention (as everywhere): amount_cents > 0 is money leaving the account (Plaid), ts is local noon in unix seconds.
import { createHash } from "node:crypto";
import { fromLocal } from "../imessage/clock.ts";

export type StmtAccount = {
  key: string; institution: string; type: "depository" | "credit"; subtype: string; mask: string;
  opening_cents?: number; closing_cents?: number;
};
export type StmtRow = {
  account_key: string; ts: number; posted_ts?: number; amount_cents: number; description: string;
  /** A Plaid PFC primary when the statement makes it unambiguous (card payments, transfers, income, interest, fees); else null. */
  category_hint: string | null;
  /** The bank's own label: the CSV Category, 360's Debit/Credit, or the Citi section. */
  bank_category: string | null;
  page: number; line: number;
};
/** diff_cents = computed − expected (0 when it reconciles; null when a balance is missing). */
export type Recon = { account_key: string; ok: boolean; expected_cents: number | null; computed_cents: number | null; diff_cents: number | null; note: string };
export type Balance = { account_key: string; opening_cents: number; closing_cents: number; period_start?: number; period_end?: number };
export type Statement = {
  source: "capone_csv" | "capone_360_pdf" | "citi_pdf";
  accounts: StmtAccount[]; rows: StmtRow[];
  opening_cents?: number; closing_cents?: number; period_start?: number; period_end?: number;
  /** Per account (a 360 statement covers checking AND savings); Citi: previous → new balance; CSV exports: none. */
  balances: Balance[];
  recon: Recon[];
};

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const noon = (y: number, m: number, d: number) => fromLocal(y, m, d, 12, 0);
/** "$1,285.12" / "1285.12" / "- $7.99" → 128512 / 128512 / -799. */
export function cents(s: string): number {
  const neg = /-/.test(s);
  const v = Math.round(Number(s.replace(/[^\d.]/g, "")) * 100);
  return neg ? -v : v;
}

/** Unambiguous categories from the description alone; merchants are left to the rule table / bin/fm (eng1). */
export function categoryHint(description: string, amount_cents: number): string | null {
  const d = description.toUpperCase();
  if (/CITI CARD ONLINE PAYMENT|CAPITAL ONE (MOBILE|ONLINE|AUTOPAY) (PMT|PYMT|PAYMENT)|CRCARDPMT|CCB PAYMENT|ONLINE PAYMENT,? THANK YOU|AUTOPAY (PAYMENT|PYMT)|PAYMENT - THANK YOU|PAYMENT THANK YOU/.test(d)) return "LOAN_PAYMENTS";
  if (/\b360 (PERFORMANCE )?SAVINGS\b|\b360 CHECKING\b/.test(d) && /TRANSFER|DEPOSIT FROM|WITHDRAWAL TO|WITHDRAWAL FROM 360/.test(d)) return amount_cents > 0 ? "TRANSFER_OUT" : "TRANSFER_IN";
  if (/PAYROLL|DIRECT DEP|DIR DEP|\bSALARY\b/.test(d) && amount_cents < 0) return "INCOME";
  if (/INTEREST PAID|INTEREST EARNED/.test(d) && amount_cents < 0) return "INCOME";
  if (/ZELLE/.test(d) && amount_cents < 0) return "TRANSFER_IN";
  if (/INTEREST CHARGE|LATE FEE|ANNUAL FEE|FOREIGN TRANSACTION FEE|\bFEE\b/.test(d) && amount_cents > 0) return "BANK_FEES";
  return null;
}

/**
 * Same statement, same fingerprint, whatever the file bytes: the bank's re-downloads differ in PDF metadata (the 360
 * Aug/Sep pairs differ in 70 bytes with identical text), so dedupe by this, not by file sha.
 */
export function statementFingerprint(st: Statement): string {
  const canon = { source: st.source, accounts: st.accounts.map((a) => a.key).sort(), period: [st.period_start ?? null, st.period_end ?? null],
    rows: st.rows.map((r) => [r.account_key, r.ts, r.amount_cents, r.description]) };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

// ---------------- Capital One card CSV ----------------

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Header: Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit (ISO dates). No balances, so no recon. */
export function parseCapOneCsv(text: string): Statement {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsv(lines[0] ?? "");
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const c = { td: col("Transaction Date"), pd: col("Posted Date"), card: col("Card No."), desc: col("Description"), cat: col("Category"), debit: col("Debit"), credit: col("Credit") };
  if (Object.values(c).some((i) => i < 0)) throw new Error("not a Capital One card CSV export (unexpected header)");
  const iso = (s: string) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? noon(+m[1], +m[2], +m[3]) : null; };
  const accounts = new Map<string, StmtAccount>();
  const rows: StmtRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = splitCsv(lines[i]);
    const ts = iso(f[c.td] ?? ""), posted = iso(f[c.pd] ?? "");
    if (ts === null) throw new Error(`line ${i + 1}: bad transaction date`);
    const mask = (f[c.card] ?? "").replace(/\D/g, "").slice(-4);
    const key = `capone-card-${mask}`;
    if (!accounts.has(key)) accounts.set(key, { key, institution: "Capital One", type: "credit", subtype: "credit card", mask });
    const amount_cents = f[c.debit] ? cents(f[c.debit]) : f[c.credit] ? -cents(f[c.credit]) : 0;
    const description = f[c.desc] ?? "";
    rows.push({ account_key: key, ts, posted_ts: posted ?? undefined, amount_cents, description,
      category_hint: categoryHint(description, amount_cents), bank_category: f[c.cat] || null, page: 1, line: i + 1 });
  }
  const tss = rows.map((r) => r.ts);
  return { source: "capone_csv", accounts: [...accounts.values()], rows, recon: [], balances: [],
    period_start: tss.length ? Math.min(...tss) : undefined, period_end: tss.length ? Math.max(...tss) : undefined };
}

// ---------------- Capital One 360 combined statement (PDF) ----------------

const M3 = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const AMT = "-?\\s*\\$[\\d,]+\\.\\d{2}";
const PERIOD_360 = new RegExp(`\\b(${M3})\\s+(\\d{1,2})\\s*-\\s*(${M3})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`);
const SECTION_360 = /^\s*(360 [A-Za-z][A-Za-z ]*?)\s+-\s+(\d{6,})\s*$/;
const BAL_360 = new RegExp(`^\\s*(${M3})\\s+(\\d{1,2})\\s+(Opening|Closing) Balance\\s+(${AMT})\\s*$`);
const ROW_360 = new RegExp(`^\\s*(${M3})\\s+(\\d{1,2})\\s{2,}(\\S.*?)\\s{2,}(Debit|Credit)\\s+(?:([+-])\\s*\\$([\\d,]+\\.\\d{2})\\s+)?(${AMT})\\s*$`);
const WRAP_360 = /^\s+(.*?)\s*([+-])\s*\$([\d,]+\.\d{2})\s*$/;

/**
 * Accounts from "360 Checking - <number>" sections; rows from the DATE/DESCRIPTION/CATEGORY/AMOUNT/BALANCE table.
 * Every row's amount is checked against the running balance (and taken from it when the amount wrapped to the next line).
 * Recon per account: opening − Σ amount_cents = closing.
 */
export function parseCapOne360Pdf(text: string): Statement {
  const pm = text.match(PERIOD_360);
  if (!pm) throw new Error("not a Capital One 360 statement (no statement period)");
  const [sm, sd, em, ed, ey] = [MON[pm[1].toLowerCase()], +pm[2], MON[pm[3].toLowerCase()], +pm[4], +pm[5]];
  const crosses = sm > em, sy = crosses ? ey - 1 : ey;
  const dateOf = (mon: string, day: string) => { const m = MON[mon.toLowerCase()]; return noon(crosses && m >= sm ? sy : ey, m, +day); };
  const accounts: StmtAccount[] = [];
  const rows: StmtRow[] = [];
  const state = new Map<string, { balance: number | null; mismatches: number; derived: number }>();
  let acct: StmtAccount | null = null;
  let pending: { row: StmtRow; balance: number } | null = null;
  const pages = text.split("\f");
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const sec = line.match(SECTION_360);
      if (sec) {
        const subtype = /saving/i.test(sec[1]) ? "savings" : "checking";
        const mask = sec[2].slice(-4);
        const key = `capone360-${subtype}-${mask}`;
        acct = accounts.find((a) => a.key === key) ?? null;
        if (!acct) { acct = { key, institution: "Capital One", type: "depository", subtype, mask }; accounts.push(acct); state.set(key, { balance: null, mismatches: 0, derived: 0 }); }
        continue;
      }
      if (!acct) continue;
      const st = state.get(acct.key)!;
      const bal = line.match(BAL_360);
      if (bal) {
        if (bal[3] === "Opening") { acct.opening_cents = cents(bal[4]); st.balance = acct.opening_cents; }
        else acct.closing_cents = cents(bal[4]);
        pending = null;
        continue;
      }
      const r = line.match(ROW_360);
      if (r) {
        const balance = cents(r[7]);
        const derived = st.balance === null ? null : st.balance - balance; // outflow positive
        let amount: number;
        if (r[6] !== undefined) {
          amount = (r[5] === "-" ? 1 : -1) * cents(r[6]);
          if (derived !== null && derived !== amount) st.mismatches++;
          pending = null;
        } else {
          amount = derived ?? 0;
          st.derived++;
        }
        const row: StmtRow = { account_key: acct.key, ts: dateOf(r[1], r[2]), amount_cents: amount, description: r[3].trim(),
          category_hint: null, bank_category: r[4], page: p + 1, line: li + 1 };
        rows.push(row);
        st.balance = balance;
        if (r[6] === undefined) pending = { row, balance };
        continue;
      }
      // A wrapped row's second line: more description, then the signed amount.
      const w = pending ? line.match(WRAP_360) : null;
      if (w && pending) {
        const stated = (w[2] === "-" ? 1 : -1) * cents(w[3]);
        if (stated !== pending.row.amount_cents) st.mismatches++;
        if (w[1].trim()) pending.row.description = `${pending.row.description} ${w[1].trim()}`;
        pending = null;
      }
    }
  }
  for (const r of rows) r.category_hint = categoryHint(r.description, r.amount_cents);
  const recon: Recon[] = accounts.map((a) => {
    const st = state.get(a.key)!;
    const sum = rows.filter((r) => r.account_key === a.key).reduce((s, r) => s + r.amount_cents, 0);
    if (a.opening_cents === undefined || a.closing_cents === undefined)
      return { account_key: a.key, ok: false, expected_cents: a.closing_cents ?? null, computed_cents: null, diff_cents: null, note: "opening or closing balance not found" };
    const computed = a.opening_cents - sum;
    const ok = computed === a.closing_cents && st.mismatches === 0;
    return { account_key: a.key, ok, expected_cents: a.closing_cents, computed_cents: computed, diff_cents: computed - a.closing_cents,
      note: ok ? `opening − rows = closing (${st.derived} amount${st.derived === 1 ? "" : "s"} from the running balance)` : `${st.mismatches} row amount(s) disagree with the running balance; opening − rows ${computed === a.closing_cents ? "=" : "≠"} closing` };
  });
  const single = accounts.length === 1 ? accounts[0] : null;
  const period_start = noon(sy, sm, sd), period_end = noon(ey, em, ed);
  const balances: Balance[] = accounts.filter((a) => a.opening_cents !== undefined && a.closing_cents !== undefined)
    .map((a) => ({ account_key: a.key, opening_cents: a.opening_cents!, closing_cents: a.closing_cents!, period_start, period_end }));
  return { source: "capone_360_pdf", accounts, rows, recon, balances,
    opening_cents: single?.opening_cents, closing_cents: single?.closing_cents, period_start, period_end };
}

// ---------------- Citi card statement (PDF) ----------------

const PERIOD_CITI = /Billing Period:\s*(\d{2})\/(\d{2})\/(\d{2,4})\s*-\s*(\d{2})\/(\d{2})\/(\d{2,4})/;
const SUMMARY_CITI = /(?:^|\s{2,})(Previous balance|Payments|Credits|Purchases|Cash advances|Citi Flex Plans|Balance transfers|Fees|Interest|New balance)\s{2,}([+-]?\$[\d,]+\.\d{2})\s*$/;
const SUMMARY_PARTS = ["Purchases", "Cash advances", "Citi Flex Plans", "Balance transfers", "Fees", "Interest", "Payments", "Credits"];
const ROW_CITI = /^\s*(?:(\d{2})\/(\d{2})\s+)?(\d{2})\/(\d{2})\s{2,}(\S.*?)\s{2,}(-?\$[\d,]+\.\d{2})\s*$/;
/** A dated row whose amount wrapped to a later line ("SECURITY CREDIT…" / "*See Account Messages…  -$10.99"). */
const ROW_CITI_NOAMT = /^\s*(?:(\d{2})\/(\d{2})\s+)?(\d{2})\/(\d{2})\s{2,}(\S.*?)\s*$/;
const CONT_CITI = /^\s+(\S.*?)?\s*(-?\$[\d,]+\.\d{2})\s*$/;
const SECTIONS_CITI: [RegExp, string | null][] = [
  [/^\s*Payments, Credits and Adjustments(, cont'd)?\s*$/, "payments_credits"],
  [/^\s*Standard Purchases(, cont'd)?\s*$/, "purchases"],
  [/^\s*Citi Flex Plan - \d+(, cont'd)?\s*$/, "flex_plan"],
  [/^\s*Fees Charged(, cont'd)?\s*$/, "fees"],
  [/^\s*Interest Charged(, cont'd)?\s*$/, "interest"],
  [/^\s*(\d{4} totals year-to-date|Totals Year-to-Date|Interest charge calculation|Citi Flex Plan details)\b/i, null],
];

/**
 * hint: the year when the text has no billing period (e.g. from the file's folder or mtime).
 * Recon: previous + purchases + cash advances + fees + interest − payments − credits = new (the statement adds up), and
 * previous + Σ parsed rows = new (every row was read).
 */
export function parseCitiPdf(text: string, hint: { year?: number } = {}): Statement {
  const per = text.match(PERIOD_CITI);
  const yr = (s: string) => (s.length === 2 ? 2000 + +s : +s);
  const start = per ? noon(yr(per[3]), +per[1], +per[2]) : undefined;
  const end = per ? noon(yr(per[6]), +per[4], +per[5]) : undefined;
  const endYear = per ? yr(per[6]) : hint.year;
  if (!endYear) throw new Error("Citi statement: no billing period and no year hint");
  // MM/DD → the year that puts it inside (or just before) the billing period.
  const dateOf = (m: string, d: string) => {
    const t = noon(endYear, +m, +d);
    return end !== undefined && t > end + 7 * 86_400 ? noon(endYear - 1, +m, +d) : t;
  };
  const mask = text.match(/Account number ending in:\s*(\d{4})/)?.[1] ?? "????";
  const key = `citi-card-${mask}`;
  const summary: Record<string, number> = {};
  const rows: StmtRow[] = [];
  let section: string | null = null;
  // A dated row still waiting for its amount, and how many continuation lines it has taken.
  let pending: { m: RegExpMatchArray; description: string; page: number; line: number; extra: number } | null = null;
  const push = (m: RegExpMatchArray, description: string, amount: string, page: number, line: number) => {
    const amount_cents = cents(amount);
    rows.push({ account_key: key, ts: m[1] ? dateOf(m[1], m[2]) : dateOf(m[3], m[4]), posted_ts: dateOf(m[3], m[4]), amount_cents, description,
      category_hint: categoryHint(description, amount_cents), bank_category: section, page, line });
  };
  const pages = text.split("\f");
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const s = line.match(SUMMARY_CITI);
      if (s && !(s[1] in summary) && !section) { summary[s[1]] = cents(s[2]); continue; }
      const head = SECTIONS_CITI.find(([re]) => re.test(line));
      if (head) { section = head[1]; pending = null; continue; }
      if (!section) continue;
      const r = line.match(ROW_CITI);
      if (r) { push(r, r[5].trim(), r[6], p + 1, li + 1); pending = null; continue; }
      const d = line.match(ROW_CITI_NOAMT);
      if (d) { pending = { m: d, description: d[5].trim(), page: p + 1, line: li + 1, extra: 0 }; continue; }
      if (!pending || !line.trim() || /^\s*Total\b/i.test(line)) continue;
      const c = line.match(CONT_CITI);
      if (c) { push(pending.m, [pending.description, c[1]?.trim()].filter(Boolean).join(" "), c[2], pending.page, pending.line); pending = null; continue; }
      if (++pending.extra > 3) pending = null; else pending.description += ` ${line.trim()}`;
    }
  }
  const prev = summary["Previous balance"], next = summary["New balance"];
  const recon: Recon[] = [];
  if (prev === undefined || next === undefined) {
    recon.push({ account_key: key, ok: false, expected_cents: next ?? null, computed_cents: null, diff_cents: null, note: "account summary not found" });
  } else {
    const parts = SUMMARY_PARTS.reduce((s, k) => s + (summary[k] ?? 0), 0);
    const rowSum = rows.reduce((s, r) => s + r.amount_cents, 0);
    const adds = prev + parts === next, read = prev + rowSum === next;
    recon.push({ account_key: key, ok: adds && read, expected_cents: next, computed_cents: prev + rowSum, diff_cents: prev + rowSum - next,
      note: adds && read ? "previous + rows = new balance; summary adds up" : `${adds ? "" : "summary doesn't add up; "}${read ? "" : "previous + rows ≠ new balance"}`.replace(/; $/, "") });
  }
  const balances: Balance[] = prev !== undefined && next !== undefined ? [{ account_key: key, opening_cents: prev, closing_cents: next, period_start: start, period_end: end }] : [];
  return { source: "citi_pdf", accounts: [{ key, institution: "Citi", type: "credit", subtype: "credit card", mask }], rows, recon, balances,
    opening_cents: prev, closing_cents: next, period_start: start, period_end: end };
}
