// Luna: the cloud does the talking, the Mac does the math (the human's design; tasks/voice.md for the voice).
// Two calls, both through egress (symbols only, the canary, ledger meta), on the converse model (egress.ts: the configured
// GPT-6.1 Sol unless a setting names Luna), low reasoning, JSON only, a 6 s timeout (understand 9 s):
// - understand(): a message (plus up to 4 prior turns) → at most four whitelisted actions over symbols;
// - phrase(): a reply written as a template of {PLACEHOLDER} names that the caller fills locally.
// A canary block, an error, a timeout or any invalid output returns null, and the caller uses its local path.
import type { Database } from "bun:sqlite";
import type { LedgerMeta } from "../handlers/types.ts";
import { converseModel, egress } from "./egress.ts";
import { desymbolize, extractJson } from "./plan.ts";
import { realFor, symbolizeText } from "./symbolize.ts";
import { localParts } from "../imessage/clock.ts";

export const CONVERSE_TIMEOUT_MS = 6_000;
export const MAX_ACTIONS = 4;
// Latency: both calls use "low", the lowest effort GPT-6.1 Sol accepts (it rejects "none" and "minimal"); phrase also gets
// a small token budget. Tunable by env without new code: gpt-6-luna also takes "none" (live 2.9 s vs 5.2 s at "low"),
// and the add_asset backstop covers the action "none" is likeliest to drop.
const understandReasoning = () => process.env.LUNA_UNDERSTAND_REASONING || "low";
const phraseReasoning = () => process.env.LUNA_PHRASE_REASONING || "low";
const PHRASE_MAX_TOKENS = 600;
/** understand() reads a whole message plus history: a live long message took 6.6 s, so it gets more room than phrase(). */
export const UNDERSTAND_TIMEOUT_MS = 9_000;
/** LUNA_UNDERSTAND_MS overrides it (Sol at low effort: 6–9 s live on long messages). */
const understandTimeout = () => Number(process.env.LUNA_UNDERSTAND_MS) || UNDERSTAND_TIMEOUT_MS;

/** Prior turns, symbolized or not: both are symbolized again here, and quantities renamed PRIOR_*. */
export type Turn = { role: "user" | "assistant"; text: string; /** an assistant turn: what it answered ("runway", "afford", …) */ intent?: string };
export type Intent = "afford" | "spend_query" | "goal_status" | "other";
/** The message's main intent, top level, so the router can skip on-device classification. */
export const INTENTS = ["afford", "spend", "goal_status", "runway", "research", "question", "none"] as const;
export type MessageIntent = (typeof INTENTS)[number];
/** Labels an assistant turn may carry (the router's or understand's intent names); anything else goes unlabeled. */
const ANSWER_LABELS = new Set<string>(["afford", "spend", "spend_query", "goal_status", "goal_set", "runway", "research", "question", "other"]);
const RUNWAY_WORDS = /\b(?:runway|lo+se? my (?:job|income)|lost my (?:job|income)|income stops?|how long would|months could I|survive|deplete|last me)\b/i;
export type Action =
  /** by null: no deadline given; keep the current goal's deadline. */
  | { type: "set_goal"; amount: string; amount_cents: number; by: string | null }
  | { type: "add_asset"; name: string; name_real: string; amount: string; amount_cents: number }
  | { type: "remember"; text: string; text_real: string }
  | { type: "ask"; intent: Intent }
  | { type: "chat" };

