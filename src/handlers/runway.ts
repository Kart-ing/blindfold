// "If my income stops Jan 1, how many months could I survive?": pure local arithmetic, no planner, no consent.
// months = cash on the stop date D ÷ monthly spend.
//   Cash on D = liquid cash now (savings incl. balances the user told us + checking, share-weighted: when income stops
//   you live on all of it) + a projection: a stated inflow ("another 5.2k coming for October") stands in for the rest
//   of this month, then netMonthly × full months to D; with none, netMonthly × the fractional months to D.
//   "I'd have 35k" replaces all of that with the user's own figure.
//   Spend: the user's monthly figure ("my spending is 4.5k"), else my-share spend averaged over the last two full months.
// Scenario facts (stop date, inflow, spend, cash to keep) persist in settings.runway_scenario, so a follow-up ("ok, what
// happens then?") applies them unless its own text overrides them.
import type { Database } from "bun:sqlite";
import type { Handler } from "./types";
import { DAY, MONTH, netMonthlyCents, ptMonthStart, savingsCents, totalsBetween } from "./finance";
import { localParts, TZ } from "../imessage/clock";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "may" only with a preposition or a day, so "I may lose my job" isn't May.
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|(?<=\b(?:in|on|by|from|of|for|starting|until|end of)\s+)may|may(?=\s+\d)|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b`;
const NUM = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k)?\b\s*\$?`;

/** Curly quotes → straight, so "I’d have" matches like "I'd have". */
const norm = (t: string) => t.replace(/[‘’ʼ]/g, "'");
const toCents = (n: string, k?: string) => {
  const v = Number(n.replace(/,/g, "")) * (k ? 1000 : 1);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
};
const amountAfter = (t: string, lead: string) => {
  const m = norm(t).match(new RegExp(lead + NUM, "i"));
  return m ? toCents(m[1], m[2]) : null;
};
const monthIndex = (w: string) => MONTHS.findIndex((x) => x.startsWith(w.toLowerCase().slice(0, 3)));

