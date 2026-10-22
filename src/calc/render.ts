// Sol's reply template, filled on the Mac (tasks/equations.md): {name} / {name|fmt} placeholders, one level of
// [[if expr]]…[[elif expr]]…[[else]]…[[end]], and symbols (MERCHANT_n, PERSON_n, Q_AMT_n…) filled through a callback.
// The template itself may hold no digit: every number in the reply comes from a computed value.
import { friendlyMonth, friendlyUsd } from "../handlers/afford";
import { CalcError, evalNode, namesIn, own, parse, ptParts } from "./expr";
import { LIMITS, type RenderResult, type Unit, type Vars } from "./types";

export const FORMATS = ["usd", "usd_mo", "months", "when", "day", "month", "pct"] as const;
type Fmt = (typeof FORMATS)[number];
const FITS: Record<Fmt, Unit[]> = {
  usd: ["usd"], usd_mo: ["usd_mo"], months: ["months", "number"], when: ["date"], day: ["date"], month: ["date"], pct: ["number"],
};
export const SYMBOL = /\b(?:MERCHANT|PERSON|ACCOUNT|ADDR|PRIVATE|EMAIL|PHONE)_\d+\b|\bQ_(?:AMT|NUM)_\d+\b/g;

/** Spelled-out numbers would let a template invent amounts ("about forty thousand dollars"); "one" and "half" are prose. */
const NUMBER_WORD = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|grand|dozen)s?\b/i;

type Part = { k: "text"; v: string } | { k: "ph"; name: string; fmt: Fmt | null };
type Branch = { cond: string | null; parts: Part[] };
type Block = { k: "plain"; parts: Part[] } | { k: "if"; branches: Branch[] };

const TAG = /\[\[\s*(if|elif|else|end)\b\s*([^\]]*?)\s*\]\]/g;
const PH = /\{([A-Za-z][A-Za-z0-9_]*)(?:\|([a-z_]+))?\}/g;

function parts(text: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(PH)) {
    out.push({ k: "text", v: text.slice(last, m.index) });
    const fmt = m[2] ?? null;
    if (fmt !== null && !(FORMATS as readonly string[]).includes(fmt)) throw new CalcError(`unknown format ${fmt}`);
    out.push({ k: "ph", name: m[1], fmt: fmt as Fmt | null });
    last = m.index! + m[0].length;
  }
  out.push({ k: "text", v: text.slice(last) });
  return out;
}

function structure(t: string): Block[] {
  if (t.length > LIMITS.template) throw new CalcError(`template longer than ${LIMITS.template} chars`);
  const blocks: Block[] = [];
  let last = 0, open: Branch[] | null = null, sawElse = false;
  const addText = (s: string) => (open ? open[open.length - 1].parts.push(...parts(s)) : blocks.push({ k: "plain", parts: parts(s) }));
  for (const m of t.matchAll(TAG)) {
    addText(t.slice(last, m.index));
    last = m.index! + m[0].length;
    const [, tag, arg] = m;
    if (tag === "if") {
      if (open) throw new CalcError("[[if]] inside [[if]]: one level only");
      if (!arg) throw new CalcError("[[if]] needs a condition");
      open = [{ cond: arg, parts: [] }]; sawElse = false;
    } else if (tag === "elif") {
      if (!open || sawElse) throw new CalcError("[[elif]] outside [[if]] or after [[else]]");
      if (!arg) throw new CalcError("[[elif]] needs a condition");
      open.push({ cond: arg, parts: [] });
    } else if (tag === "else") {
      if (!open || sawElse || arg) throw new CalcError("misplaced [[else]]");
      open.push({ cond: null, parts: [] }); sawElse = true;
    } else {
      if (!open || arg) throw new CalcError("misplaced [[end]]");
      blocks.push({ k: "if", branches: open }); open = null;
    }
  }
  if (open) throw new CalcError("[[if]] without [[end]]");
  addText(t.slice(last));
  return blocks;
}

const texts = (b: Block[]) => b.flatMap((x) => (x.k === "plain" ? [x.parts] : x.branches.map((br) => br.parts))).flat();

