// Inbound text → reply. Exact commands first, then intent (on-device fm, keyword fallback), then a handler.
// Writes exactly one ledger row per answer (contract in src/handlers/types.ts).
import type { Database } from "bun:sqlite";
import type { Ctx, Handler, Intent, Reply } from "../handlers/types.ts";
import { greetingKind, parseCommand, looksLikeAnswer, looksLikePromptReply, type Command } from "./commands.ts";
import { answerPrompt, answerWord, isIdk, keepAsMine, markReasked, pendingPrompt, reasked, relabelLast, softAsk } from "./prompts.ts";
import { noFm, type Fm } from "./fm.ts";
import { rules, setPlace } from "./data.ts";
import { merchantLookup } from "./lookup.ts";
import { reasonEnabled, reasonPath, type ReasonOutcome } from "../calc/execute.ts";
import { FIRST_GOAL_TAIL, luna, merge as mergeLedger, type LunaOutcome } from "./luna.ts";
import { mentionsSelfHarm, SAFETY_REPLY } from "./safety.ts";
import { assetStatement } from "./assets.ts";
import { isResearchQuestion, researchReply } from "./research.ts";
import { hasScenarioFacts, isRunwayQuestion, runwayAnswer, savingsCheckReply } from "../handlers/runway.ts";
import { answerForgetAll, forgetAllPending, parseMemoryCommand, runMemory } from "../memory/commands.ts";
import { cloudMemoryLine } from "../cloud/memory.ts";
import { activeGoal } from "../handlers/finance.ts";
import { privacyLine } from "../cloud/privacy.ts";

export type RouteDeps = {
  fm?: Fm;
  cli?: boolean;
  /** Runs the scheduler at a simulated time (CLI `tick HH:MM`). */
  tick?: (at: string) => Promise<string>;
  /** Overrides handler lookup (tests). */
  loadHandler?: (intent: Intent) => Promise<Handler | null>;
  /** Told which intent answered (main.ts piggybacks who-paid questions only on real answers). */
  onIntent?: (intent: Intent) => void;
};

const INTENTS: Intent[] = ["afford", "goal_set", "goal_status", "spend_query", "attribution_fix", "command", "other"];
const INTENT_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: INTENTS, description:
    "afford: can I buy/afford something. goal_set: set a savings goal. goal_status: am I on track for my goal. " +
    "spend_query: a single-period lookup only (how much / total / top N in one period). " +
    "Comparisons, trends, changes over time, 'since <month>', why, should I, subscriptions and conditional plans are other. " +
    "attribution_fix: a charge was someone else's or shared. " +
    "command: a settings command. other: anything else." } },
  required: ["intent"],
};

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** Comparative or open-ended: these need a multi-step plan, so they go to `other` even if they mention spending. */
const OPEN_ENDED = new RegExp([
  String.raw`\bwhat changed\b`, String.raw`\bchang(?:e|ed|es|ing)\b`, String.raw`\bcompar(?:e|ed|ing|ison)\b`, String.raw`\bvs\.?\b`, String.raw`\bversus\b`,
  String.raw`\btrends?\b`, String.raw`\bsince (?:${MONTHS}|last|the)\b`, String.raw`\b(?:more|less|fewer) than\b`, String.raw`\bwhy\b`,
  String.raw`\bshould i\b`, String.raw`\btrip\b`, String.raw`\bif i (?:keep|stop|cut|cancel)\b`, String.raw`\bcancel\b`,
  String.raw`\bsubscriptions?\b`, String.raw`\brecurring\b`, String.raw`\bevery month\b`,
].join("|"), "i");
// attribution_fix is overridable too: exact relabels ("that was hers", 1/2/3) are commands parsed before fm runs,
// so an fm attribution_fix here is always free text, and a "why did X charge me" question belongs to the planner.
const OVERRIDABLE: Intent[] = ["afford", "spend_query", "goal_status", "attribution_fix"];

