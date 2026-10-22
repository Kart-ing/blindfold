// Voice v1 (tasks/voice.md): local replies worded by the on-device model, numbers never touched by it.
// The model sees only placeholder names and a wordless situation, returns a template, and the template is validated
// strictly before the Mac fills in the values. Any failure, or VOICE=plain, sends the deterministic fallback.
import { fm as deviceFm, type Fm } from "../imessage/fm.ts";

export type PhraseOpts = { required?: string[]; timeoutMs?: number; fm?: Fm | null };
export type Phrased = { text: string; voiced: boolean };

const MAX_CHARS = 480;
const MAX_LINES = 8;
const PLACEHOLDER = /\{([A-Z][A-Z0-9_]*)\}/g;

// The Persona section of tasks/voice.md, word for word (markdown markers dropped, since markdown is rejected).
const PERSONA = `Persona:
- Who: a sharp friend who's good with money and texts back fast. Warm, never preachy, never shaming ("tight" rather than "you can't").
- Shape:
  - Line 1 is the answer, in 60 chars or fewer (e.g. "Tight, but doable.").
  - Then 1–3 short lines or "•" options.
  - End with at most one offer of a next step the agent can actually do (goal, ledger, privacy, "that was hers", a who-paid answer). Never offer something it can't do.
- Brief and explicit: say what matters and skip filler, with no "Great question", no "I hope this helps", no sign-offs.
- Honest about limits: if it doesn't know, say so in one line and say what would help.
- Money and data: it never acts on money and never shares an exact value without asking first (the consent prompt), the same rule as Hermes's money handshake.
- iMessage-native: plain text, a line break between thoughts, at most one emoji, no markdown.`;

/** Fills {NAME} placeholders from facts; unknown names are left as written. */
export const fill = (template: string, facts: Record<string, string>) =>
  template.replace(PLACEHOLDER, (m, name: string) => (Object.hasOwn(facts, name) ? facts[name] : m));

const placeholdersIn = (t: string) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]);

