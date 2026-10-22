// The variables table for Sol (names, units, descriptions; never values) and the values it stands for (local only).
// Sol writes equations over these names; the Mac evaluates them on the real numbers.
import type { Database } from "bun:sqlite";
import type { Unit, VarDef, Vars } from "./types.ts";
import { activeGoal, DAY, isSpend, MY_SHARE, netMonthlyCents, ptMonthStart, savingsCents, manualAssetsCents, totalsBetween } from "../handlers/finance.ts";
import { localParts } from "../imessage/clock.ts";
import { symbolizeText } from "../cloud/symbolize.ts";
import { listFacts } from "../memory/facts.ts";

const ACCOUNT_SHARE = `CASE WHEN owner = 'her' THEN 0.0 WHEN shared = 1 OR owner = 'shared' THEN 0.5 ELSE 1.0 END`;
const one = <T>(db: Database, sql: string, ...p: any[]): T | null => { try { return db.query(sql).get(...p) as T | null; } catch { return null; } };

/** The complete months the averages use: up to the last 3, only those the history covers (as netMonthlyCents). */
function completeMonths(db: Database, now: number): { start: number; end: number }[] {
  const first = one<{ t: number | null }>(db, "SELECT MIN(ts) AS t FROM transactions")?.t ?? null;
  if (first === null) return [];
  const p = localParts(now);
  const out: { start: number; end: number }[] = [];
  for (let k = 1; k <= 3; k++) {
    const start = ptMonthStart(p.y, p.m - 1 - k), end = ptMonthStart(p.y, p.m - k);
    if (first > start + 3 * DAY) break;
    out.push({ start, end });
  }
  return out;
}

/** My-share spend by category, averaged over the complete months. */
function categoryMonthly(db: Database, months: { start: number; end: number }[]): Map<string, number> {
  const by = new Map<string, number>();
  if (!months.length) return by;
  for (const { start, end } of months) {
    const rows = db.query(`SELECT t.amount_cents AS c, t.category AS cat, t.merchant AS m, acc.type AS acct, ${MY_SHARE} AS share
        FROM transactions t JOIN accounts acc ON acc.id = t.account_id LEFT JOIN attributions a ON a.txn_id = t.id
        WHERE t.ts >= ? AND t.ts < ?`).all(start, end) as { c: number; cat: string | null; m: string | null; acct: string; share: number }[];
    for (const r of rows) if (isSpend(r.cat, r.m, r.acct)) by.set(r.cat ?? "OTHER", (by.get(r.cat ?? "OTHER") ?? 0) + r.c * r.share);
  }
  for (const [k, v] of by) by.set(k, Math.round(v / months.length));
  return by;
}

/**
 * Five fixed groups, the same names in the same order for every user (a list built from what's present would tell
 * the cloud "this person has medical spending"). Absent groups are 0 locally. RENT_MO is the rent group.
 */
const GROUPS: [string, string, string[]][] = [
  ["RENT_MO", "avg monthly rent and utilities", ["RENT_AND_UTILITIES"]],
  ["CAT_FOOD_MO", "avg monthly food and drink", ["FOOD_AND_DRINK"]],
  ["CAT_SHOPPING_MO", "avg monthly shopping, personal care, home, fun", ["GENERAL_MERCHANDISE", "PERSONAL_CARE", "HOME_IMPROVEMENT", "ENTERTAINMENT"]],
  ["CAT_TRANSPORT_MO", "avg monthly transport and travel", ["TRANSPORTATION", "TRAVEL"]],
  ["CAT_OTHER_MO", "avg monthly other spending; may be negative (refunds)", []],
];
export const GROUP_NAMES = GROUPS.map((g) => g[0]);
/** Sent descriptions stay short (Sol's latency grows with the prompt). */
export const DESC_MAX = 60;
const WORDS = ["zero", "one", "two", "three"];

export type VarTable = { defs: VarDef[]; vars: Vars };

/**
 * @param qsyms the message's amounts (Q_AMT_n → cents), from the symbolizer.
 */