export const UNDERSTAND_PROMPT = `You read a text message sent to a personal finance assistant and decide what the assistant should do. You never see real data: merchants, people and places appear as symbols (MERCHANT_n, PERSON_n, HOME, WORK), and amounts or numbers as Q_AMT_n / Q_NUM_n. Earlier turns, if given, are context only; act on the new message.
Reply with ONLY a JSON object: {"intent": "...", "actions": [...]}. intent is what the message mainly is: "afford" (can I buy or afford something), "spend" (how much I spent), "goal_status" (am I on track), "runway" (how long my savings would last without income: losing a job or income, income stopping, "will I survive", "how many months", spending savings down to zero; hypotheticals like "say my income stops…" count), "research" (what a product or service is like: its reviews, whether it's worth it, "what's a good …"; still research when a price is given), "question" (any other money question) or "none" (no question: news, context, thanks). A message that disputes or corrects a number in the last answer ("I'm already at … no?") has that answer's intent; assistant turns may be labeled with it, like [runway answer]. At most four actions, each one of:
- {"type": "set_goal", "amount": "Q_AMT_n", "by": "<the month as the user said it, e.g. December>"}: the user states or changes a savings goal ("change", "lower" or "raise the goal to" count). Leave out "by" when no deadline is given; the current one is kept.
- {"type": "add_asset", "name": "<one or two plain words, or the symbol as given>", "amount": "Q_AMT_n"}: any amount the user says they hold somewhere the assistant can't see ("I have", "I've got", "there's" an amount in an app, bank, brokerage or cash). Always emit it, even inside a message that also sets a goal. Money in the user's own checking or savings accounts is not an asset: the assistant already sees those. Neither is money still to come (a paycheck, a refund).
- {"type": "remember", "text": "<a short note in the user's words, symbols kept as they are>"}: lasting context worth keeping, like recurring costs (rent, bills), visa or job dates, plans and preferences. Not hypotheticals ("say …", "if …", "what if …"): those are questions. No digits outside symbols.
- {"type": "ask", "intent": "afford" | "spend_query" | "goal_status" | "other"}: the user asks a question.
- {"type": "chat"}: anything else, like thanks or small talk.
Amounts are always Q_AMT symbols from the new message, never written out. Never invent a symbol.
Give "by" as a month name, plus the year if the user said one; for the end of a year, give December.`;

export const PHRASE_PROMPT = `You write one text message from a personal finance assistant to its user. Voice: a sharp, warm friend texting. The answer goes first, then at most one concrete next step, in short lines. Plain text only: no markdown, "•" only for lists, no "Sure", no "Here's", no sign-off.
A next step may only be something the user can text the assistant: "goal" (the full plan), "ledger" (what left the Mac), "privacy", "memories", "remember …", a money question to ask, or 1, 2 or 3 to answer a who-paid question. Never offer anything else (no settings, targets or changes it cannot make).
You never see numbers. Write a placeholder like {GOAL} exactly where a value goes, using only the names you are given, each of them at least once. Never write a digit or a dollar sign yourself.
Never ask the user for something their message already says.
Reply with ONLY a JSON object: {"text": "..."}.`;

const SYMBOL = /\b(?:MERCHANT|ACCOUNT|PERSON|ADDR|EMAIL|PHONE|PRIVATE|Q_AMT|Q_NUM|PRIOR_AMT|PRIOR_NUM|PRIOR_ADDR)_\d+\b|\b(?:HOME|WORK)\b/g;
const MONTHS = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)(\s+\d{4})?$/i;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "December", "dec 2026", "end of 2026", "end of June", "2026-12", "EOY" → "December" / "December 2026" / "June"; else null. */
export function normalizeBy(by: string, now = Math.floor(Date.now() / 1000)): string | null {
  if (/^(?:by\s+)?(?:the\s+)?(?:end\s+of\s+(?:the\s+|this\s+)?year|year[\s-]?end|eoy)$/i.test(by.trim())) return `December ${localParts(now).y}`;
  const b = by.trim().replace(/^(?:by\s+)?(?:the\s+)?end\s+of\s+/i, "");
  if (MONTHS.test(b)) return b;
  if (/^20\d\d$/.test(b)) return `December ${b}`;
  const ym = b.match(/^(20\d\d)-(0[1-9]|1[0-2])$/);
  return ym ? `${MONTH_NAMES[+ym[2] - 1]} ${ym[1]}` : null;
}

/** An asset name: plain words, or a symbol that maps to something real on this Mac (a merchant, or a capitalized name
 * the symbolizer couldn't place, like "Robinhood" → PERSON_n). */
