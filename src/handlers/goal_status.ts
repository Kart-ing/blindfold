import type { Handler } from "./types";
import { goalStatus, manualAssetsCents, MONTH, type GoalStatus } from "./finance";
import { fill, friendlyMonth, friendlyUsd } from "./afford";

/**
 * The goal status as facts (placeholder → formatted value), a number-free situation for the phrasing model, and a
 * fallback template that is a good reply on its own. Every number comes from goalStatus(); the wording is swappable.
 */
export function goalStatusReply(s: GoalStatus, now: number, assetsCents = 0) {
  const facts: Record<string, string> = {
    GOAL: friendlyUsd(s.goal.target_cents),
    DEADLINE: friendlyMonth(s.goal.deadline, now),
    SAVED: friendlyUsd(s.savings),
    NEED_MO: friendlyUsd(s.requiredMonthly),
    NET_MO: friendlyUsd(s.netMonthly),
  };
  const fresh = Math.abs(s.paceGap) < 500;
  const onTime = s.projected >= s.goal.target_cents;
  const situation: string[] = [];
  let lead: string;
  let detail: string;
  if (onTime) {
    lead = "You're on track for {GOAL} by {DEADLINE}.";
    situation.push("goal will be met on time at the current pace");
  } else if (s.netMonthly > 0) {
    facts.REACH = friendlyMonth(Math.round(now + ((s.goal.target_cents - s.savings) / s.netMonthly) * MONTH), now);
    facts.PROJECTED = friendlyUsd(s.projected);
    lead = "At this pace you'd reach {GOAL} around {REACH}, not {DEADLINE}.";
    detail = "By {DEADLINE} you'd have about {PROJECTED}.";
    situation.push("goal will be missed at the current pace; it is reached later than the deadline");
  } else {
    lead = "At this pace you won't reach {GOAL}.";
    situation.push("goal is not reachable at the current pace (spending more than income)");
  }
  const paceLine = fresh ? "" : s.paceGap >= 0 ? " You're {GAP} ahead of pace." : " You're {GAP} behind pace.";
  if (!fresh) { facts.GAP = friendlyUsd(Math.abs(s.paceGap)); situation.push(s.paceGap >= 0 ? "ahead of pace" : "behind pace"); }
  if (assetsCents > 0) situation.push("savings include balances the user told us about");
  const lines = [
    lead,
    `You have {SAVED} saved.${paceLine}${detail! ? ` ${detail}` : ""}`,
    onTime ? "You need {NEED_MO}/mo and you're netting {NET_MO}/mo." : "To make {DEADLINE} you'd need {NEED_MO}/mo; you're netting {NET_MO}/mo.",
  ];
  const fallback = lines.join("\n");
  const required = [...new Set([...fallback.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]))];
  for (const k of Object.keys(facts)) if (!required.includes(k)) delete facts[k];
  return { facts, situation: situation.join("; "), fallback, required };
}

export const handle: Handler = async (db, _text, ctx) => {
  const s = goalStatus(db, ctx.now);
  if (!s) return { text: "No savings goal yet. Text e.g. \"goal 10000 by june\".", tier: "local" };
  const r = goalStatusReply(s, ctx.now, manualAssetsCents(db));
  return { text: fill(r.fallback, r.facts), tier: "local" };
};
