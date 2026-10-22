// Sol's equations, solved on the Mac (tasks/equations.md). A small recursive-descent parser and evaluator with units:
// no eval, no new Function, no property access. Names are variables (VARS, uppercase) or earlier equations (lowercase).
// Money is in cents, dates are unix seconds at PT midnight, months are fractional. Anything odd → { ok: false }.
import { EQ_NAME, LIMITS, VAR_NAME, type Equation, type EvalResult, type Unit, type Vars } from "./types";

export type Val = { unit: Unit; value: number };
type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "name"; v: string }
  | { k: "un"; op: "-" | "!"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; f: string; args: Node[] };

export class CalcError extends Error {}
const fail = (m: string): never => { throw new CalcError(m); };

// ---------- PT calendar ----------

const PT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
/** PT wall-clock parts of a unix time. */
export function ptParts(ts: number): { y: number; m: number; d: number } {
  const p = Object.fromEntries(PT.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}
/** Unix seconds of PT midnight on y-m-d (m 1–12; overflowing days/months roll over). */
export function ptMidnight(y: number, m: number, d: number): number {
  const wall = Date.UTC(y, m - 1, d) / 1000;
  let ts = wall + 8 * 3600;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(PT.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
    const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) / 1000;
    ts += wall - seen;
  }
  return ts;
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Months since year 0 as a fraction: day d of a month counts (d-1)/days of it. */
const monthPos = (ts: number) => { const { y, m, d } = ptParts(ts); return y * 12 + (m - 1) + (d - 1) / daysIn(y, m); };
export const monthsBetween = (a: number, b: number) => monthPos(b) - monthPos(a);
/** Whole months clamp to the month's end (Jan 31 + 1 → Feb 28); a fraction lands that far between two such dates. */
export function addMonths(ts: number, n: number): number {
  const { y, m, d } = ptParts(ts);
  const r = Math.round(n * 1e6) / 1e6; // 0.9999999 from a division is 1
  const whole = Math.floor(r), frac = r - whole;
  const at = (k: number) => {
    const ty = y + Math.floor((m - 1 + k) / 12), tm = (((m - 1 + k) % 12) + 12) % 12 + 1;
    return ptMidnight(ty, tm, Math.min(d, daysIn(ty, tm)));
  };
  const a = at(whole);
  if (!frac) return a;
  const { y: fy, m: fm, d: fd } = ptParts(a + Math.round((frac * (at(whole + 1) - a)) / 86400) * 86400 + 12 * 3600);
  return ptMidnight(fy, fm, fd);
}

// ---------- parser ----------

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|("[^"\n]{0,40}")|(<=|>=|==|!=|&&|\|\||[-+*/()<>!,]))/y;

export function parse(src: string): Node {
  if (src.length > LIMITS.exprChars) fail(`expression longer than ${LIMITS.exprChars} chars`);
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m || m.index !== at) fail(`unexpected character at ${at}`);
    toks.push(m![1] ?? m![2] ?? m![3] ?? m![4]);
  }
  let i = 0, depth = 0;
  const peek = () => toks[i];
  const eat = (t?: string) => { const x = toks[i]; if (x === undefined || (t !== undefined && x !== t)) fail(`expected ${t ?? "more"}, got ${x ?? "end"}`); i++; return x!; };
  const deeper = <T>(f: () => T): T => { if (++depth > LIMITS.depth) fail(`nested deeper than ${LIMITS.depth}`); try { return f(); } finally { depth--; } };
  const binary = (ops: string[], next: () => Node) => (): Node => {
    let a = next();
    while (ops.includes(peek())) { const op = eat(); const b = next(); a = { k: "bin", op, a, b }; }
    return a;
  };
  const primary = (): Node => deeper(() => {
    const t = eat();
    if (t === "(") { const e = or(); eat(")"); return e; }
    if (t === "-" || t === "!") return { k: "un", op: t, a: primary() };
    if (/^\d/.test(t)) return { k: "num", v: Number(t) };
    if (t.startsWith('"')) return { k: "str", v: t.slice(1, -1) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() !== "(") return { k: "name", v: t };
      eat("(");
      const args: Node[] = [];
      if (peek() !== ")") { args.push(or()); while (peek() === ",") { eat(","); args.push(or()); } }
      eat(")");
      return { k: "call", f: t, args };
    }
    return fail(`unexpected ${t}`);
  });
  const mul = binary(["*", "/"], primary);
  const add = binary(["+", "-"], mul);
  const cmp = binary(["<", "<=", ">", ">=", "==", "!="], add);
  const and = binary(["&&"], cmp);
  const or: () => Node = binary(["||"], and);
  const tree = or();
  if (i < toks.length) fail(`unexpected ${toks[i]}`);
  return tree;
}

