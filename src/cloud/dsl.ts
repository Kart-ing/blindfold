// Query-plan DSL: a strict whitelist validator and a parameterized executor. Plan values are only ever SQL parameters;
// every SQL string below is a fixed literal chosen by key, never built from plan text.
import type { Database } from "bun:sqlite";
import { fromLocal, localParts } from "../imessage/clock.ts";

export const CATEGORIES = [
  "INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "BANK_FEES", "ENTERTAINMENT", "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE", "HOME_IMPROVEMENT", "MEDICAL", "PERSONAL_CARE", "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT", "TRANSPORTATION", "TRAVEL", "RENT_AND_UTILITIES",
];
const NON_SPEND = ["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"];
export const OPS = ["sum", "count", "avg_monthly", "group_by", "top_n", "balance", "recurring", "project", "compare", "diff", "divide"] as const;
export type Op = (typeof OPS)[number];
export const MAX_STEPS = 10;
export const MAX_TEMPLATE = 300;

export type Filter = {
  category?: string | string[]; month?: string; months?: number; direction?: "inflow" | "outflow";
  account_type?: "depository" | "credit"; merchant_sym?: string | string[];
};
export const CMPS = ["gt", "gte", "lt", "lte"] as const;
export type Cmp = (typeof CMPS)[number];
export type Step = { id: string; op: Op; filter?: Filter; by?: "category" | "merchant_sym" | "month"; inputs?: string[]; n?: number; months?: number; cmp?: Cmp };
export type Plan = { steps: Step[]; answer_template: string; disclose?: string[]; clarify?: true };
export type Kind = "cents" | "count" | "bool" | "list" | "months" | "ratio";
export type ListItem = { key: string; cents: number };
export type Value = { kind: "cents" | "count" | "months" | "ratio"; v: number } | { kind: "bool"; v: boolean } | { kind: "list"; v: ListItem[]; signed?: boolean };

const STEP_ID = /^s\d{1,2}$/;
// Only question amounts can enter arithmetic; Q_NUM (phone numbers, counts, ids) never does.
const QAMT = /^Q_AMT_\d{1,3}$/;
const MERCHANT_SYM = /^MERCHANT_\d{1,5}$/;
const MONTH_REL = /^M-(\d|1[0-2])$/;
const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// Allowed step fields per op, and what each op produces / consumes.
const FIELDS: Record<Op, string[]> = {
  sum: ["filter"], count: ["filter"], avg_monthly: ["filter"], group_by: ["filter", "by"], top_n: ["inputs", "n"],
  balance: ["filter"], recurring: ["filter"], project: ["inputs", "months"], compare: ["inputs", "cmp"], diff: ["inputs"], divide: ["inputs"],
};
const OUT: Record<Op, Kind> = {
  sum: "cents", count: "count", avg_monthly: "cents", group_by: "list", top_n: "list", balance: "cents",
  recurring: "list", project: "cents", compare: "bool", diff: "cents", divide: "ratio",
};
const FILTER_KEYS: Record<Op, string[]> = {
  sum: ["category", "month", "months", "direction", "account_type", "merchant_sym"],
  count: ["category", "month", "months", "direction", "account_type", "merchant_sym"],
  avg_monthly: ["category", "months", "direction", "account_type", "merchant_sym"],
  group_by: ["category", "month", "months", "direction", "account_type", "merchant_sym"],
  balance: ["account_type"], recurring: ["months"], top_n: [], project: [], compare: [], diff: [], divide: [],
};