const BANNED: [RegExp, string][] = [
  [/\bhere'?s\b|\bhere is\b|\bsure\b|\bas an ai\b|\bcertainly\b|\bgreat question\b|\bi hope this helps\b/i, "preamble or filler"],
  [/https?:\/\/|\bwww\./i, "url"],
  [/\*\*|__|`|#/, "markdown"],
];

/** Strict check of a model-written template. Returns the cleaned template or the first reason it was rejected. */
export function validateTemplate(raw: unknown, facts: Record<string, string>, required: string[]):
  { ok: true; template: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  let t = raw.replace(/\r\n?/g, "\n").trim();
  // A template wrapped in quotes is still a template.
  const q = /^["“](.*)["”]$/s.exec(t);
  if (q) t = q[1].trim();
  if (!t) return { ok: false, reason: "empty" };
  if (/\d/.test(t)) return { ok: false, reason: "digit" };
  if (t.includes("$")) return { ok: false, reason: "dollar sign" };
  for (const [re, reason] of BANNED) if (re.test(t)) return { ok: false, reason };
  if (/[{}]/.test(t.replace(PLACEHOLDER, ""))) return { ok: false, reason: "stray brace" };
  for (const name of placeholdersIn(t)) if (!Object.hasOwn(facts, name)) return { ok: false, reason: `unknown placeholder {${name}}` };
  for (const name of required) if (!t.includes(`{${name}}`)) return { ok: false, reason: `missing placeholder {${name}}` };
  if ((t.match(/\p{Extended_Pictographic}/gu) ?? []).length > 1) return { ok: false, reason: "more than one emoji" };
  const text = fill(t, facts);
  if (text.length > MAX_CHARS) return { ok: false, reason: `over ${MAX_CHARS} chars` };
  if (text.split("\n").length > MAX_LINES) return { ok: false, reason: `over ${MAX_LINES} lines` };
  return { ok: true, template: t };
}

// One string: an array-of-lines schema made the on-device model write fragments that dropped facts.
const SCHEMA = {
  type: "object",
  properties: {
    template: {
      type: "string",
      description: "The text message as a template: placeholders like {NAME} where values go, a line break between thoughts. No digits and no $ signs.",
    },
  },
  required: ["template"],
};

/**
 * Guided generation tends to flatten line breaks (seen on-device: "… on track. • Keep it under …"). A one-line
 * template gets one line per sentence and each "•" bullet on its own line, as iMessage reads best.
 */
export function relineate(t: string): string {
  if (t.includes("\n")) return t;
  return t.replace(/\s*•\s*/g, "\n• ").replace(/([.!?])\s+(?=[A-Z{•])/g, "$1\n").replace(/^\n+/, "").split("\n").map((l) => l.trim()).join("\n");
}

/** The model's output as one template; anything malformed becomes null (rejected). */
function templateFrom(out: Record<string, unknown>): unknown {
  if (Array.isArray(out.lines)) {
    if (!out.lines.length || !out.lines.every((l) => typeof l === "string")) return null;
    return (out.lines as string[]).map((l) => l.trim()).filter(Boolean).join("\n");
  }
  return typeof out.template === "string" ? relineate(out.template.trim()) : out.template;
}

function instructions(kind: string, situation: string, names: string[], required: string[], fallback: string) {
  return [
    "You write one iMessage reply for a personal finance agent.",
    PERSONA,
    "Write a TEMPLATE, not the final text. Wherever a value goes, write its placeholder exactly as given, for example {" +
      (names[0] ?? "NAME") + "}. Never write digits, amounts or $ yourself: the phone fills the placeholders in.",
    `Placeholders you may use: ${names.map((n) => `{${n}}`).join(", ") || "none"}.`,
    required.length ? `You must use: ${required.map((n) => `{${n}}`).join(", ")}.` : "",
    `Reply kind: ${kind}.`,
    `Situation: ${situation}`,
    `A correct plain version to rewrite in the persona's voice, keeping every fact: ${fallback}`,
  ].filter(Boolean).join("\n\n");
}

const log = (msg: string) => { if (process.env.NODE_ENV !== "test") console.log(`[voice] ${msg}`); };

/**
 * Words a local reply. `facts` maps placeholder → formatted value; `fallback` uses the same placeholders and is sent
 * (filled) whenever the device wording is off (VOICE=plain), fails, times out, or breaks a validation rule.
 * Under `bun test`, with no fm passed explicitly, it stays on the fallback so tests are deterministic.
 */
export async function phrase(kind: string, situation: string, facts: Record<string, string>, fallback: string,
  opts: PhraseOpts = {}): Promise<Phrased> {
  const plain = fill(fallback, facts);
  // The on-device model words replies only under VOICE=device; cloud (Luna) and plain never touch it.
  const model = opts.fm !== undefined ? opts.fm : process.env.VOICE === "device" && process.env.NODE_ENV !== "test" ? deviceFm : null;
  if (!model || process.env.VOICE !== "device") return { text: plain, voiced: false };
  const required = opts.required ?? [...new Set(placeholdersIn(fallback))];
  const timeoutMs = opts.timeoutMs ?? 6000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      model.extract(instructions(kind, situation, Object.keys(facts), required, fallback), SCHEMA),
      new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); }),
    ]);
    if (out === "timeout") { log(`${kind}: fallback (over ${timeoutMs}ms)`); return { text: plain, voiced: false }; }
    if (!out) { log(`${kind}: fallback (model unavailable)`); return { text: plain, voiced: false }; }
    const v = validateTemplate(templateFrom(out), facts, required);
    if (!v.ok) { log(`${kind}: fallback (${v.reason})`); return { text: plain, voiced: false }; }
    log(`${kind}: on-device`);
    return { text: fill(v.template, facts), voiced: true };
  } catch (e) {
    log(`${kind}: fallback (${(e as Error).message})`);
    return { text: plain, voiced: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