/** Deterministic override applied after fm or the keyword fallback. */
export const overrideIntent = (text: string, intent: Intent): Intent =>
  OVERRIDABLE.includes(intent) && OPEN_ENDED.test(text) ? "other" : intent;

export function keywordIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(can i|could i)\b.*\b(buy|afford|get|spend)\b|\bafford\b/.test(t)) return "afford";
  if (/^goal\b.*\bby\b|\b(set|new)\b.*\bgoal\b|\bsave\s+\$?[\d,.]+\s*k?\s*\$?\s+by\b|\bgoal is\b.*\bby\b/.test(t)) return "goal_set";
  if (/\bgoal\b|\bon track\b|\bpace\b|\bbehind\b/.test(t)) return "goal_status";
  if (/\bthat was (hers|mine)\b|\bwasn'?t (me|mine)\b|\b(was|is) (hers|mine|shared)\b/.test(t)) return "attribution_fix";
  if (/\bhow much\b|\bspent\b|\bspend(ing)?\b/.test(t)) return "spend_query";
  return "other";
}

export async function classify(text: string, fm: Fm): Promise<Intent> {
  const out = await fm.extract(`Classify this text message to a personal finance assistant: ${JSON.stringify(text)}`, INTENT_SCHEMA);
  const intent = out?.intent;
  const base = typeof intent === "string" && (INTENTS as string[]).includes(intent) ? (intent as Intent) : keywordIntent(text);
  return overrideIntent(text, base);
}

const handlers = new Map<Intent, Handler>();

/**
 * Loads (and caches) an intent's handler. A failed import is logged, never silently "not ready": live on Oct 22 a
 * process started before a commit lazily imported the new afford.ts against its cached old finance.ts, and the
 * missing export only showed up as "afford: not ready yet".
 */
async function defaultLoad(intent: Intent): Promise<Handler | null> {
  const cached = handlers.get(intent);
  if (cached) return cached;
  try {
    const h = intent === "other" ? (await import("../cloud/plan.ts")).handleOther : (await import(`../handlers/${intent}.ts`)).handle;
    if (typeof h === "function") { handlers.set(intent, h); return h; }
    console.error(`[router] ${intent} handler has no export`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!/Cannot find module|not found/i.test(msg) || !/handlers\/[a-z_]+\.ts/.test(msg)) console.error(`[router] couldn't load the ${intent} handler: ${msg}`);
  }
  return null;
}

/**
 * Imports every handler (and the voice module they use) once at startup, so a running agent works from one
 * consistent snapshot of the code: later edits to the working tree can't half-apply until a restart.
 */
export async function preloadHandlers(): Promise<{ loaded: Intent[]; missing: Intent[] }> {
  const loaded: Intent[] = [], missing: Intent[] = [];
  for (const intent of INTENTS.filter((i) => i !== "command")) ((await defaultLoad(intent)) ? loaded : missing).push(intent);
  await import("../voice/phrase.ts").catch((e) => console.error(`[router] couldn't load voice: ${(e as Error).message}`));
  // Luna's converse module too, so a later working-tree edit can't change a running agent.
  await import("../cloud/converse.ts").catch((e) => console.error(`[router] couldn't load converse: ${(e as Error).message}`));
  return { loaded, missing };
}

function rulesText(): string {
  const r = { ...rules() };
  r[8] ??= 'your standing preference ("Sephora is always hers"); never overrides 1';
  return ["Who paid, first match wins:", ...Object.keys(r).map(Number).sort((a, b) => a - b).map((n) => `${n}. ${r[n]}`),
    "Rules 6–7 on charges over $75, and rides to OTHER places, get a 1/2/3 question."].join("\n");
}

const PRIVACY_TIERS = [
  "🟢 local: commands, matching, who-paid rules, goal math and nudges run in code on this Mac.",
  "🟢 on-device: Apple's on-device model routes messages and reads receipts. Nothing leaves the Mac.",
  "🟡 cloud: only open-ended questions, as symbols (no merchants, amounts, names or addresses), after a leak check.",
];
/** The "her charges" line only makes sense when there's a shared card to split. */
const privacyText = (db: Database) => [...PRIVACY_TIERS,
  `${count(db, "SELECT COUNT(*) AS n FROM accounts WHERE shared = 1") ? "Her charges are only subtracted, never analysed or sent anywhere. " : ""}Text "ledger" for what was sent.`,
].join("\n");