function validFilter(op: Op, f: unknown): string | null {
  if (typeof f !== "object" || f === null || Array.isArray(f)) return "filter must be an object";
  for (const [k, v] of Object.entries(f)) {
    if (!FILTER_KEYS[op].includes(k)) return `filter key ${JSON.stringify(k)} not allowed for ${op}`;
    if (k === "category") {
      const cats = Array.isArray(v) ? v : [v];
      if (!cats.length || cats.length > 8 || !cats.every((c) => typeof c === "string" && CATEGORIES.includes(c.toUpperCase()))) return "unknown category";
    } else if (k === "merchant_sym") {
      const ms = Array.isArray(v) ? v : [v];
      if (!ms.length || ms.length > 8 || !ms.every((m) => typeof m === "string" && MERCHANT_SYM.test(m))) return "merchant_sym must be MERCHANT_n";
    } else if (k === "month") { if (typeof v !== "string" || !MONTH_REL.test(v)) return "month must be M-0..M-12"; }
    else if (k === "months") { if (!isInt(v, 1, 12)) return "months must be an integer 1-12"; }
    else if (k === "direction") { if (v !== "inflow" && v !== "outflow") return "direction must be inflow|outflow"; }
    else if (k === "account_type") { if (v !== "depository" && v !== "credit") return "account_type must be depository|credit"; }
  }
  if ("month" in f && "months" in f) return "use month or months, not both";
  return null;
}

/** Placeholders allowed in answer_template: {s1}, {s1:a|b}, {Q_AMT_1}. Any other brace is rejected. */
const PLACEHOLDER = /\{(s\d{1,2})(?::([^{}|]{0,40})\|([^{}|]{0,40}))?\}|\{(Q_(?:AMT|NUM)_\d{1,3})\}/g;

export function templateError(t: unknown, kinds: Map<string, Kind>): string | null {
  if (typeof t !== "string") return "answer_template must be a string";
  if (t.length > MAX_TEMPLATE) return `answer_template over ${MAX_TEMPLATE} chars`;
  for (const m of t.matchAll(PLACEHOLDER)) {
    if (m[4]) continue;
    const k = kinds.get(m[1]);
    if (!k) return `template references unknown step ${m[1]}`;
    if (m[2] !== undefined && k !== "bool") return `{${m[1]}:a|b} needs a compare step`;
    if (m[2] === undefined && k === "bool") return `compare step ${m[1]} needs {${m[1]}:yes|no}`;
  }
  if (/[{}]/.test(t.replace(PLACEHOLDER, ""))) return "answer_template has a brace that is not a placeholder";
  return null;
}

export type Validated = { ok: true; plan: Plan } | { ok: false; error: string };