export function varDefs(db: Database, now: number, qsyms: Record<string, string> = {}): VarTable {
  const defs: VarDef[] = [];
  const vars: Vars = {};
  const add = (name: string, unit: Unit, value: number, desc: string) => {
    if (!Number.isFinite(value)) return;
    defs.push({ name, unit, desc: desc.length > DESC_MAX ? `${desc.slice(0, DESC_MAX - 1)}…` : desc });
    vars[name] = { unit, value };
  };

  add("TODAY", "date", now, "today's date");
  // Savings accounts only (share-weighted); told balances are ASSET_n, checking is CHECKING: Sol decides what counts.
  add("SAVINGS", "usd", savingsCents(db) - manualAssetsCents(db), "savings accounts balance, latest statements");
  const chk = one<{ s: number | null; asof: number | null }>(db, `SELECT SUM(balance_cents * ${ACCOUNT_SHARE}) AS s,
      (SELECT MAX(l.period_end) FROM ingest_log l JOIN accounts a2 ON a2.id = l.account_id WHERE a2.subtype = 'checking') AS asof
      FROM accounts WHERE type = 'depository' AND subtype = 'checking'`);
  if (chk?.s !== null && chk?.s !== undefined) {
    add("CHECKING", "usd", Math.round(chk.s), "checking balance on its last statement (may be stale)");
    const asof = chk.asof ?? one<{ t: number | null }>(db, "SELECT MAX(t.ts) AS t FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'checking'")?.t;
    if (asof) add("CHECKING_ASOF", "date", asof, "date of the CHECKING balance");
  }
  const assets = (() => { try { return db.query("SELECT name, amount_cents AS c FROM manual_assets ORDER BY id").all() as { name: string; c: number }[]; } catch { return []; } })();
  assets.forEach((a, i) => {
    // The name goes out as its symbol (or not at all), never as text.
    const sym = symbolizeText(db, a.name).text.trim();
    const label = /^[A-Z]+_\d+$/.test(sym) ? ` (at ${sym})` : "";
    add(`ASSET_${i + 1}`, "usd", a.c, `balance the user told us about${label}`);
  });

  const months = completeMonths(db, now);
  if (months.length) {
    const tot = months.reduce((acc, m) => { const t = totalsBetween(db, m.start, m.end); return { i: acc.i + t.income, s: acc.s + t.spend }; }, { i: 0, s: 0 });
    const n = months.length;
    // No digits in descs (they're dropped before sending): the month count is a word.
    const span = `last ${WORDS[n]} full month${n === 1 ? "" : "s"}`;
    add("INCOME_MO", "usd_mo", Math.round(tot.i / n), `avg monthly income, ${span}`);
    add("SPEND_MO", "usd_mo", Math.round(tot.s / n), `avg monthly spending incl. rent, ${span}`);
    add("NET_MO", "usd_mo", netMonthlyCents(db, now), "INCOME_MO minus SPEND_MO");
    const raw = categoryMonthly(db, months);
    const sums = new Map<string, number>(GROUPS.map((g) => [g[0], 0]));
    for (const [c, v] of raw) {
      const g = GROUPS.find((x) => x[2].includes(c)) ?? GROUPS.at(-1)!;
      sums.set(g[0], sums.get(g[0])! + v);
    }
    for (const [name, desc] of GROUPS) add(name, "usd_mo", sums.get(name)!, desc);
  }

  const g = activeGoal(db);
  if (g) {
    add("GOAL_TARGET", "usd", g.target_cents, "active savings goal amount");
    add("GOAL_DEADLINE", "date", g.deadline, "the goal's deadline");
    add("GOAL_CREATED", "date", g.created_ts, "when the goal was set");
    add("GOAL_START_SAVINGS", "usd", g.savings_at_creation_cents, "savings when the goal was set (not progress)");
  }

  for (const f of listFacts(db)) add(f.name, f.unit, f.value, `fact: ${f.desc}`);

  for (const [sym, v] of Object.entries(qsyms))
    if (/^Q_AMT_\d+$/.test(sym) && /^-?\d+$/.test(v)) add(sym, "usd", Number(v), "amount written in the new message");

  return { defs, vars };
}