const assetName = (db: Database, name: string) =>
  /^[A-Za-z][A-Za-z .&'-]{0,39}$/.test(name) || (/^(?:MERCHANT|PRIVATE|PERSON)_\d+$/.test(name) && realFor(db, name) !== null);

/** "I have (like) Q_AMT_3 in savings in Robinhood": a held balance the model must not drop (live miss, eng-2's backstop). */
const HELD = /\b(?:I\s+have|I've\s+got|I\s+got|I\s+own|there's|there\s+is)\s+(?:like\s+|about\s+|around\s+|roughly\s+|approx(?:imately)?\s+|~\s*)?(Q_AMT_\d+)\s+(?:in\s+(?:savings|cash|stocks|my\s+savings|the\s+invested\s+amount)\s+)?(?:in|on|at|with)\s+(?:my\s+|the\s+)?((?:MERCHANT|PRIVATE|PERSON)_\d+|[A-Za-z][A-Za-z.&'-]{1,30})/gi;

const OWN_ACCOUNTS = /^(?:checking|savings?|account|bank|card|credit|debit)$/i;

/** The user turn sent for a symbolized message, kept so phrase() reuses the exact text (the gate's cache then hits). */
const turns = new Map<string, string>();
const log = (what: string, total: number, res: { timing?: { gate_ms: number; send_ms: number } } | null) =>
  console.log(`[luna] ${what} ${total} ms (gate ${res?.timing?.gate_ms ?? 0} ms, model ${res?.timing?.send_ms ?? 0} ms)`);

const textOf = (resp: unknown) => {
  const c = (resp as { content?: { type: string; text?: string }[] })?.content;
  return Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text ?? "").join("") : "";
};
const meta = (questionSym: string, res: { error?: string; body: string; canary: { checked: number; hits: string[] } }): LedgerMeta => ({
  question_sym: questionSym, payload_json: res.error === "blocked" ? "[]" : res.body,
  canary_checked: res.canary.checked, canary_hits: res.canary.hits.length, exact_disclosed: 0, partial_count: 0,
});

/** Strict whitelist over the model's JSON. Any unknown type, extra key, foreign symbol or digit → null (the whole reply). */
/**
 * sent: the symbolized text we sent (message + history). A note may repeat digit words from it ("October 30th",
 * "2 months"): the user typed them, they already left as typed, and amounts were symbolized before that.
 * An invalid action is dropped on its own; the result is null only when nothing valid is left.
 */
export function validateActions(raw: unknown, qsyms: Record<string, string>, db: Database, now?: number, sent = ""): Action[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "actions" && k !== "intent") || !Array.isArray(r.actions) || !r.actions.length || r.actions.length > MAX_ACTIONS) return null;
  if (r.intent !== undefined && !(INTENTS as readonly string[]).includes(r.intent as string)) return null;
  const amt = (a: unknown) => typeof a === "string" && /^Q_AMT_\d+$/.test(a) && a in qsyms;
  const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);
  const out: Action[] = [];
  for (const x of r.actions) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    const a = x as Record<string, unknown>;
    const noBy = a.by === undefined || a.by === null;
    if (a.type === "set_goal" && Object.keys(a).every((k) => ["type", "amount", "by"].includes(k)) && amt(a.amount)
      && (noBy || (typeof a.by === "string" && normalizeBy(a.by, now)))) {
      out.push({ type: "set_goal", amount: a.amount as string, amount_cents: Number(qsyms[a.amount as string]), by: noBy ? null : normalizeBy(a.by as string, now)! });
    } else if (a.type === "add_asset" && only(a, ["type", "name", "amount"]) && amt(a.amount) && typeof a.name === "string"
      && assetName(db, a.name)) {
      out.push({ type: "add_asset", name: a.name, name_real: desymbolize(db, a.name, qsyms), amount: a.amount as string, amount_cents: Number(qsyms[a.amount as string]) });
    } else if (a.type === "remember" && only(a, ["type", "text"]) && typeof a.text === "string" && a.text.trim().length > 0 && a.text.length <= 240
      && !/\$/.test(a.text) && digitWordsSent(a.text.replace(SYMBOL, ""), sent) && !/\b(?:PRIOR_\w+)\b/.test(a.text)
      && (a.text.match(SYMBOL) ?? []).every((s) => /^(HOME|WORK)$/.test(s) || s in qsyms || realFor(db, s) !== null)) {
      out.push({ type: "remember", text: a.text.trim(), text_real: desymbolize(db, a.text.trim(), qsyms) });
    } else if (a.type === "ask" && only(a, ["type", "intent"]) && ["afford", "spend_query", "goal_status", "other"].includes(a.intent as string)) {
      out.push({ type: "ask", intent: a.intent as Intent });
    } else if (a.type === "chat" && only(a, ["type"])) {
      out.push({ type: "chat" });
    } // anything else: this action is dropped
  }
  return out.length ? out : null;
}

/** Every word with a digit in it (outside symbols) appears, as a word, in what we sent. */
function digitWordsSent(text: string, sent: string): boolean {
  const said = new Set((sent.replace(SYMBOL, " ").match(/[\p{L}\p{N}'’]*\d[\p{L}\p{N}'’]*/gu) ?? []).map((w) => w.toLowerCase()));
  return (text.match(/[\p{L}\p{N}'’]*\d[\p{L}\p{N}'’]*/gu) ?? []).every((w) => said.has(w.toLowerCase()));
}