/** Strict whitelist. Returns a cleaned copy (only known fields) or the first error. */
export function validatePlan(plan: unknown): Validated {
  const bad = (error: string): Validated => ({ ok: false, error });
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return bad("plan must be an object");
  const p = plan as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!["steps", "answer_template", "disclose", "clarify"].includes(k)) return bad(`unknown plan key ${JSON.stringify(k)}`);
  // Not a money question: the planner says so instead of chatting. Only this exact shape may have no steps.
  if (p.clarify !== undefined) {
    const emptyDisclose = p.disclose === undefined || (Array.isArray(p.disclose) && p.disclose.length === 0);
    if (p.clarify !== true || !Array.isArray(p.steps) || p.steps.length !== 0 || p.answer_template != null || !emptyDisclose)
      return bad("a clarify plan needs clarify true, empty steps, a null answer_template and nothing else");
    return { ok: true, plan: { steps: [], answer_template: "", disclose: [], clarify: true } };
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) return bad("steps must be a non-empty array, or clarify true for a non-money message");
  if (p.steps.length > MAX_STEPS) return bad(`at most ${MAX_STEPS} steps`);
  const kinds = new Map<string, Kind>();
  // Units: "cents" | "count" for scalars, "list:<dimension>" for lists. Arithmetic needs matching units.
  const units = new Map<string, string>();
  const unitOf = (id: string) => (QAMT.test(id) ? "cents" : units.get(id));
  const rates = new Set<string>(); // per-month amounts: avg_monthly, and diffs of two of them (net monthly savings)
  const steps: Step[] = [];
  for (const raw of p.steps) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("each step must be an object");
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string" || !STEP_ID.test(s.id)) return bad("step id must look like s1");
    if (kinds.has(s.id)) return bad(`duplicate step id ${s.id}`);
    if (typeof s.op !== "string" || !(OPS as readonly string[]).includes(s.op)) return bad(`unknown op ${JSON.stringify(s.op)}`);
    const op = s.op as Op;
    for (const k of Object.keys(s)) if (k !== "id" && k !== "op" && !FIELDS[op].includes(k)) return bad(`field ${JSON.stringify(k)} not allowed for ${op}`);
    if (s.filter !== undefined) { const e = validFilter(op, s.filter); if (e) return bad(`${s.id}: ${e}`); }
    if (op === "group_by" && !["category", "merchant_sym", "month"].includes(s.by as string)) return bad(`${s.id}: by must be category|merchant_sym|month`);
    if (op === "top_n" && !isInt(s.n, 1, 10)) return bad(`${s.id}: n must be an integer 1-10`);
    if (op === "project" && !isInt(s.months, 1, 24)) return bad(`${s.id}: months must be an integer 1-24`);
    // compare's operator; omitted means gte (back-compat), but plans should always say which.
    if (op === "compare" && s.cmp !== undefined && !(CMPS as readonly string[]).includes(s.cmp as string)) return bad(`${s.id}: cmp must be gt|gte|lt|lte`);
    let unit: string | undefined;
    if (FIELDS[op].includes("inputs")) {
      const want = op === "top_n" ? 1 : 2;
      if (!Array.isArray(s.inputs) || s.inputs.length !== want) return bad(`${s.id}: ${op} takes ${want} input(s)`);
      const us: string[] = [];
      for (const inp of s.inputs) {
        // Only earlier steps: this also rules out cycles and self-reference.
        if (typeof inp !== "string") return bad(`${s.id}: inputs must be strings`);
        if (/^Q_NUM_/.test(inp)) return bad(`${s.id}: Q_NUM_n is not an amount; only Q_AMT_n can be used in arithmetic`);
        const u = unitOf(inp);
        if (!u) return bad(`${s.id}: input ${JSON.stringify(inp)} is not an earlier step or Q_AMT symbol`);
        us.push(u);
      }
      const isList = (u: string) => u.startsWith("list:");
      if (op === "top_n") {
        if (!isList(us[0])) return bad(`${s.id}: top_n needs a list`);
        unit = us[0];
      } else if (op === "diff") {
        if (us[0] !== us[1]) return bad(`${s.id}: diff needs matching units (${us[0]} vs ${us[1]})`);
        unit = us[0];
        if (isList(unit)) kinds.set(s.id, "list");
      } else if (op === "compare") {
        if (isList(us[0]) || us[0] !== us[1]) return bad(`${s.id}: compare needs two numbers of the same unit (${us[0]} vs ${us[1]})`);
        unit = "bool";
      } else if (op === "project") {
        if (us[0] !== "cents" || us[1] !== "cents") return bad(`${s.id}: project needs cents inputs (base, monthly change)`);
        unit = "cents";
      } else if (op === "divide") {
        // An amount ÷ a monthly amount is a number of months (runway); amount ÷ amount or count ÷ count is a ratio.
        if (isList(us[0]) || isList(us[1]) || us[0] !== us[1] || !["cents", "count"].includes(us[0])) return bad(`${s.id}: divide needs two amounts or two counts`);
        const [a, b] = s.inputs as string[];
        unit = us[0] === "cents" && rates.has(b) && !rates.has(a) ? "months" : "ratio";
        kinds.set(s.id, unit as Kind);
      }
      if (op === "diff" && (s.inputs as string[]).every((i) => rates.has(i))) rates.add(s.id);
    } else {
      unit = op === "group_by" ? `list:${s.by}` : op === "recurring" ? "list:merchant_sym" : OUT[op];
    }
    if (op === "avg_monthly") rates.add(s.id);
    units.set(s.id, unit!);
    if (!kinds.has(s.id)) kinds.set(s.id, OUT[op]);
    const step: Step = { id: s.id, op };
    for (const k of FIELDS[op]) if (s[k] !== undefined) (step as any)[k] = s[k];
    steps.push(step);
  }
  const te = templateError(p.answer_template, kinds);
  if (te) return bad(te);
  const disclose = p.disclose ?? [];
  if (!Array.isArray(disclose) || disclose.length > MAX_STEPS || !disclose.every((d) => typeof d === "string" && kinds.has(d))) return bad("disclose must list step ids");
  return { ok: true, plan: { steps, answer_template: p.answer_template as string, disclose: [...new Set(disclose as string[])] } };
}

