// Leak canary: every real value in SQLite (plus raw receipt addresses), scanned against each outbound payload.
import type { Database } from "bun:sqlite";
import { knownPeople, receiptAddresses } from "../ingest/receipts.ts";
import { BILL_WORDS_RAW, addressForms, buildSymbols, herOnlyMerchants, merchantForms, personForms, symbolFor } from "./symbolize.ts";
import { COMMON, EVERYDAY, GENERIC, canon, findKey, key, normToken, tokens } from "./normalize.ts";

/** Text forms of an amount. Bare whole dollars only for >= $100: small bare integers false-positive ("3 months"). */
export function amountForms(cents: number): string[] {
  const c = Math.abs(Math.round(cents));
  if (c === 0) return [];
  const d = (c / 100).toFixed(2);
  const forms = [d, `$${d}`, d.replace(".", ",")];
  if (String(c).length >= 3) forms.push(String(c)); // 4312; skip 1-2 digit cent counts
  // "$28", "$43", "$44": $-prefixed whole dollars for every amount (the $ makes them unambiguous).
  for (const whole of new Set([Math.floor(c / 100), Math.round(c / 100)])) if (whole > 0) forms.push(`$${whole}`, `$${whole.toLocaleString("en-US")}`);
  if (c >= 10_000) {
    for (const whole of new Set([Math.floor(c / 100), Math.round(c / 100)])) {
      const comma = whole.toLocaleString("en-US");
      forms.push(String(whole), `$${whole}`, comma, `$${comma}`, `$${comma}.${d.slice(-2)}`);
    }
  }
  return [...new Set(forms)];
}

/** Memo forms: the memo, plus its long digit-free fragments (so symbolizing a phone number inside it doesn't hide it). */
function memoForms(memo: string): string[] {
  const forms = [memo.trim()];
  for (const frag of memo.split(/\d{4,}|[+()]/)) if (frag.trim().length >= 16) forms.push(frag.trim());
  // Distinctive single words ("concert", "ski"): not everyday words, not the payment app.
  for (const w of memo.split(/[^\p{L}\p{N}'’]+/u)) if (w.length >= 3 && !/\d/.test(w) && !EVERYDAY.has(normToken(w)) && !/^(venmo|zelle)$/i.test(w)) forms.push(w);
  // "Venmo – Priya – concert tix": the free-text parts survive symbolizing the person and merchant.
  for (const frag of memo.split(/\s+[–—-]\s+|[,;:|]/)) if (frag.trim().split(/\s+/).length >= 2) forms.push(frag.trim());
  return forms;
}

/** Every value of every *_cents column in every table (goals, receipt subtotals, balances, ...), found from the schema. */
export function allCents(db: Database): number[] {
  const out = new Set<number>();
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    // Names come from sqlite_master, quoted as identifiers; no user input reaches this SQL.
    const cols = (db.query(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as { name: string }[]).map((c) => c.name).filter((n) => /_cents$/.test(n));
    for (const c of cols) {
      for (const r of db.query(`SELECT DISTINCT "${c.replace(/"/g, '""')}" AS v FROM "${t.replace(/"/g, '""')}" WHERE "${c.replace(/"/g, '""')}" IS NOT NULL`).all() as { v: number }[]) {
        if (typeof r.v === "number" && r.v !== 0) out.add(Math.abs(Math.round(r.v)));
      }
    }
  }
  return [...out];
}

export function sensitiveValues(db: Database): string[] {
  const out = new Set<string>();
  const col = (sql: string) => (db.query(sql).all() as { v: string | number | null }[]).map((r) => r.v).filter((v) => v !== null && v !== "");
  // Full name, name without a store number, and 2+ word prefixes ("Whole Foods").
  for (const m of col("SELECT DISTINCT merchant AS v FROM transactions")) {
    for (const f of merchantForms(String(m))) out.add(f);
    // "mint bill", "whole charge": a stoplisted first word plus a billing word.
    const first = String(m).trim().split(/\s+/);
    if (first.length > 1 && COMMON.has(normToken(first[0])) && !GENERIC.has(normToken(first[0]))) for (const w of BILL_WORDS_RAW) out.add(`${first[0]} ${w}`);
  }
  for (const m of col("SELECT DISTINCT mask AS v FROM accounts")) out.add(String(m));
  for (const p of knownPeople(db)) for (const f of personForms(p)) out.add(f);
  // Her-only merchants are out of scope even as symbols.
  buildSymbols(db);
  for (const m of herOnlyMerchants(db)) { const sym = symbolFor(db, "merchant", m); if (sym) out.add(sym); }
  for (const a of [...col("SELECT address AS v FROM places") as string[], ...receiptAddresses(db)]) for (const f of addressForms(a)) out.add(f);
  for (const m of col("SELECT DISTINCT memo AS v FROM transactions")) for (const f of memoForms(String(m))) out.add(f);
  for (const c of allCents(db)) for (const f of amountForms(c)) out.add(f);
  return [...out].filter((v) => v.length >= 2);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, token-boundary match of every value (plus a normalized match for text values). Returns the values found (never logged anywhere but locally). */
export function scan(payload: string, values: string[]): { checked: number; hits: string[] } {
  const hits: string[] = [];
  payload = canon(payload);
  const hay = payload.toLowerCase();
  const toks = tokens(payload);
  for (const v of values) {
    // Text values also match normalized: "BLUEBOTTLE", "trader joes", "uber-eats", "1 market st".
    if (/[a-z]/i.test(v) && findKey(toks, key(v)).length) { hits.push(v); continue; }
    // The raw form and its JSON-escaped form (a memo with quotes appears escaped in a serialized payload).
    const needles = new Set([v.toLowerCase(), JSON.stringify(v).slice(1, -1).toLowerCase()]);
    for (const needle of needles) {
      if (!hay.includes(needle)) continue; // fast path
      if (new RegExp(`(?<![a-z0-9])${escapeRe(needle)}(?![a-z0-9])`).test(hay)) { hits.push(v); break; }
    }
  }
  return { checked: values.length, hits };
}
