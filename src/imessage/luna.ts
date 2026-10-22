// Luna: the cloud model understands free text and words replies (eng3's src/cloud/converse.ts, through egress).
// The Mac still does everything that matters: it executes the actions, computes every number, and fills replies.
// Luna sees only symbolized text, placeholder names and number-free situations. Any null/failure → the local path.
import type { Database } from "bun:sqlite";
import type { Ctx, Intent, LedgerMeta, Reply } from "../handlers/types.ts";
import { affordReply, friendlyUsd } from "../handlers/afford.ts";
import { affordability, deliveryAvgCents, goalStatus, parseAmountCents, parseLifetimeYears, savingsCents } from "../handlers/finance.ts";
import { deadlineFor } from "../handlers/goal_set.ts";
import { saveMemory } from "../memory/store.ts";
import { addAsset } from "../memory/assets.ts";
import { assetDisplayName } from "./assets.ts";
import { fill, validateTemplate } from "../voice/phrase.ts";
import { applyRentPreference } from "../memory/rent.ts";
import { isResearchQuestion, researchReply } from "./research.ts";
import { hasScenarioFacts, isHypothetical, isRunwayQuestion, runwayAnswer, savingsCheckReply } from "../handlers/runway.ts";

/** intent labels an assistant turn ("Assistant [runway answer]: …"), so a follow-up dispute reads in context. */
export const FIRST_GOAL_TAIL = '\nI\'ll nudge you on commute and dinner days when you drift off pace (text "stop nudges" anytime).\n' +
  'Teach me anything with "remember …", and text "privacy" to see what stays on your Mac.';
const SAVED = 'Saved. Text "memories" to see everything I remember.';
export type Turn = { role: "user" | "assistant"; text: string; intent?: string };
type Action =
  | { type: "set_goal"; amount: string; by: string } | { type: "add_asset"; name: string; name_real?: string; amount: string }
  | { type: "remember"; text: string } | { type: "ask"; intent: Intent } | { type: "chat" };
type Understood = {
  actions: Action[]; qsyms: Record<string, string>; symbolized: string; ledger?: LedgerMeta;
  /** Luna's read of the message as a whole; used when no explicit "ask" action came back. */
  intent?: "afford" | "spend" | "goal_status" | "runway" | "research" | "question" | "none" | null;
};
const INTENT_OF: Record<string, Intent> = { afford: "afford", spend: "spend_query", goal_status: "goal_status", question: "other", runway: "runway" };
type Converse = {
  understand?: (db: Database, text: string, history: Turn[], ctx: Ctx) => Promise<Understood | null>;
  phrase?: (db: Database, kind: string, situation: string, placeholders: string[], ctx: Ctx,
    opts?: { required?: string[]; timeoutMs?: number }) => Promise<{ template: string | null; ledger?: LedgerMeta } | null>;
};

// The last 4 turns, symbolized or placeholder-only, in this process's memory only (never persisted, never filled).
const history: Turn[] = [];
const remember = (t: Turn) => { history.push(t); while (history.length > 4) history.shift(); };
export const lunaHistory = () => history.map((t) => ({ ...t }));
/** The reason path shares this history (symbolized or template-only turns). */
export const pushTurn = (t: Turn) => remember(t);
export const resetLuna = () => { history.length = 0; };

/** Luna is an explicit opt-in: VOICE=cloud. plain (rehearse, stage safety) and device (on-device wording) never call it. */
export const lunaEnabled = () => process.env.VOICE === "cloud";

let override: Converse | null | undefined;
/** Tests: inject a converse module (null = unavailable). */
export const setConverse = (c: Converse | null | undefined) => { override = c; };
async function converse(): Promise<Converse | null> {
  if (override !== undefined) return override;
  try { return (await import("../cloud/converse.ts")) as Converse; } catch { return null; }
}

const cents = (qsyms: Record<string, string>, sym: string) => {
  const v = qsyms[sym];
  return v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null;
};