/** Every name an expression reads (for validation before evaluating). */
export function namesIn(n: Node, out = new Set<string>()): Set<string> {
  if (n.k === "name") out.add(n.v);
  else if (n.k === "un") namesIn(n.a, out);
  else if (n.k === "bin") { namesIn(n.a, out); namesIn(n.b, out); }
  else if (n.k === "call") n.args.forEach((a) => namesIn(a, out));
  return out;
}

// ---------- evaluator ----------

const MONEY = new Set<Unit>(["usd", "usd_mo"]);
const ok = (unit: Unit, value: number): Val => (Number.isFinite(value) ? { unit, value } : fail("result is not a finite number"));

function arith(op: string, a: Val, b: Val): Val {
  if (a.unit === "bool" || b.unit === "bool") fail(`${op} on a yes/no value`);
  if (op === "+" || op === "-") {
    if (a.unit === "date" || b.unit === "date") fail(`${op} on a date (use add_months / months_between / days_between)`);
    if (a.unit !== b.unit) fail(`${a.unit} ${op} ${b.unit}`);
    return ok(a.unit, op === "+" ? a.value + b.value : a.value - b.value);
  }
  if (a.unit === "date" || b.unit === "date") fail(`${op} on a date`);
  if (op === "*") {
    if (a.unit === "number") return ok(b.unit, a.value * b.value);
    if (b.unit === "number") return ok(a.unit, a.value * b.value);
    if ((a.unit === "usd_mo" && b.unit === "months") || (a.unit === "months" && b.unit === "usd_mo")) return ok("usd", a.value * b.value);
    return fail(`${a.unit} * ${b.unit}`);
  }
  if (b.value === 0) fail("division by zero");
  const v = a.value / b.value;
  if (b.unit === "number") return ok(a.unit, v);
  if (a.unit === b.unit) return ok("number", v);
  if (a.unit === "usd" && b.unit === "usd_mo") return ok("months", v);
  if (a.unit === "usd" && b.unit === "months") return ok("usd_mo", v);
  return fail(`${a.unit} / ${b.unit}`);
}

const want = (v: Val, u: Unit, f: string) => (v.unit === u ? v.value : fail(`${f} needs ${u}, got ${v.unit}`));

function call(f: string, args: Val[], raw: Node[]): Val {
  const n = (k: number) => (raw.length === k ? true : fail(`${f} takes ${k} argument${k === 1 ? "" : "s"}`));
  switch (f) {
    case "min": case "max": {
      if (!args.length) fail(`${f} needs arguments`);
      if (args.some((a) => a.unit !== args[0].unit || a.unit === "bool")) fail(`${f} needs one unit`);
      return ok(args[0].unit, (f === "min" ? Math.min : Math.max)(...args.map((a) => a.value)));
    }
    case "round": case "floor": case "ceil": case "abs": {
      n(1);
      const a = args[0];
      if (a.unit === "date" || a.unit === "bool") fail(`${f} on ${a.unit}`);
      const g = Math[f];
      return ok(a.unit, MONEY.has(a.unit) && f !== "abs" ? g(a.value / 100) * 100 : g(a.value)); // money: to whole dollars
    }
    case "months_between": n(2); return ok("months", monthsBetween(want(args[0], "date", f), want(args[1], "date", f)));
    case "days_between": n(2); return ok("number", Math.round((want(args[1], "date", f) - want(args[0], "date", f)) / 86400));
    case "add_months": {
      n(2);
      const m = args[1].unit === "months" || args[1].unit === "number" ? args[1].value : fail(`add_months needs months, got ${args[1].unit}`);
      if (Math.abs(m) > 1200) fail("add_months: more than 100 years");
      return ok("date", addMonths(want(args[0], "date", f), m));
    }
    case "month_start": { n(1); const { y, m } = ptParts(want(args[0], "date", f)); return ok("date", ptMidnight(y, m, 1)); }
    case "next_month_start": { n(1); const { y, m } = ptParts(want(args[0], "date", f)); return ok("date", ptMidnight(y, m + 1, 1)); }
    case "date": {
      n(1);
      const s = raw[0].k === "str" ? raw[0].v : fail('date needs a string like "2027-01-01"');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > daysIn(+m[1], +m[2])) fail(`bad date "${s}"`);
      return ok("date", ptMidnight(+m![1], +m![2], +m![3]));
    }
    default: return fail(`unknown function ${f}`);
  }
}