const HELP = "Commands: ledger, privacy, rules, revoke <scope>, stop nudges, nudges on, home is <addr>, work is <addr>, " +
  "goal <amount> by <month>, that was hers / that was mine, or 1/2/3 to answer a question.";

function ledgerSummary(db: Database, now: number): string {
  const r = db.query(`SELECT COUNT(*) AS n,
      -- The fake planner (LLM_PROVIDER=fake) answers on this Mac; its rows carry provider:"fake" (egress.fakeEncode).
      COALESCE(SUM(tier IN ('local', 'on-device') OR instr(COALESCE(payload_json, ''), '"provider":"fake"') > 0), 0) AS local,
      COALESCE(SUM(exact_disclosed), 0) AS exact
    FROM ledger WHERE COALESCE(intent, '') != 'command'`).get() as Record<string, number>;
  const q = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  // eng3's privacyLine owns the cloud details (symbols, partials, blocked calls), so they're stated once.
  return `${q(r.n, "question")}, ${r.local} never left your Mac, ${r.exact} exact values sent.\n${privacyLine(db, now)}`;
}

async function runCommand(db: Database, cmd: Command, text: string, ctx: Ctx, deps: RouteDeps): Promise<{ reply: Reply; intent: Intent }> {
  const local = (t: string, intent: Intent = "command") => ({ reply: { text: t, tier: "local" as const }, intent });
  switch (cmd.kind) {
    case "ledger": return local(ledgerSummary(db, ctx.now));
    case "privacy": {
      const consents = db.query("SELECT scope, grant_kind FROM consents ORDER BY scope").all() as { scope: string; grant_kind: string }[];
      const c = consents.length ? `\nConsents: ${consents.map((x) => `${x.scope} (${x.grant_kind})`).join(", ")}. Text "revoke <scope>" to remove one.` : "\nNo consents granted.";
      // eng3's line keeps the cloud-memory wording in one place; the next step points at the local list.
      return local(`${privacyText(db)}${c}\n${cloudMemoryLine()} Text "memories" to see what I remember.`);
    }
    case "revoke": {
      const n = db.run("DELETE FROM consents WHERE scope = ?", [cmd.scope]).changes;
      return local(n ? `Revoked ${cmd.scope}.` : `No consent named ${cmd.scope}.`);
    }
    case "rules": return local(rulesText());
    case "nudges":
      db.run("INSERT INTO settings(key, value) VALUES ('nudges', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [cmd.on ? "on" : "off"]);
      return local(cmd.on ? "Nudges are on." : "Nudges stopped. Text \"nudges on\" to restart.");
    case "place": {
      const r = setPlace(db, cmd.label, cmd.address);
      return local(r.ok ? `Saved ${cmd.label}. The address stays on this Mac; only the label is used for reasoning.`
        : `I can only use addresses I know offline. ${cmd.label} is unchanged.`);
    }
    case "goal": return dispatch(db, "goal_set", text, ctx, deps);
    case "relabel": return local(relabelLast(db, cmd.owner, ctx.now), "attribution_fix");
    case "answer":
      // A pending "forget everything?" takes its 1/2 before a who-paid question does. Answers aren't questions.
      if (cmd.choice !== 3 && forgetAllPending(db, ctx.now)) return local(answerForgetAll(db, cmd.choice, ctx.now));
      return local(answerPrompt(db, cmd.choice, ctx.now));
    case "tick": return local(deps.tick ? await deps.tick(cmd.at) : "Tick is not available here.");
  }
}

async function dispatch(db: Database, intent: Intent, text: string, ctx: Ctx, deps: RouteDeps): Promise<{ reply: Reply; intent: Intent }> {
  const handler = await (deps.loadHandler ?? defaultLoad)(intent);
  if (!handler) return { reply: { text: `${intent}: not ready yet.`, tier: "local" }, intent };
  const firstGoal = intent === "goal_set" && !count(db, "SELECT COUNT(*) AS n FROM goals");
  try {
    const reply = await handler(db, text, ctx);
    // The very first goal ever: say what happens next, once.
    if (firstGoal && count(db, "SELECT COUNT(*) AS n FROM goals")) return { reply: { ...reply, text: reply.text + FIRST_GOAL_TAIL }, intent };
    return { reply, intent };
  } catch (e) {
    console.error(`[router] ${intent} handler failed:`, e);
    return { reply: { text: "Sorry, something went wrong answering that.", tier: "local" }, intent };
  }
}

export function writeLedger(db: Database, ctx: Ctx, intent: Intent, reply: Reply) {
  const m = reply.ledger ?? {};
  db.run(`INSERT INTO ledger(ts, tier, intent, question_sym, payload_json, exact_disclosed, partial_count, canary_checked, canary_hits, consent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.now, reply.tier, intent, m.question_sym ?? null, m.payload_json ?? null, m.exact_disclosed ?? 0, m.partial_count ?? 0,
      m.canary_checked ?? null, m.canary_hits ?? null, m.consent ?? null]);
}

const HELLO = "Hey! I'm your money sidekick.\nI keep your finances on this Mac and only ever send the cloud symbols, never your data.\n" +
  "Try \"can I afford a $400 jacket?\" or \"what changed since August?\"";

const count = (db: Database, sql: string) => {
  try { return (db.query(sql).get() as { n: number }).n; } catch { return 0; } // a table that doesn't exist yet → 0
};

/** First hello with no goal yet: what's been read locally, then the one question that unlocks everything. */
export function onboardingText(db: Database): string {
  const statements = count(db, "SELECT COUNT(*) AS n FROM ingest_log");
  const accounts = count(db, "SELECT COUNT(DISTINCT account_id) AS n FROM ingest_log WHERE account_id IS NOT NULL");
  const receipts = count(db, "SELECT COUNT(*) AS n FROM receipts");
  const p = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [
    ...(statements ? [`${p(statements, "statement")}${accounts ? ` across ${p(accounts, "account")}` : ""}`] : []),
    ...(receipts ? [`${p(receipts, "ride/food receipt")}`] : []),
  ];
  return ["Hey! I'm your money sidekick. Everything stays on this Mac.",
    ...(parts.length ? [`I've read ${parts.join(" and ")}.`] : []),
    'First: what are you saving for, and by when? e.g. "goal 10000 by june"'].join("\n");
}


/**
 * Replies that need no handler, in order, while a who-paid question may be pending:
 * (1) me/mine · her/hers · split/both/shared answer it; (2) "idk"-ish keeps it as mine and closes it;
 * (3) greetings get a friendly reply, plus one soft reminder of the question; (4) other short non-questions get one
 * soft re-ask per question, then are left alone; real questions return null and route normally (question stays open).
 */
function conversational(db: Database, text: string, ctx: Ctx): string | null {
  const pending = pendingPrompt(db);
  const choice = pending ? answerWord(text) : null;
  if (choice) return answerPrompt(db, choice, ctx.now);
  if (pending && isIdk(text) && keywordIntent(text) === "other") return keepAsMine(db, ctx.now);
  const g = greetingKind(text);
  // No goal yet: the greeting is the onboarding (one ask at a time, so no who-paid reminder here).
  if (g === "hello" && !activeGoal(db)) return onboardingText(db);
  if (g) {
    const base = g === "hello" ? HELLO : g === "thanks" ? "Anytime 🙌" : "👍";
    if (!pending || reasked(db, pending)) return base;
    markReasked(db, pending);
    return `${base}\n\nAlso, quick one when you have a sec: ${softAsk(db, pending)}`;
  }
  if (pending && !reasked(db, pending) && (looksLikeAnswer(text) || (looksLikePromptReply(text) && keywordIntent(text) === "other"))) {
    markReasked(db, pending);
    const ask = softAsk(db, pending);
    return `No stress. ${ask[0].toUpperCase()}${ask.slice(1)}`;
  }
  return null;
}

export async function route(db: Database, text: string, ctx: Ctx, deps: RouteDeps = {}): Promise<Reply> {
  // Safety first: a self-harm mention is answered here, locally, before anything else can route it.
  if (mentionsSelfHarm(text)) {
    const reply: Reply = { text: SAFETY_REPLY, tier: "local" };
    writeLedger(db, ctx, "command", reply);
    deps.onIntent?.("command");
    return reply;
  }
  const cmd = parseCommand(text, { cli: deps.cli });
  let out: { reply: Reply; intent: Intent };
  let smallTalk: string | null;
  let lunaOut: LunaOutcome = null;
  let reasonOut: ReasonOutcome = null;
  const mem = cmd ? null : parseMemoryCommand(text);
  if (cmd) out = await runCommand(db, cmd, text, ctx, deps);
  // Memory commands run before the who-paid tiers, or "Sephora is always hers" would read as a short reply.
  else if (mem) out = { reply: { text: runMemory(db, mem, ctx.now), tier: "local" }, intent: "command" };
  else if ((smallTalk = conversational(db, text, ctx))) out = { reply: { text: smallTalk, tier: "local" }, intent: "command" };
  // The primary brain: Sol reasons over named variables and writes equations; the Mac solves and fills them.
  // Anything it can't do (unavailable, invalid plan, failed equation) falls through to the local handlers below.
  else if (reasonEnabled() && (reasonOut = await reasonPath(db, text, ctx)) && "reply" in reasonOut) out = reasonOut;
  else if ((smallTalk = merchantLookup(db, text))) out = { reply: { text: smallTalk, tier: "local" }, intent: "spend_query" };
  // "I've got ~10k in Robinhood": read locally, so it never depends on the privacy gate or Luna.
  else if ((smallTalk = assetStatement(db, text, ctx.now))) out = { reply: { text: smallTalk, tier: "local" }, intent: "goal_status" };
  // Everything else: Luna understands it and words the reply; the Mac acts and computes. Null → the local path below.
  else if (!reasonEnabled() && (lunaOut = await luna(db, text, ctx, { runIntent: (i) => dispatch(db, i, text, ctx, deps) })) && "reply" in lunaOut) out = lunaOut;
  else {
    // Luna couldn't answer: savings checks and runway locally, never the planner; then keywords (no local model;
    // the human chose Luna + Sol only).
    const check = savingsCheckReply(db, text, ctx.now);
    const intent = overrideIntent(text, keywordIntent(text));
    if (check) out = { reply: { text: check, tier: "local" }, intent: "goal_status" };
    else if (intent !== "afford" && (isRunwayQuestion(text) || hasScenarioFacts(text, ctx.now)))
      out = { reply: { text: runwayAnswer(db, text, ctx.now), tier: "local" }, intent: "runway" };
    else if (intent !== "command" && isResearchQuestion(text)) out = { reply: await researchReply(db, text, ctx), intent: "research" };
    // A command-like message that matched no exact command gets the command list, never the cloud.
    else out = intent === "command" ? { reply: { text: HELP, tier: "local" }, intent } : await dispatch(db, intent, text, ctx, deps);
    // Luna was asked first: the text left the Mac, so this answer's row says so (tier cloud, Luna's payload + canary).
    const egressed = lunaOut && "egress" in lunaOut ? lunaOut.egress : reasonOut && "egress" in reasonOut ? reasonOut.egress : null;
    if (egressed) out = { ...out, reply: { ...out.reply, tier: "cloud", ledger: mergeLedger([egressed, out.reply.ledger]) } };
  }
  writeLedger(db, ctx, out.intent, out.reply);
  deps.onIntent?.(out.intent);
  return out.reply;
}
