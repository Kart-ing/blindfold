import type { Handler } from "./types";
import { goalStatus, MONTH, monthYear, savingsCents, usd } from "./finance";
import { friendlyMonth, friendlyUsd } from "./afford";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** End of the named month (PT), at the next occurrence after `now`; an explicit year wins. */
export function deadlineFor(text: string, now: number): number | null {
  // "by end of 2026", "by the end of the year", "by 2027": the end of December of that year (PT).
  const yr = text.toLowerCase().match(/\b(?:by|my|before|until)\s+(?:the\s+)?(?:end\s+of\s+)?(?:(?:the\s+)?(year)|(20\d\d))\b/);
  if (yr) {
    const y = yr[2] ? Number(yr[2]) : new Date(now * 1000).getUTCFullYear();
    const end = Math.floor(Date.UTC(y + 1, 0, 1, 8) / 1000) - 1; // Dec 31 23:59:59 PT (PST in December)
    return end > now ? end : null;
  }
  // "my" is a common thumb-typo for "by" on a phone keyboard ("40k my Dec 2026").
  const m = text.toLowerCase().match(/\b(?:by|my|before|until)\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{4}))?/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return null;
  const nowD = new Date(now * 1000);
  let year = m[2] ? Number(m[2]) : nowD.getUTCFullYear();
  const endOf = (y: number) => Math.floor(Date.UTC(y, mi + 1, 1, 7) / 1000) - 1; // 23:59:59 PT (PDT offset; within an hour is fine)
  if (!m[2] && endOf(year) <= now) year += 1;
  return endOf(year);
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k)?`;
const cents = (m: RegExpMatchArray) => {
  const v = (Number(m[1].replace(/,/g, "")) + (m[2] ? Number(m[2]) : 0)) * (m[3] ? 1000 : 1);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
};

/**
 * The goal amount: the number right after save/saving/goal/stash/put away wins ("save 40000 by December … rent
 * (about 1700$)" → $40,000), else the largest amount mentioned. Years after a month name ("june 2027") never count.
 */
export function parseGoalAmountCents(text: string): number | null {
  const lead = text.match(new RegExp(String.raw`\b(?:save|saving|goal|stash|put away|set aside)\b[^\d$]{0,16}\$?\s*${NUM}`, "i"));
  if (lead) return cents(lead);
  const noYears = text.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d\d\b/gi, "$1");
  const all = [...noYears.matchAll(new RegExp(String.raw`\$?\s*${NUM}`, "gi"))].map(cents).filter((c): c is number => c !== null);
  return all.length ? Math.max(...all) : null;
}

/** One line on where the current pace lands, so a goal never gets set without the math. */
function outlook(db: Parameters<Handler>[0], now: number): string {
  const s = goalStatus(db, now);
  if (!s) return "";
  if (s.projected >= s.goal.target_cents) return "At your current pace you'll get there on time.";
  const need = `To make ${friendlyMonth(s.goal.deadline, now)} you'd need ~${friendlyUsd(s.requiredMonthly)}/mo; you're netting ~${friendlyUsd(s.netMonthly)}/mo.`;
  if (s.netMonthly <= 0) return `At your current pace you won't get there. ${need}`;
  const reach = Math.round(now + ((s.goal.target_cents - s.savings) / s.netMonthly) * MONTH);
  return `At your current pace you'd get there around ${friendlyMonth(reach, now)}. ${need}`;
}

export const handle: Handler = async (db, text, ctx) => {
  const target = parseGoalAmountCents(text);
  // "change the goal to 30k" names no date: keep the active goal's deadline rather than refusing.
  const current = db.query("SELECT deadline FROM goals WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as { deadline: number } | null;
  const deadline = deadlineFor(text, ctx.now) ?? (current && current.deadline > ctx.now ? current.deadline : null);
  if (target === null || deadline === null || deadline <= ctx.now)
    return { text: "Try: \"goal 10000 by june\" (or \"goal $10k by june 2027\").", tier: "local" };
  const savings = savingsCents(db);
  db.transaction(() => {
    db.run("UPDATE goals SET active = 0 WHERE active = 1");
    db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (?, ?, ?, ?, 1)",
      [target, deadline, ctx.now, savings]);
  })();
  const line = outlook(db, ctx.now);
  return { text: `Goal set: ${usd(target)} by ${monthYear(deadline)}. You're at ${usd(savings)} now.${line ? `\n${line}` : ""}`, tier: "local" };
};