/** One ledger row per answer: Luna's calls and any handler's are merged into it. */
export function merge(metas: (LedgerMeta | undefined)[], question_sym?: string): LedgerMeta {
  const bodies: unknown[] = [];
  const m: LedgerMeta = { question_sym: question_sym ?? metas.find((x) => x?.question_sym)?.question_sym, exact_disclosed: 0, partial_count: 0, canary_checked: 0, canary_hits: 0 };
  for (const x of metas) {
    if (!x) continue;
    if (x.payload_json) { try { const p = JSON.parse(x.payload_json); bodies.push(...(Array.isArray(p) ? p : [p])); } catch { /* skip */ } }
    m.exact_disclosed! += x.exact_disclosed ?? 0;
    m.partial_count! += x.partial_count ?? 0;
    m.canary_checked! += x.canary_checked ?? 0;
    m.canary_hits! += x.canary_hits ?? 0;
    if (x.consent) m.consent = x.consent;
  }
  if (bodies.length) m.payload_json = JSON.stringify(bodies);
  return m;
}

const log = (msg: string) => { if (process.env.NODE_ENV !== "test" || process.env.DEBUG_LUNA) console.log(`[luna] ${msg}`); };

export type LunaDeps = { runIntent: (intent: Intent) => Promise<{ reply: Reply; intent: Intent }> };

/**
 * Understand → act locally → reply with local facts, worded by Luna when it can.
 * `{ egress }`: Luna was called (text left the Mac) but nothing could run; answer locally, but record that egress.
 * null: nothing left the Mac; use the local path.
 */