/** The last four turns, symbolized again, quantities renamed PRIOR_* (never usable as this message's values); her turns dropped. */
export function priorLines(db: Database, history: Turn[]): string[] {
  let n = 0;
  return history.slice(-4).map((t) => {
    const s = symbolizeText(db, t.text);
    if (s.hers.length) return null;
    const renamed = s.text.replace(/\b(Q_AMT|Q_NUM|ADDR)_\d+\b/g, (_m, k: string) => `PRIOR_${k === "Q_AMT" ? "AMT" : k === "Q_NUM" ? "NUM" : "ADDR"}_${++n}`);
    const label = t.role === "assistant" && t.intent && ANSWER_LABELS.has(t.intent) ? ` [${t.intent} answer]` : "";
    return `${t.role === "user" ? "User" : `Assistant${label}`}: ${renamed}`;
  }).filter((l): l is string => l !== null);
}

/** Message (+ up to 4 prior turns) → actions. History goes in OUR user turn, so the canary scans every word of it. */
export async function understand(db: Database, text: string, history: Turn[], ctx: { now: number }):
  Promise<{ actions: Action[]; intent: MessageIntent | null; qsyms: Record<string, string>; symbolized: string; ledger: LedgerMeta } | null> {
  const { text: symbolized, qsyms, hers } = symbolizeText(db, text);
  if (hers.length) return null; // her data never leaves, not even as symbols
  const prior = priorLines(db, history);
  const content = `${prior.length ? `Earlier turns, oldest first:\n${prior.join("\n")}\n\n` : ""}New message: ${symbolized}`;
  if (turns.size > 50) turns.clear();
  turns.set(symbolized, content);
  const t0 = performance.now();
  try {
    const res = await egress(db, { system: UNDERSTAND_PROMPT, messages: [{ role: "user", content }], model: converseModel(), json: true, reasoning: understandReasoning() },
      { timeoutMs: understandTimeout() });
    log("understand", Math.round(performance.now() - t0), res);
    // Something was attempted (sent, or stopped by the canary): always hand back the ledger meta, with no actions on a
    // block, an error, a timeout or invalid output, so the router can record it. null means nothing was attempted.
    if (!res.ok && res.error !== "blocked" && !res.sent) return null; // refused before the wire (no key, test guard)
    const raw = res.ok ? extractJson(textOf(res.response)) : null;
    const actions = (raw ? validateActions(raw, qsyms, db, ctx.now, content) : null) ?? [];
    const it = (raw as { intent?: unknown } | null)?.intent;
    const intent = actions.length && (INTENTS as readonly string[]).includes(it as string) ? (it as MessageIntent) : null;
    // Backstop: a held balance the text states plainly is never lost, even if the model only saw the goal.
    if (res.ok) for (const m of symbolized.matchAll(HELD)) {
      if (actions.length >= MAX_ACTIONS || actions.some((a) => a.type === "add_asset" && a.amount === m[1]) || !(m[1] in qsyms) || !assetName(db, m[2])) continue;
      if (OWN_ACCOUNTS.test(m[2])) continue; // "6k in my checking": an account the assistant already sees, not an outside asset
      actions.push({ type: "add_asset", name: m[2], name_real: desymbolize(db, m[2], qsyms), amount: m[1], amount_cents: Number(qsyms[m[1]]) });
    }
    return { actions, intent, qsyms, symbolized, ledger: meta(symbolized, res) };
  } catch {
    return null;
  }
}

/** A template over {NAME} placeholders; digits, $, unknown or missing names, markdown or preambles → null. */
export function templateOk(t: unknown, names: string[], required: string[] = names): t is string {
  if (typeof t !== "string" || !t.trim() || t.length > 480 || t.split("\n").length > 8) return false;
  const used = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (used.some((u) => !names.includes(u)) || required.some((r) => !used.includes(r))) return false;
  const rest = t.replace(/\{[A-Z_]+\}/g, "");
  return !/[\d$]|[{}]/.test(rest) && !/\*\*|^\s*#|`|https?:\/\/|www\.|\bhere'?s\b|\bsure\b|as an ai/im.test(rest);
}

/**
 * Reply wording with placeholder NAMES only (no values leave); the caller validates again and fills locally.
 * The user's message goes as its own turn, the exact text understand() sent, so the gate classifies it once.
 * After any real attempt the ledger comes back, with template null on a timeout, error or invalid output (eng-2 merges
 * it either way); null means nothing was attempted.
 */