/** null = valid. Structure, known names, known formats, parseable conditions, and no digit outside placeholders. */
export function checkTemplate(template: string, names: Set<string>): string | null {
  try {
    const blocks = structure(template);
    for (const p of texts(blocks)) {
      if (p.k === "ph" && !names.has(p.name)) return `unknown placeholder {${p.name}}`;
      if (p.k === "text") {
        const bare = p.v.replace(SYMBOL, "");
        if (/\d/.test(bare)) return `a digit outside a placeholder: "${p.v.trim().slice(0, 40)}"`;
        const word = NUMBER_WORD.exec(bare);
        if (word) return `a number word outside a placeholder: "${word[0]}"`;
        if (bare.includes("$")) return `"$" outside a placeholder (formats add it): "${p.v.trim().slice(0, 40)}"`;
        if (/[{}]|\[\[|\]\]/.test(bare)) return `stray brace or bracket: "${p.v.trim().slice(0, 40)}"`;
      }
    }
    for (const ps of blocks.flatMap((x) => (x.k === "plain" ? [x.parts] : x.branches.map((br) => br.parts))))
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (p.k !== "ph") continue;
        const before = ps[i - 1]?.k === "text" ? (ps[i - 1] as { v: string }).v.slice(-1) : "";
        const after = ps[i + 1]?.k === "text" ? (ps[i + 1] as { v: string }).v.slice(0, 1) : "";
        if (/[$%kK]/.test(before + after)) return `{${p.name}} glued to "${/[$%kK]/.test(before) ? before : after}" (formats own money and percent signs)`;
      }
    for (const b of blocks) if (b.k === "if") for (const br of b.branches) if (br.cond !== null) {
      for (const n of namesIn(parse(br.cond))) if (!names.has(n)) return `unknown name ${n} in a condition`;
    }
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const SHORT_MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
const LONG_MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "long" });

function format(v: { unit: Unit; value: number }, fmt: Fmt | null, today: number | null, name: string): string {
  const f: Fmt | "number" | "bool" = fmt ?? (v.unit === "date" ? "day" : v.unit === "number" ? "number" : v.unit === "bool" ? "bool" : v.unit);
  if (f !== "number" && f !== "bool" && !FITS[f].includes(v.unit)) throw new CalcError(`{${name}|${f}} on a ${v.unit} value`);
  const year = (ts: number) => ptParts(ts).y;
  switch (f) {
    case "usd": return friendlyUsd(Math.round(v.value / 100) * 100);
    case "usd_mo": return `${friendlyUsd(Math.round(v.value / 100) * 100)}/mo`;
    case "months": return (Math.round(v.value * 10) / 10).toFixed(1);
    case "pct": return `${Math.round(v.value * 100)}%`;
    case "number": return String(Math.round(v.value * 10) / 10);
    case "bool": return v.value ? "yes" : "no";
    case "day": return today !== null && year(v.value) !== year(today) ? `${SHORT_MONTH.format(v.value * 1000)}, ${year(v.value)}` : SHORT_MONTH.format(v.value * 1000);
    case "month": return today !== null ? friendlyMonth(v.value, today) : LONG_MONTH.format(v.value * 1000);
    case "when": {
      const { y, d } = ptParts(v.value);
      return `${d <= 10 ? "early" : d <= 20 ? "mid" : "late"}-${LONG_MONTH.format(v.value * 1000)} ${y}`;
    }
  }
}

/** Fills the template from computed values; symbols in its text go through `symbols` (null = unknown → error). */
export function render(template: string, values: Vars, symbols: (s: string) => string | null): RenderResult {
  try {
    const bad = checkTemplate(template, new Set(Object.keys(values)));
    if (bad) return { ok: false, error: bad };
    const today = values.TODAY?.unit === "date" ? values.TODAY.value : null;
    const fill = (ps: Part[]) => ps.map((p) => {
      if (p.k === "ph") return format(values[p.name], p.fmt, today, p.name);
      return p.v.replace(SYMBOL, (s) => symbols(s) ?? (() => { throw new CalcError(`unknown symbol ${s}`); })());
    }).join("");
    let out = "";
    for (const b of structure(template)) {
      if (b.k === "plain") { out += fill(b.parts); continue; }
      const hit = b.branches.find((br) => {
        if (br.cond === null) return true;
        const c = evalNode(parse(br.cond), (n) => own(values, n));
        if (c.unit !== "bool") throw new CalcError(`condition "${br.cond}" isn't yes/no`);
        return c.value !== 0;
      });
      if (hit) out += fill(hit.parts);
    }
    return { ok: true, text: out.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