/** Own keys only: "constructor" or "__proto__" must never resolve to something on Object.prototype. */
export const own = (values: Vars, name: string) => (Object.hasOwn(values, name) ? values[name] : undefined);

export function evalNode(n: Node, lookup: (name: string) => Val | undefined): Val {
  switch (n.k) {
    case "num": return ok("number", n.v);
    case "str": return fail("a string outside date()");
    case "name": return lookup(n.v) ?? fail(`unknown name ${n.v}`);
    case "un": {
      const a = evalNode(n.a, lookup);
      if (n.op === "!") return a.unit === "bool" ? ok("bool", a.value ? 0 : 1) : fail("! needs a yes/no value");
      return a.unit === "date" || a.unit === "bool" ? fail(`- on ${a.unit}`) : ok(a.unit, -a.value);
    }
    case "call": return call(n.f, n.f === "date" ? [] : n.args.map((a) => evalNode(a, lookup)), n.args);
    case "bin": {
      const a = evalNode(n.a, lookup), b = evalNode(n.b, lookup);
      if (n.op === "&&" || n.op === "||") {
        if (a.unit !== "bool" || b.unit !== "bool") fail(`${n.op} needs yes/no values`);
        return ok("bool", n.op === "&&" ? +(a.value && b.value) : +(a.value || b.value));
      }
      if (["<", "<=", ">", ">=", "==", "!="].includes(n.op)) {
        if (a.unit !== b.unit) fail(`comparing ${a.unit} with ${b.unit}`);
        const r = { "<": a.value < b.value, "<=": a.value <= b.value, ">": a.value > b.value, ">=": a.value >= b.value, "==": a.value === b.value, "!=": a.value !== b.value }[n.op]!;
        return ok("bool", r ? 1 : 0);
      }
      return arith(n.op, a, b);
    }
  }
}

/** Evaluates one expression against values (no side effects). */
export function evalExpr(src: string, values: Vars): Val {
  return evalNode(parse(src), (name) => own(values, name));
}

/** Runs the equations in order; each may use the variables and earlier equations. */
export function evaluate(eqs: Equation[], vars: Vars): EvalResult {
  try {
    if (eqs.length > LIMITS.equations) fail(`more than ${LIMITS.equations} equations`);
    const values: Vars = { ...vars };
    for (const [name, v] of Object.entries(vars)) if (!VAR_NAME.test(name) || !Number.isFinite(v.value)) fail(`bad variable ${name}`);
    for (const eq of eqs) {
      if (!EQ_NAME.test(eq.name)) fail(`bad equation name ${eq.name}`);
      if (Object.hasOwn(values, eq.name)) fail(`${eq.name} is defined twice`);
      try { values[eq.name] = evalExpr(eq.expr, values); }
      catch (e) { fail(`${eq.name}: ${(e as Error).message}`); }
    }
    return { ok: true, values };
  } catch (e) {
    if (e instanceof CalcError) return { ok: false, error: e.message };
    return { ok: false, error: `internal: ${(e as Error).message}` };
  }
}