// ---------- executor ----------

/** [start, end) unix seconds of local month M-k relative to now. */
export function monthRange(now: number, k: number): [number, number] {
  const p = localParts(now);
  const idx = p.y * 12 + (p.m - 1) - k;
  const y = Math.floor(idx / 12), m = (idx % 12) + 1;
  const ny = Math.floor((idx + 1) / 12), nm = ((idx + 1) % 12) + 1;
  return [fromLocal(y, m, 1), fromLocal(ny, nm, 1)];
}
const monthLabel = (ts: number) => { const p = localParts(ts); return `${p.y}-${String(p.m).padStart(2, "0")}`; };

type Where = { sql: string[]; params: (string | number)[] };

/** Builds a WHERE from fixed fragments; plan values only ever become parameters. */
function where(f: Filter = {}, now: number, wholeMonths = false): Where {
  const w: Where = { sql: [], params: [] };
  let cats = f.category === undefined ? null : (Array.isArray(f.category) ? f.category : [f.category]).map((c) => c.toUpperCase());
  // Unqualified inflow means income; transfers and refunds only when asked for by category.
  if (f.direction === "inflow" && !cats) cats = ["INCOME"];
  if (cats) { w.sql.push(`t.category IN (${cats.map(() => "?").join(",")})`); w.params.push(...cats); }
  if (f.direction === "inflow") w.sql.push("t.amount_cents < 0");
  else {
    w.sql.push("t.amount_cents > 0");
    // Spend excludes transfers, card payments and income unless a category was asked for explicitly.
    if (!cats) { w.sql.push(`COALESCE(t.category, '') NOT IN (${NON_SPEND.map(() => "?").join(",")})`); w.params.push(...NON_SPEND); }
  }
  if (f.account_type) { w.sql.push("acct.type = ?"); w.params.push(f.account_type); }
  if (f.merchant_sym !== undefined) {
    const ms = Array.isArray(f.merchant_sym) ? f.merchant_sym : [f.merchant_sym];
    w.sql.push(`t.merchant IN (SELECT real FROM symbols WHERE kind = 'merchant' AND symbol IN (${ms.map(() => "?").join(",")}))`);
    w.params.push(...ms);
  }
  let start: number, end: number;
  if (f.month) [start, end] = monthRange(now, Number(f.month.slice(2)));
  else if (wholeMonths) { start = monthRange(now, f.months ?? 3)[0]; end = monthRange(now, 0)[0]; } // last n complete months
  else { start = monthRange(now, (f.months ?? 1) - 1)[0]; end = now + 1; } // this month back n-1 months, through now
  w.sql.push("t.ts >= ?", "t.ts < ?", "t.ts <= ?");
  w.params.push(start, end, now);
  return w;
}

const FROM = `FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id LEFT JOIN accounts acct ON acct.id = t.account_id`;
const AMT = (f?: Filter) => (f?.direction === "inflow" ? "-t.amount_cents" : "t.amount_cents");
/**
 * My integer cents of one transaction, the single allocation every aggregate sums: me all, her none,
 * shared floor(half) to me (the odd cent is hers). Same ownership as finance.MY_SHARE, but in whole cents so
 * sum, group_by and recurring always reconcile. Amounts reaching here are positive, so SQLite's / truncates = floor.
 */
