// Local privacy gate (the human's design). Before ANY user turn goes to a cloud model, a local PII classifier (Laya,
// goku-san/laya-experts "pii", served by gate/server.py at 127.0.0.1:8089 only) lists the private entities it sees.
// Each one (score ≥ 0.5) becomes a stable symbol saved on the Mac: PERSON_n, ADDR_n, ACCOUNT_n, EMAIL_n, PHONE_n,
// PRIVATE_n; a raw amount becomes "an amount". This runs on top of the DB symbolizer and the name cues, and egress's
// canary still runs last. Fail closed: no key, no service, an error, a timeout (5 s) or invalid output → nothing goes to
// the cloud, and "[gate] …" is logged.
import type { Database } from "bun:sqlite";

export const GATE_URL = "http://127.0.0.1:8089/detect";
/** On CPU, long messages take ~2–3 s to classify: PRIVACY_GATE_TIMEOUT_MS, default 5 s, before failing closed. */
export const gateTimeoutMs = () => { const v = Number(process.env.PRIVACY_GATE_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 5_000; };
export const GATE_MIN_SCORE = 0.5;
export type Entity = { text: string; label: string; score: number; start: number; end: number };
export type Gate = (text: string) => Promise<Entity[]>;
/** The gate failed or refused: the cloud call must not happen. */
export class GateRefused extends Error {}

/** Strict: {entities: [{text, label, score, start, end}], ms?}; anything else throws (fail closed). */
export function parseGate(j: unknown): Entity[] {
  const o = j as { entities?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.entities) || o.entities.length > 200) throw new Error("bad shape");
  return o.entities.map((e) => {
    const x = e as Record<string, unknown>;
    if (!x || typeof x.text !== "string" || typeof x.label !== "string" || typeof x.score !== "number"
      || !Number.isInteger(x.start) || !Number.isInteger(x.end) || (x.end as number) < (x.start as number)) throw new Error("bad entity");
    return { text: x.text, label: x.label, score: x.score, start: x.start as number, end: x.end as number };
  });
}

export const layaGate: Gate = async (text) => {
  const key = process.env.LAYA_GATE_KEY;
  if (!key) throw new Error("LAYA_GATE_KEY is not set");
  const res = await fetch(GATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(gateTimeoutMs()),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGate(await res.json());
};

let override: Gate | null = null;
/** Tests: install a fake gate (null restores the default). */
export function setGate(g: Gate | null) { override = g; cache.clear(); }
/** The gate in force: a test's fake; else the local service, unless PRIVACY_GATE=off or under bun test (tests install fakes). */
export const activeGate = (): Gate | null =>
  override ?? (process.env.PRIVACY_GATE === "off" || process.env.NODE_ENV === "test" ? null : layaGate);

/** Label → symbol family. Dates and times stay (low sensitivity; the planner needs them); unknown labels → PRIVATE. */
export function familyOf(label: string): [kind: string, prefix: string] | "amount" | null {
  const l = label.toLowerCase();
  if (/date|time|age\b|year|month|day/.test(l)) return null;
  if (/e-?mail/.test(l)) return ["gate_email", "EMAIL"];
  if (/phone|mobile|tel\b|fax/.test(l)) return ["gate_phone", "PHONE"];
  if (/amount|money|currency|price|salary|balance|cost/.test(l)) return "amount";
  if (/name|person|per\b|first|last|given|surname|user/.test(l)) return ["person", "PERSON"];
  if (/addr|street|city|state|zip|postal|post_?code|country|location|loc\b|building|place|gpe/.test(l)) return ["gate_addr", "ADDR"];
  if (/card|account|acct|iban|routing|ssn|social|passport|licen[cs]e|tax|\bid\b|_id|id_|number|num\b/.test(l)) return ["gate_account", "ACCOUNT"];
  return ["gate_private", "PRIVATE"];
}

const cache = new Map<string, Entity[]>(); // earlier turns are re-sent each call; classify each text once
const SYMBOL_TOKEN = /\b(?:[A-Z]+_)+\d+\b|\b(?:HOME|WORK)\b/g;
// Gate ADDR symbols start at 101 so they never collide with the symbolizer's per-request ADDR_1, ADDR_2 (qsyms).
const START: Record<string, number> = { ADDR: 100 };

/** A stable symbol (same text → same symbol) in the local symbols table, so replies can restore it. */
function spanSymbol(db: Database, kind: string, prefix: string, text: string): string {
  const have = db.query("SELECT symbol FROM symbols WHERE kind = ? AND lower(real) = lower(?)").get(kind, text) as { symbol: string } | null;
  if (have) return have.symbol;
  let n = Math.max(START[prefix] ?? 0, (db.query("SELECT COUNT(*) AS c FROM symbols WHERE kind = ?").get(kind) as { c: number }).c + (START[prefix] ?? 0));
  while (db.query("SELECT 1 FROM symbols WHERE symbol = ?").get(`${prefix}_${++n}`));
  db.run("INSERT INTO symbols(symbol, real, kind) VALUES (?, ?, ?)", [`${prefix}_${n}`, text, kind]);
  return `${prefix}_${n}`;
}

/** One user turn through the gate. Throws GateRefused on any failure. allow: values the user consented to send. */
export async function gateText(db: Database, gate: Gate, text: string, allow: Set<string> = new Set()): Promise<string> {
  let ents = cache.get(text);
  if (!ents) {
    try { ents = await gate(text); } catch (e) { throw new GateRefused(`unavailable or invalid (${(e as Error).message ?? e})`); }
    if (cache.size > 200) cache.clear();
    cache.set(text, ents);
  }
  // Spans inside a symbol we already placed (the classifier may tag "PERSON_1" as a name) are left alone.
  const symbolRanges = [...text.matchAll(SYMBOL_TOKEN)].map((m) => [m.index!, m.index! + m[0].length]);
  const inSymbol = (s: number, e: number) => symbolRanges.some(([a, b]) => s < b && e > a);
  const spans = ents
    .filter((e) => e.score >= GATE_MIN_SCORE && e.end <= text.length && text.slice(e.start, e.end) === e.text && e.text.trim().length >= 2)
    .filter((e) => !inSymbol(e.start, e.end) && !allow.has(e.text.trim().toLowerCase()) && familyOf(e.label) !== null)
    .sort((a, b) => a.start - b.start);
  // Drop overlaps (keep the earlier span), assign symbols in reading order, then splice from the end.
  const kept: Entity[] = [];
  for (const e of spans) if (!kept.length || e.start >= kept[kept.length - 1].end) kept.push(e);
  const syms = kept.map((e) => { const fam = familyOf(e.label)!; return fam === "amount" ? "an amount" : spanSymbol(db, fam[0], fam[1], e.text.trim()); });
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) out = out.slice(0, kept[i].start) + syms[i] + out.slice(kept[i].end);
  return out;
}