export type LunaOutcome = { reply: Reply; intent: Intent } | { egress: LedgerMeta } | null;
export async function luna(db: Database, text: string, ctx: Ctx, deps: LunaDeps): Promise<LunaOutcome> {
  if (!lunaEnabled()) return null;
  const conv = await converse();
  if (!conv?.understand) { log("off (no converse module)"); return null; }
  let u: Understood | null = null;
  try { u = await conv.understand(db, text, lunaHistory(), ctx); } catch (e) { log(`understand failed: ${(e as Error).message}`); u = null; }
  if (!u) { log("no answer → local path"); return null; }
  const sent = () => {
    remember({ role: "user", text: u!.symbolized });
    remember({ role: "assistant", text: "(answered from local data)" });
    return { egress: merge([u!.ledger], u!.symbolized) };
  };
  // No actions but an overall intent: treat it as the question Luna saw.
  if ((!Array.isArray(u.actions) || !u.actions.length) && u.intent && u.intent !== "none" && INTENT_OF[u.intent])
    u = { ...u, actions: [{ type: "ask", intent: INTENT_OF[u.intent] }] };
  else if ((!Array.isArray(u.actions) || !u.actions.length) && u.intent === "none") u = { ...u, actions: [{ type: "chat" }] };
  if (!Array.isArray(u.actions) || !u.actions.length) { log("no actions → local path (egress recorded)"); return sent(); }
  log(`actions: ${u.actions.map((a) => a.type).join(", ")}`);
  const metas: (LedgerMeta | undefined)[] = [u.ledger];
  const notes: string[] = [];
  let memoryId: number | undefined, firstGoal = false;
  let goalChanged = false, goalSet = false, ask: Intent | null = null, chat = false, remembered = false;

  for (const a of u.actions) {
    if (a.type === "set_goal") {
      // "Let's change the goal to 30k": no deadline given → keep the current goal's deadline.
      const current = db.query("SELECT deadline FROM goals WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as { deadline: number } | null;
      const target = cents(u.qsyms, a.amount);
      const deadline = a.by && String(a.by).trim() ? deadlineFor(`by ${a.by}`, ctx.now) : current?.deadline ?? null;
      if (target === null || deadline === null || deadline <= ctx.now) continue;
      const savings = savingsCents(db);
      firstGoal = !(db.query("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n;
      db.transaction(() => {
        db.run("UPDATE goals SET active = 0 WHERE active = 1");
        db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (?, ?, ?, ?, 1)",
          [target, deadline, ctx.now, savings]);
      })();
      goalChanged = goalSet = true;
    } else if (a.type === "add_asset") {
      // The name may arrive symbolized (MERCHANT_n for a real statement merchant, PERSON_n for a brand): resolve it
      // locally to a short display name ("Robinhood"); never store a bare symbol.
      const amount = cents(u.qsyms, a.amount);
      const name = assetDisplayName(db, String(a.name ?? ""), a.name_real);
      if (!name) { log(`add_asset skipped: couldn't resolve ${a.name}`); continue; }
      if (amount === null) continue;
      // Already known at this amount ("I'm at 16k: 6k savings, 10k Robinhood"): nothing to update or announce.
      const prev = db.query("SELECT amount_cents AS c FROM manual_assets WHERE LOWER(name) = LOWER(?) ORDER BY id DESC LIMIT 1").get(name) as { c: number } | null;
      if (prev?.c === amount) continue;
      // The memory row is how it's seen and forgotten: forget removes the asset with it.
      // Shared with the local reader: manual_assets + memory, the goal baseline moves with it, same name replaces.
      const { replaced } = addAsset(db, name, amount, ctx.now);
      notes.push(`${replaced ? "Updated" : "Noted"}: about ${friendlyUsd(amount)} in ${name}, counted toward your goal.`);
      goalChanged = true;
    } else if (a.type === "remember") {
      // The user's own words, kept locally, once per message (Luna may split one message into several remembers).
      if (!remembered) memoryId = saveMemory(db, { text: text.trim(), now: ctx.now });
      remembered = true;
    } else if (a.type === "ask" && !ask) {
      ask = a.intent;
    } else if (a.type === "chat") {
      chat = true;
    }
  }

  // Runway is answered here from local numbers, never by the planner: Luna's intent, our own reading, or a message
  // stating scenario facts (stop date, money coming, checking moving), including a hypothetical Luna only filed as
  // memories ("Say my income stops January 1st + I have another 5.2k coming…").
  const runwayAsk = u.intent === "runway" || ask === "runway" || isRunwayQuestion(text)
    || (hasScenarioFacts(text, ctx.now) && (!ask || ask === "other"))
    || (remembered && !ask && isHypothetical(text) && /\b(?:income|job|paycheck|salary|savings?)\b/i.test(text));
  if (runwayAsk && ask !== "afford" && ask !== "spend_query") ask = "runway";
  // "I'm already at 16k no?": the yes/no with its parts (and the runway again mid-runway-conversation).
  const check = goalSet ? null : savingsCheckReply(db, text, ctx.now);

  // "Is this $400 jacket worth it, what do reviews say?": research (reviews from the web) plus the local afford verdict.
  if (!runwayAsk && (u.intent === "research" || ((!ask || ask === "other" || ask === "afford") && isResearchQuestion(text)))) ask = "research";
  // "I want to buy this $400 jacket, is it a good idea?" with no reviews asked: the part we answer is affordability.
  if (ask === "other" && /\b(buy|afford|purchase|get (?:this|that|it))\b/i.test(text) && parseAmountCents(text) !== null) ask = "afford";
  // Facts and a placeholder fallback from local code, worded by Luna if its template validates.
  let facts: Record<string, string> = {}, fallback = "", situation = "", kind = "", intent: Intent = "other";
  let required: string[] | undefined;
  let reply: Reply | null = null;
  if (check) {
    reply = { text: check, tier: "local" };
    intent = "goal_status";
  } else if (ask === "research" && !goalSet) {
    const r = await researchReply(db, text, ctx);
    metas.push(r.ledger);
    reply = r;
    intent = "research";
  } else if (ask === "runway" && !goalSet) {
    reply = { text: runwayAnswer(db, text, ctx.now), tier: "local" };
    intent = "runway";
  } else if (goalChanged || ask === "goal_status") {
    const s = goalStatus(db, ctx.now);
    const assets = (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM manual_assets").get() as { v: number }).v;
    const gs = s ? await import("../handlers/goal_status.ts").then((m: any) => m.goalStatusReply?.(s, ctx.now, assets)).catch(() => null) : null;
    if (gs?.fallback) ({ facts, fallback, situation } = gs), (required = gs.required);
    else reply = (await deps.runIntent("goal_status")).reply;
    kind = "goal_status";
    intent = goalChanged ? "goal_set" : "goal_status";
  } else if (ask === "afford") {
    const price = parseAmountCents(text);
    const a = price === null ? null : affordability(db, price, ctx.now);
    if (a) ({ facts, fallback, situation, required } = affordReply(a, deliveryAvgCents(db, ctx.now), parseLifetimeYears(text), ctx.now));
    else reply = (await deps.runIntent("afford")).reply;
    kind = "afford";
    intent = "afford";
  } else if (ask) {
    // spend_query and other already answer from local numbers or the planner; their text is used as-is.
    const out = await deps.runIntent(ask);
    metas.push(out.reply.ledger);
    reply = out.reply;
    intent = out.intent;
  } else if (remembered) {
    reply = { text: SAVED, tier: "local" };
    intent = "command";
  } else if (chat) {
    kind = "chat";
    fallback = 'I\'m here. Ask me something like "can I afford a $400 jacket?", or text "memories" to see what I remember.';
    situation = "small talk; reply briefly as a friendly money sidekick and offer one thing it can do";
    intent = "other";
  } else {
    log("no action could run → local path (egress recorded)");
    return sent();
  }

  let template = fallback;
  if (!reply && kind && conv.phrase) {
    required ??= [...new Set([...fallback.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))];
    try {
      // Capped so a slow wording call can't stretch the reply; converse returns what it sent even on timeout.
      const t0 = performance.now();
      const p = await conv.phrase(db, kind, situation, Object.keys(facts), ctx, { required, timeoutMs: Number(process.env.LUNA_PHRASE_MS ?? 4000) });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (p) metas.push(p.ledger);
      const v = p && p.template !== null ? validateTemplate(p.template, facts, required) : null;
      if (v?.ok) { template = v.template; log(`phrase: luna ${secs}s`); }
      else log(`phrase: fallback (${!p ? "unavailable" : p.template === null ? "cap" : `invalid: ${(v as { reason: string }).reason}`}) ${secs}s`);
    } catch { /* fallback */ }
  }
  let body = reply ? reply.text : fill(template, facts);
  // A question asked alongside a goal/asset change ("…and if I lost my job, how long would I last?") still gets its
  // answer, after the status: spend from local numbers, anything else from the planner.
  if (goalChanged && (ask === "spend_query" || ask === "other")) {
    const extra = await deps.runIntent(ask);
    metas.push(extra.reply.ledger);
    body = `${body}\n\n${extra.reply.text}`;
  } else if (goalSet && ask === "runway") body = `${body}\n\n${runwayAnswer(db, text, ctx.now)}`;
  // Something to remember sent with a goal or a question ("goal 40000 by december … my rent is what I send Priya"):
  // say it was kept, or it looks ignored. (A runway what-if is answered by the runway itself.)
  // "My rent is what I send Priya": a categorization preference, confirmed with what it is a month.
  const rentLine = remembered ? applyRentPreference(db, text, ctx.now, memoryId) : null;
  if (rentLine) notes.push(rentLine);
  else if (remembered && reply?.text !== SAVED && ask !== "runway") notes.push("Got it, I'll remember that.");
  if (rentLine && reply?.text === SAVED) body = "";
  // The very first goal (arriving through Luna): what happens next, once, like the local goal_set.
  const tail = firstGoal ? FIRST_GOAL_TAIL : "";
  const textOut = (notes.length ? (body ? `${notes.join("\n")}\n${body}` : notes.join("\n")) : body) + tail;

  remember({ role: "user", text: u.symbolized });
  // Never the filled numbers; the label says what kind of answer it was.
  remember({ role: "assistant", text: reply ? "(answered from local data)" : template, intent: check ? "goal_status" : intent === "spend_query" ? "spend" : intent });
  return { reply: { text: textOut, tier: "cloud", ledger: merge(metas, u.symbolized) }, intent };
}