const MINE = (amt: string) => `CASE COALESCE(a.owner, 'me') WHEN 'her' THEN 0 WHEN 'shared' THEN (${amt}) / 2 ELSE (${amt}) END`;
const COUNTS = `COALESCE(a.owner, 'me') != 'her'`;

export type ExecResult = Record<string, Value>;

export function executePlan(db: Database, plan: Plan, ctx: { now: number }, qvals: Record<string, string> = {}): ExecResult {
  const r: ExecResult = {};
  const scalar = (id: string): number => {
    if (QAMT.test(id)) {
      // A symbol the question never had is an error, never a silent zero.
      const v = qvals[id];
      if (v === undefined || !/^-?\d+$/.test(v)) throw new Error(`${id} has no value from the question`);
      return Number(v);
    }
    const v = r[id];
    if (!v || (v.kind !== "cents" && v.kind !== "count" && v.kind !== "months" && v.kind !== "ratio")) throw new Error(`step ${id} is not a number`);
    return v.v;
  };
  const one = (sql: string, params: (string | number)[]) => (db.query(sql).get(...params) as { v: number | null }).v ?? 0;
  const rateIds = new Set<string>();
  for (const s of plan.steps) {
    if (s.op === "avg_monthly" || (s.op === "diff" && s.inputs!.every((x) => rateIds.has(x)))) rateIds.add(s.id);
    const f = s.filter;
    switch (s.op) {
      case "sum": case "count": {
        const w = where(f, ctx.now);
        const agg = s.op === "sum" ? `SUM(${MINE(AMT(f))})` : `SUM(CASE WHEN ${COUNTS} THEN 1 ELSE 0 END)`;
        r[s.id] = { kind: s.op === "sum" ? "cents" : "count", v: one(`SELECT ${agg} AS v ${FROM} WHERE ${w.sql.join(" AND ")}`, w.params) };
        break;
      }
      case "avg_monthly": {
        const w = where(f, ctx.now, true);
        const total = one(`SELECT SUM(${MINE(AMT(f))}) AS v ${FROM} WHERE ${w.sql.join(" AND ")}`, w.params);
        r[s.id] = { kind: "cents", v: Math.round(total / (f?.months ?? 3)) };
        break;
      }
      case "group_by": {
        const w = where(f, ctx.now);
        // Fixed key expressions; her-only groups (my share 0) are dropped so they never appear even as symbols.
        const keyExpr = s.by === "category" ? "COALESCE(t.category, 'OTHER')" : s.by === "month" ? "t.ts" : "COALESCE(sym.symbol, 'MERCHANT_UNKNOWN')";
        const join = s.by === "merchant_sym" ? "LEFT JOIN symbols sym ON sym.kind = 'merchant' AND sym.real = t.merchant" : "";
        const rows = db.query(`SELECT ${keyExpr} AS k, ${MINE(AMT(f))} AS v ${FROM} ${join} WHERE ${w.sql.join(" AND ")}`).all(...w.params) as { k: string | number; v: number }[];
        const acc = new Map<string, number>();
        for (const row of rows) {
          const key = s.by === "month" ? monthLabel(row.k as number) : String(row.k);
          acc.set(key, (acc.get(key) ?? 0) + row.v);
        }
        r[s.id] = { kind: "list", v: [...acc].map(([key, cents]) => ({ key, cents })).filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents) };
        break;
      }
      case "top_n": {
        const v = r[s.inputs![0]];
        if (v?.kind !== "list") throw new Error("top_n needs a list");
        r[s.id] = { kind: "list", v: v.v.slice(0, s.n), signed: v.signed };
        break;
      }
      case "balance": {
        // Accounts that are mine; a shared account counts half (floor), hers not at all.
        // credit balance_cents is the amount owed. One type → that type's total; no type → net worth (assets minus debt).
        const share = "CASE owner WHEN 'her' THEN 0 ELSE CASE shared WHEN 1 THEN COALESCE(balance_cents, 0) / 2 ELSE COALESCE(balance_cents, 0) END END";
        const total = (type: string) => one(`SELECT SUM(${share}) AS v FROM accounts WHERE type = ?`, [type]);
        // Balances the user told us about (a brokerage, cash) count as cash, like savingsCents in finance.ts.
        let manual = 0;
        try { manual = one("SELECT SUM(amount_cents) AS v FROM manual_assets", []); } catch { /* no table yet */ }
        r[s.id] = { kind: "cents", v: f?.account_type === "credit" ? total("credit") : f?.account_type === "depository" ? total("depository") + manual : total("depository") + manual - total("credit") };
        break;
      }
      case "recurring": {
        // A merchant I paid in at least 3 of the last n months (default 6) with amounts within 20% of their median.
        const months = f?.months ?? 6;
        const w = where({ months }, ctx.now);
        const rows = db.query(`SELECT COALESCE(sym.symbol, 'MERCHANT_UNKNOWN') AS k, t.ts AS ts, ${MINE("t.amount_cents")} AS v ${FROM}
            LEFT JOIN symbols sym ON sym.kind = 'merchant' AND sym.real = t.merchant WHERE ${w.sql.join(" AND ")}`).all(...w.params) as { k: string; ts: number; v: number }[];
        const by = new Map<string, { ts: number; v: number }[]>();
        for (const row of rows) if (row.v > 0) by.set(row.k, [...(by.get(row.k) ?? []), row]);
        const out: ListItem[] = [];
        for (const [key, xs] of by) {
          const monthsSeen = new Set(xs.map((x) => monthLabel(x.ts))).size;
          const sorted = xs.map((x) => x.v).sort((a, b) => a - b);
          const mid = sorted.length >> 1;
          const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          if (monthsSeen >= 3 && xs.length <= monthsSeen * 2 && sorted.every((v) => Math.abs(v - med) <= med * 0.2)) out.push({ key, cents: Math.round(med) });
        }
        r[s.id] = { kind: "list", v: out.sort((a, b) => b.cents - a.cents) };
        break;
      }
      case "project": r[s.id] = { kind: "cents", v: scalar(s.inputs![0]) + scalar(s.inputs![1]) * s.months! }; break;
      case "diff": {
        const [a, b] = [r[s.inputs![0]], r[s.inputs![1]]];
        if (a?.kind === "list" && b?.kind === "list") {
          // Per-key change a - b, biggest moves first (either direction).
          const acc = new Map<string, number>(a.v.map((x) => [x.key, x.cents]));
          for (const x of b.v) acc.set(x.key, (acc.get(x.key) ?? 0) - x.cents);
          r[s.id] = { kind: "list", signed: true, v: [...acc].map(([key, cents]) => ({ key, cents })).filter((x) => x.cents !== 0).sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents)) };
        } else r[s.id] = { kind: "cents", v: scalar(s.inputs![0]) - scalar(s.inputs![1]) };
        break;
      }
      case "divide": {
        // The validator already settled the unit; recompute "is the divisor a monthly rate" the same way.
        const [x, y] = [scalar(s.inputs![0]), scalar(s.inputs![1])];
        const months = rateIds.has(s.inputs![1]) && !rateIds.has(s.inputs![0]) && r[s.inputs![1]]?.kind === "cents";
        r[s.id] = { kind: months ? "months" : "ratio", v: y <= 0 ? Infinity : Math.max(0, x) / y };
        break;
      }
      case "compare": {
        const [x, y] = [scalar(s.inputs![0]), scalar(s.inputs![1])];
        const cmp = s.cmp ?? "gte";
        r[s.id] = { kind: "bool", v: cmp === "gt" ? x > y : cmp === "gte" ? x >= y : cmp === "lt" ? x < y : x <= y };
        break;
      }
    }
  }
  return r;
}
