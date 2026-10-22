// Pure helpers for scripts/rehearse.ts: no side effects, so they can be checked on their own.

export type Beat = { title: string; type: string; expect: string[]; dry: string[]; checks: string[]; voice: Record<number, string[]> };

/** DEMO.md's ```rehearse blocks. `\n` in a value is a line break; `voice:` lists the facts the `expect:` line above it must carry. */
export function parseDemo(md: string): Beat[] {
  const beats: Beat[] = [];
  let title = "";
  for (const block of md.split(/^(?=## |```rehearse)/m)) {
    const h = /^## (.+)$/m.exec(block);
    if (h && block.startsWith("## ")) title = h[1].trim();
    const m = /^```rehearse\n([\s\S]*?)\n```/.exec(block);
    if (!m) continue;
    const b: Beat = { title, type: "", expect: [], dry: [], checks: [], voice: {} };
    for (const line of m[1].split("\n")) {
      const [, key, raw] = /^([a-z-]+):\s?(.*)$/.exec(line) ?? [];
      const val = (raw ?? "").replace(/\\n/g, "\n");
      if (key === "type") b.type = val;
      else if (key === "expect") b.expect.push(val);
      else if (key === "expect-dry") b.dry.push(val);
      else if (key === "voice") b.voice[b.expect.length - 1] = val.split("|").map((s) => s.trim()).filter(Boolean);
      else if (key === "check") b.checks.push(val);
    }
    beats.push(b);
  }
  return beats;
}

/** Exact match, where `*` matches any text (including newlines). */
export const matches = (pattern: string, s: string) =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`).test(s);

/** Planner symbols that must never reach the user's screen (they are swapped for real names on the Mac). */
export const RAW_SYMBOL = /\b(?:MERCHANT|PERSON|ACCOUNT|ADDR)_\d+\b|\bQ_(?:AMT|NUM)_\d+\b/;

const NUMBER = /\$?\d+(?:,\d{3})*(?:\.\d+)?/g;
const PREAMBLE_OR_MARKDOWN = /\bhere['’]?s\b|\bsure\b|\bas an ai\b|\*\*|`|^\s*#|https?:\/\//im;

/** Every number in an expected reply's literal text (the parts around `*` wildcards). */
export const numbersIn = (pattern: string): string[] => [...new Set(pattern.split("*").join(" ").match(NUMBER) ?? [])];

/**
 * --voice-cloud: every reply may be worded by the cloud model, so each one passes on facts only: the beat's `voice:` facts
 * plus every number of the plain reply must be there, nothing the code didn't supply, and no placeholder or symbol left unfilled.
 */
export function cloudFactProblems(reply: string, plain: string, required: string[]): string[] {
  const out = factProblems(reply, plain, [...new Set([...required, ...numbersIn(plain)])]);
  const unfilled = /\{[A-Z_]+\}/.exec(reply)?.[0] ?? RAW_SYMBOL.exec(reply)?.[0];
  if (unfilled) out.push(`unfilled placeholder or symbol: ${unfilled}`);
  return out;
}

/**
 * VOICE=device: a model-phrased reply passes on facts, not wording. Each required fact appears; every number (with its "$")
 * also appears in the plain reply, so the code supplied it; there is no stray "$", preamble or markdown.
 */
export function factProblems(reply: string, plain: string, required: string[]): string[] {
  const out: string[] = [];
  for (const f of required) if (!reply.toLowerCase().includes(f.toLowerCase())) out.push(`missing fact "${f}"`);
  const supplied = new Set(plain.match(NUMBER) ?? []);
  for (const n of reply.match(NUMBER) ?? []) if (!supplied.has(n)) out.push(`number "${n}" was not supplied by the code`);
  if (/\$(?!\d)/.test(reply)) out.push('stray "$"');
  const banned = PREAMBLE_OR_MARKDOWN.exec(reply);
  if (banned) out.push(`preamble or markdown: "${banned[0]}"`);
  return out;
}