export const isRunwayQuestion = (raw: string) => {
  const t = norm(raw);
  return [
    /\brunway\b/i,
    /\bhow long (?:would|could|can|will|do|does)\s+(?:i|it|my savings|my money|my cash|that|we)\s+(?:last|survive|make it|hold out|cover)/i,
    /\bhow many months\b[^.?!]*\b(?:survive|deplete|cover|without (?:a |an |any )?(?:income|job|pay)|last(?!\s+(?:year|month|week|time)))\b/i,
    /\bmonths? (?:could|can|would|will) i (?:survive|last)\b/i,
    /\b(?:will|would|could|can) i (?:survive|get by|stay afloat)\b/i,
    /\b(?:lose|lost|loose|losing|quit|leave|left)\s+(?:my\s+)?(?:job|income|paycheck|salary|work)\b/i,
    /\b(?:income|paycheck|pay|salary|job)\s+(?:stops|stopped|ends|ended|dries up|is cut|gets cut|goes away)\b/i,
    /\b(?:laid off|stop(?:ped)? working|without (?:an? )?(?:income|job|paycheck))\b/i,
    // "…id's have 35k, that's almost 8 months right?": checking their own runway math.
    /\b(?:that'?s|that is|so|which is)\s+(?:almost|about|around|nearly|like|roughly)?\s*\d+(?:\.\d+)?\s*months?\b[^.!?]*\?/i,
  ].some((r) => r.test(t));
};

/** "Say…", "what if…", "suppose…": a scenario, not news to file away. */
export const isHypothetical = (t: string) => /\b(?:say|suppose|supposing|what if|if|assume|assuming|imagine|hypothetically)\b/i.test(norm(t));

/** Monthly spend the user stated: "my spending is 4.5k", "I spend about $4,500 a month". Not "rent is 1800 a month". */
export const statedSpend = (t: string) => amountAfter(t, String.raw`\b(?:spending|spend|expenses|costs|burn(?:\s*rate)?)\b[^.?!\d$]{0,25}?`);
/** Money the user said they'd have: "I'd have 35k ish". */
export const statedBase = (t: string) =>
  amountAfter(t, String.raw`\b(?:i'?d have|id'?s have|i would have|i'?ll have|i will have|i'?d be at)\s+(?:about|around|like|~|roughly)?\s*`);
/** Cash to leave untouched: "keep 5k untouched", "leave $3,000 as a cushion" (not "keep 40k saved by December"). */
export const statedFloor = (t: string) => {
  const m = norm(t).match(new RegExp(String.raw`\b(?:keep|leave)\s+(?:at least\s+|about\s+|around\s+)?` + NUM +
    String.raw`\s*(?:untouched|aside|as (?:a |an )?(?:cushion|buffer|emergency)|in the bank|for emergencies)`, "i"));
  return m ? toCents(m[1], m[2]) : null;
};
/** The user's own estimate: the last "N months" before a question mark ("…that's almost 8 months right?"). */
export const statedEstimate = (t: string) => {
  const all = [...norm(t).matchAll(/\b(\d+(?:\.\d+)?)\s*months?\b/gi)];
  return /\?/.test(t) && all.length ? Number(all.at(-1)![1]) : null;
};

const label = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
const monthName = (ts: number, style: "long" | "short" = "long") => new Date(ts * 1000).toLocaleDateString("en-US", { month: style, timeZone: TZ });

/** The next occurrence of month `mi` (0-based), day `day`; this month with its day passed → null (already). */
function dateOf(mi: number, day: number, now: number): number {
  const p = localParts(now);
  let ts = ptMonthStart(p.y, mi) + (day - 1) * DAY;
  if (ts > now) return ts;
  if (mi === p.m - 1) return now; // "lose my income in October" during October: from now
  return ptMonthStart(p.y + 1, mi) + (day - 1) * DAY;
}

/** When income stops: the date tied to the stop verb ("income stops January 1st", "loose my income in January"). */
export function parseStop(raw: string, now: number): { ts: number; label: string; immediate?: boolean } | null {
  const t = norm(raw);
  const verb = /\b(?:(?:income|paycheck|pay|salary|job)\s+(?:stops|stopped|ends|ended|dries up|is cut|gets cut|goes away)|(?:lose|lost|loose|losing|quit|leave|left)\s+(?:my\s+)?(?:job|income|paycheck|salary|work)|laid off|stop(?:ped)? working|(?:no|without) (?:an? )?(?:income|job|paycheck))\b/gi;
  const date = new RegExp(String.raw`^[^.?!+;]{0,40}?\b(?:(first|1st|start|beginning|middle|mid|end|last day)(?:\s+day)?\s+of\s+|(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?)?` + MONTH_RE + String.raw`(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b)?`, "i");
  for (const v of t.matchAll(verb)) {
    const after = t.slice(v.index! + v[0].length);
    const m = after.match(date);
    // "…if I lost my job tomorrow / today / next week / next month": relative, unless a month comes first.
    const rel = after.match(/\b(right now|now|today|tomorrow|next week|next month|this month)\b/i);
    const monthAt = after.search(new RegExp(MONTH_RE, "i"));
    if (rel && rel.index! <= 25 && (monthAt < 0 || rel.index! < monthAt)) {
      const w = rel[1].toLowerCase();
      if (w === "next month") { const p = localParts(now); const ts = ptMonthStart(p.y, p.m); return { ts, label: label(ts) }; }
      if (w === "next week") { const ts = now + 7 * DAY; return { ts, label: label(ts) }; }
      return { ts: now, label: "now", immediate: true }; // now / today / tomorrow / this month: no more pay to count
    }
    if (!m) continue;
    const mi = monthIndex(m[3]);
    const pos = (m[1] ?? "").toLowerCase();
    if (pos === "end" || pos === "last day") {
      const ts = dateOf((mi + 1) % 12, 1, now);
      return { ts, label: label(ts) };
    }
    const day = Number(m[2] ?? m[4] ?? (pos === "middle" || pos === "mid" ? 15 : 1));
    const ts = dateOf(mi, Math.min(Math.max(day, 1), 28), now);
    return { ts, label: ts === now ? "today" : label(ts) };
  }
  return null;
}

/** "another 5.2k coming for October": an amount still to arrive, and the month it's for (default: this month). */
export function parseInflow(raw: string, now: number): { cents: number; monthStart: number } | null {
  const t = norm(raw);
  const m = t.match(new RegExp(String.raw`\b(?:another|an extra|extra|a further)?\s*` + NUM +
    String.raw`\s*(?:more\s+)?(?:[a-z]+\s+){0,2}?(?:coming(?: in)?|incoming|arriving|expected|due|on the way|to come)\b(?:\s+(?:in|for|by|on|at the end of|this|next)\s+(?:the\s+)?(?:end of\s+)?(?:` + MONTH_RE + String.raw`|(month)))?`, "i"));
  if (!m) return null;
  const cents = toCents(m[1], m[2]);
  if (!cents) return null;
  const p = localParts(now);
  const current = ptMonthStart(p.y, p.m - 1);
  const mi = m[3] ? monthIndex(m[3]) : p.m - 1;
  const start = mi === p.m - 1 ? current : dateOf(mi, 1, now);
  return { cents, monthStart: start };
}

export const mentionsCheckingMove = (t: string) =>
  /\bchecking\b[^.?!]{0,60}\b(?:move|moves|moving|go|goes|going|transfer|transfers|transferred|put)\b[^.?!]{0,25}\bsav(?:e|es|ing|ings)\b/i.test(norm(t))
  || /\b(?:include|count|add|plus)\b[^.?!]{0,15}\bchecking\b/i.test(norm(t));

type Scenario = { immediate?: boolean; stopTs?: number; inflow?: { cents: number; monthStart: number }; spendCents?: number; floorCents?: number; checking?: boolean; updated: number };

/** The facts this message states about the scenario (none → {}). */
export function scenarioFacts(text: string, now: number): Omit<Scenario, "updated"> {
  const s: Omit<Scenario, "updated"> = {};
  const stop = parseStop(text, now);
  if (stop) s.stopTs = stop.ts;
  if (stop?.immediate) s.immediate = true;
  const inflow = parseInflow(text, now);
  if (inflow) s.inflow = inflow;
  const spend = statedSpend(text);
  if (spend) s.spendCents = spend;
  const floor = statedFloor(text);
  if (floor) s.floorCents = floor;
  if (mentionsCheckingMove(text)) s.checking = true;
  return s;
}
export const hasScenarioFacts = (text: string, now: number) => {
  const s = scenarioFacts(text, now);
  return s.stopTs !== undefined || s.inflow !== undefined || s.checking === true;
};

function loadScenario(db: Database, now: number): Scenario | null {
  try {
    const row = db.query("SELECT value FROM settings WHERE key = 'runway_scenario'").get() as { value: string } | null;
    if (!row) return null;
    const s = JSON.parse(row.value) as Scenario;
    // Stale facts drop out: a stop date that has passed, an inflow for a month that's over.
    const p = localParts(now);
    if (s.stopTs !== undefined && s.stopTs < now) delete s.stopTs;
    if (s.inflow && s.inflow.monthStart < ptMonthStart(p.y, p.m - 1)) delete s.inflow;
    return s;
  } catch { return null; }
}
function saveScenario(db: Database, s: Scenario) {
  db.run("INSERT INTO settings(key, value) VALUES ('runway_scenario', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
}
/** A runway conversation within the last day: worth re-stating the runway after a savings check. */
export const scenarioFresh = (db: Database, now: number) => { const s = loadScenario(db, now); return !!s && now - s.updated < DAY; };

const ACCOUNT_SHARE = `CASE WHEN owner = 'her' THEN 0.0 WHEN shared = 1 OR owner = 'shared' THEN 0.5 ELSE 1.0 END`;
const sum = (db: Database, sql: string) => { try { return Math.round((db.query(sql).get() as { s: number }).s); } catch { return 0; } };
/** Checking, share-weighted; 0 when the user told us a checking amount (it's already a manual asset). */
function checkingCents(db: Database): number {
  if (sum(db, "SELECT COUNT(*) AS s FROM manual_assets WHERE name LIKE '%checking%'")) return 0;
  return sum(db, `SELECT COALESCE(SUM(balance_cents * ${ACCOUNT_SHARE}), 0) AS s FROM accounts WHERE type = 'depository' AND subtype = 'checking'`);
}

function lastTwoMonthsSpend(db: Database, now: number): number | null {
  const p = localParts(now);
  // ptMonthStart takes a 0-based month (Date.UTC rolls negatives over); localParts().m is 1-based.
  const spend = totalsBetween(db, ptMonthStart(p.y, p.m - 3), ptMonthStart(p.y, p.m - 1)).spend;
  return spend > 0 ? Math.round(spend / 2) : null;
}
function lastTwoMonthsLabel(now: number): string {
  const p = localParts(now);
  return `${monthName(ptMonthStart(p.y, p.m - 3), "short")}–${monthName(ptMonthStart(p.y, p.m - 2), "short")}`;
}

/** Whole dollars, compact: $850, $3.3k, $16k, $120k. */
export const kUsd = (cents: number) => {
  const d = Math.abs(cents) / 100;
  const s = d < 1000 ? `$${Math.round(d)}` : d < 100_000 ? `$${(d / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(d / 1000)}k`;
  return cents < 0 ? `-${s}` : s;
};
/** The last day the money covers, as "late August 2027". */
const into = (ts: number) => {
  const d = new Date((ts - DAY) * 1000);
  const day = Number(d.toLocaleDateString("en-US", { day: "numeric", timeZone: TZ }));
  const y = d.toLocaleDateString("en-US", { year: "numeric", timeZone: TZ });
  return `${day <= 10 ? "early" : day <= 20 ? "mid" : "late"} ${monthName(ts - DAY)} ${y}`;
};
/** "Nov–Dec" for the months in [start, end). */
const span = (start: number, end: number) => {
  const a = monthName(start, "short"), b = monthName(end - DAY, "short");
  return a === b ? a : `${a}–${b}`;
};

/** Answer a runway question; stores what this message states so a follow-up keeps the scenario. */
export function runwayAnswer(db: Database, text: string, now: number): string {
  const facts = scenarioFacts(text, now);
  const s: Scenario = { ...(loadScenario(db, now) ?? {}), ...facts, updated: now };
  // A stop date in this message beats the stored one; stopping now, or before the stored inflow's month, means that
  // money never comes.
  if (facts.stopTs !== undefined && !facts.inflow && s.inflow && (facts.immediate || facts.stopTs <= s.inflow.monthStart)) delete s.inflow;
  delete s.immediate;
  try { saveScenario(db, s); } catch { /* a DB without settings: answer anyway */ }

  const stopTs = s.stopTs ?? now;
  const userSpend = s.spendCents ?? null;
  const spend = userSpend ?? lastTwoMonthsSpend(db, now);
  if (!spend) return "I can't see enough spending yet to work that out. Tell me your monthly spend, e.g. \"my spending is 4.5k a month\".";

  const stopLabel = stopTs > now ? label(stopTs) : "Now";
  const parts: string[] = [];
  let base: number;
  const own = statedBase(text);
  if (own) {
    base = own;
  } else {
    const saved = savingsCents(db), checking = checkingCents(db);
    const net = netMonthlyCents(db, now);
    base = saved + checking;
    parts.push(`${kUsd(saved)} saved`);
    if (checking > 0) parts.push(`+ ${kUsd(checking)} checking`);
    if (stopTs > now) {
      const p = localParts(now);
      const nextMonth = ptMonthStart(p.y, p.m);
      let from = now;
      if (s.inflow && s.inflow.monthStart < stopTs) {
        base += s.inflow.cents;
        if (s.inflow.monthStart <= now) {
          // This month's remaining pay: it replaces the projection for the rest of the month (the average already
          // holds a month's pay, so adding it on top would count it twice).
          parts.push(`+ ${kUsd(s.inflow.cents)} ${monthName(s.inflow.monthStart)} pay`);
          from = Math.min(nextMonth, stopTs);
        } else parts.push(`+ ${kUsd(s.inflow.cents)} ${monthName(s.inflow.monthStart)} inflow`); // a later month: on top
      }
      const months = Math.max(0, (stopTs - from) / MONTH);
      const surplus = Math.round(net * months);
      if (months > 0 && surplus !== 0) {
        base += surplus;
        parts.push(surplus > 0 ? `+ ~${kUsd(surplus)} ${span(from, stopTs)} surplus` : `- ~${kUsd(-surplus)} ${span(from, stopTs)} shortfall`);
      }
    }
  }
  if (s.floorCents && !own) { base -= s.floorCents; parts.push(`- ${kUsd(s.floorCents)} kept untouched`); }

  const runway = base > 0 ? base / spend : 0;
  const t = norm(text);
  // A yes/no "will I survive?" gets a yes; "how many months could I survive" is just a number.
  const surviveRe = String.raw`\b(?:will|would|could|can|do) i (?:survive|make it|get by|be ok(?:ay)?)\b`;
  const survive = new RegExp(surviveRe, "i").test(t) && !new RegExp(String.raw`\bhow (?:many|long)\b[^.?!,]{0,25}` + surviveRe, "i").test(t);
  const many = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const amount = runway >= 2 ? many(Math.round(runway), "month") : runway >= 1 ? `${runway.toFixed(1).replace(/\.0$/, "")} months`
    : many(Math.max(1, Math.round(runway * 4.35)), "week");
  const head = runway <= 0 ? "Not really: on these numbers there'd be no cash left to live on."
    : `${survive ? "Yes, for about" : "About"} ${amount}, into ${into(stopTs + runway * MONTH)}.`;
  const est = statedEstimate(text);
  const verdict = est === null || runway <= 0 ? "" : Math.abs(est - runway) <= 0.6 ? "Yes, that's right. " : `Not quite: closer to ${runway.toFixed(1)} months, not ${est}. `;
  const breakdown = `${stopLabel}: ~${kUsd(Math.max(base, 0))}${own ? " (your figure)" : ` = ${parts.join(" ")}`}. ÷ ~${kUsd(spend)}/mo spending.`;

  const assume: string[] = [stopTs > now ? `income stops ${label(stopTs)}` : "income stops now"];
  if (!own && s.inflow && s.inflow.monthStart < stopTs)
    assume.push(s.inflow.monthStart <= now ? `the ${kUsd(s.inflow.cents)} is the rest of ${monthName(s.inflow.monthStart)}'s pay (not on top of it)`
      : `the ${kUsd(s.inflow.cents)} in ${monthName(s.inflow.monthStart)} comes on top of your usual surplus`);
  assume.push(userSpend ? "spending stays at your figure" : `spending stays at your ${lastTwoMonthsLabel(now)} average`);
  assume.push(s.floorCents ? `you keep ${kUsd(s.floorCents)}` : "you spend down to $0");
  return `${verdict}${head}\n${breakdown}\nAssumes ${assume.slice(0, -1).join(", ")} and ${assume.at(-1)}.`;
}

/** "I'm already at 16k no?": confirm (or correct) the saved total with its parts. null = not that kind of question. */
export function savingsCheck(db: Database, raw: string): string | null {
  const t = norm(raw);
  if (!/\?|\b(?:no|right|correct)\s*[.!]?\s*$/i.test(t)) return null;
  // "I'm already at 16k", "am I at 16k", "I've got 16k saved" (not "I have 5k coming").
  const m = t.match(new RegExp(String.raw`\b(?:(?:i'?m|i am|am i|we'?re|we are)\s+(?:already\s+|now\s+)?at|(?:i|we)(?:\s+already)?(?:\s+have|'ve got|\s+got)(?=\s+\$?\s*\d[\d,.]*\s*k?\s*\$?\s+(?:saved|total|in total|altogether)))\s+(?:about\s+|around\s+|like\s+|~)?` + NUM, "i"));
  if (!m) return null;
  const stated = toCents(m[1], m[2]);
  if (!stated) return null;
  const saved = savingsCents(db);
  const accounts = saved - sum(db, "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM manual_assets");
  const assets = (() => { try { return db.query("SELECT name, amount_cents AS c FROM manual_assets ORDER BY id").all() as { name: string; c: number }[]; } catch { return []; } })();
  const parts = [...(accounts > 0 ? [`${kUsd(accounts)} savings`] : []), ...assets.map((a) => `${kUsd(a.c)} ${a.name}`)];
  const close = Math.abs(stated - saved) <= Math.max(50_000, saved * 0.05);
  return `${close ? "Yes" : "Not quite"}: ${kUsd(saved)}${parts.length > 1 ? ` (${parts.join(" + ")})` : ""}.`;
}

/** The savings check, plus the runway again while a runway conversation is going (the scenario is fresh). */
export function savingsCheckReply(db: Database, text: string, now: number): string | null {
  const check = savingsCheck(db, text);
  if (!check) return null;
  return scenarioFresh(db, now) ? `${check}\n\n${runwayAnswer(db, text, now)}` : check;
}

export const handle: Handler = async (db, text, ctx) => ({ text: runwayAnswer(db, text, ctx.now), tier: "local" });