export async function phrase(db: Database, kind: string, situation: string, placeholders: string[], _ctx: { now: number },
  opts: { userText?: string; required?: string[]; timeoutMs?: number } = {}): Promise<{ template: string | null; ledger: LedgerMeta } | null> {
  const names = placeholders.filter((p) => /^[A-Z][A-Z_]{0,30}$/.test(p));
  if (names.length !== placeholders.length || /[\d$]/.test(situation) || !/^[a-z_]{1,30}$/.test(kind)) return null;
  const user = opts.userText ? symbolizeText(db, opts.userText) : null;
  if (user?.hers.length) return null;
  const spec = [`Kind: ${kind}`, `Situation: ${situation}`, `Placeholders: ${names.map((p) => `{${p}}`).join(", ") || "none"}`].join("\n");
  const messages = [...(user ? [{ role: "user" as const, content: turns.get(user.text) ?? `New message: ${user.text}` }] : []), { role: "user" as const, content: spec }];
  const t0 = performance.now();
  try {
    const res = await egress(db, { system: PHRASE_PROMPT, messages, model: converseModel(), json: true, reasoning: phraseReasoning(), max_completion: PHRASE_MAX_TOKENS },
      { timeoutMs: opts.timeoutMs ?? CONVERSE_TIMEOUT_MS });
    log("phrase", Math.round(performance.now() - t0), res);
    if (!res.ok && res.error !== "blocked" && !res.sent) return null; // refused before the wire
    const ledger = meta(user?.text ?? `(${kind})`, res);
    const raw = res.ok ? (extractJson(textOf(res.response)) as { text?: unknown } | null) : null;
    const t = raw && typeof raw === "object" && Object.keys(raw).length === 1 ? raw.text : null;
    return { template: templateOk(t, names, opts.required ?? names) ? t.trim() : null, ledger };
  } catch {
    return null;
  }
}

/** LLM_PROVIDER=fake: the two demo sentences and a valid template, so routers can be tested without a network. */
export function fakeConverse(system: string, content: string): object | null {
  if (system === UNDERSTAND_PROMPT) {
    const msg = content.match(/New message: ([\s\S]*)$/)?.[1] ?? "";
    const goal = msg.match(/\bsav(?:e|ing)\s+(Q_AMT_\d+)\s+(?:by|before|until|till)\s+([A-Za-z]+)/i)
      ?? msg.match(/\bgoal\s+(?:is|of)\s+(Q_AMT_\d+)\b.*?\bby\s+(?:the\s+)?(?:end\s+of\s+)?([A-Za-z]+)/i)
      ?? msg.match(/\b(?:change|lower|raise|set|move)\s+(?:my\s+|the\s+)?goal\s+to\s+(Q_AMT_\d+)()/i);
    const asset = msg.match(/\bha(?:ve|s)\s+(?:around\s+|about\s+|roughly\s+|like\s+)?(Q_AMT_\d+)\s+(?:in\s+savings\s+)?in\s+(?:my\s+)?([A-Za-z]+)/i);
    const cap = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();
    const actions = [...(goal ? [{ type: "set_goal", amount: goal[1], ...(goal[2] ? { by: goal[2] } : {}) }] : []), ...(asset ? [{ type: "add_asset", name: cap(asset[2]), amount: asset[1] }] : [])];
    const q = /\?\s*$/.test(msg);
    // A dispute right after a runway answer ("I'm already at … no?") is runway again.
    const lastAnswer = [...(content.split("New message:")[0] ?? "").matchAll(/^Assistant(?: \[(\w+) answer\])?:/gm)].pop()?.[1];
    const runway = RUNWAY_WORDS.test(msg) || (lastAnswer === "runway" && /\bno\?|\balready\b|\bactually\b|\bwrong\b/i.test(msg));
    const research = /\b(?:reviews?|worth it|what'?s a good|recommend)\b/i.test(msg);
    return { intent: runway ? "runway" : research ? "research" : q ? "question" : "none", actions: actions.length ? actions : [q ? { type: "ask", intent: "other" } : { type: "chat" }] };
  }
  if (system === PHRASE_PROMPT) {
    const names = [...(content.match(/^Placeholders: (.*)$/m)?.[1] ?? "").matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]);
    return { text: `Got it.${names.length ? `\n${names.map((p) => `{${p}}`).join(" · ")}` : ""}` };
  }
  return null;
}
