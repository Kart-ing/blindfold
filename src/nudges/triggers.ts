// Nudge triggers (PRD §6), all T0. Only my spend counts (MY_SHARE: me 100%, shared 50%); her charges never count.
import type { Database } from "bun:sqlite";
import { goalStatus, MY_SHARE } from "../handlers/finance.ts";
import { dayKey, daysInMonth, fromLocal, localParts, minuteOfDay, money, monthKey, startOfDay, startOfMonth } from "../imessage/clock.ts";
import { fill } from "../voice/phrase.ts";
import { friendlyUsd } from "../handlers/afford.ts";

/**
 * A nudge ready to send. Every number is computed here; `fallback` (placeholders) + `facts` (formatted values) is the
 * deterministic wording, `situation` is the number-free brief phrase() gives the on-device model, and `text` is the
 * filled fallback (what VOICE=plain sends).
 */
export type Candidate = {
  kind: "commute_rides" | "dinner_delivery" | "new_recurring"; periodKey: string; txnIds: string[];
  text: string; fallback: string; facts: Record<string, string>; situation: string;
};

const nudge = (c: Omit<Candidate, "text">): Candidate => ({ ...c, text: fill(c.fallback, c.facts) });

// Same ownership as MY_SHARE (unattributed counts as mine); excluding 'her' explicitly keeps her rows out of every txn list.
const MINE = `COALESCE(a.owner, 'me') IN ('me', 'shared')`;
const FROM = `transactions t LEFT JOIN attributions a ON a.txn_id = t.id LEFT JOIN receipts r ON r.id = a.receipt_id`;
const NON_SPEND = `('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS')`;

export const COMMUTE_LIMIT_CENTS = 30_000;
// "What a few train days save": 3 days, a ride each way, at an assumed $2.50 fare.
export const TRAIN_DAYS = 3;
export const TRAIN_FARE_CENTS = 250;
export const MIN_GAP_CENTS = 2_500;

// Morning only, when the ride to work is being booked. (Quiet hours end at 08:00, so in practice 08:00–10:00.)
export const COMMUTE_WINDOW = [7 * 60 + 30, 10 * 60] as const;

export function commuteRides(db: Database, now: number): Candidate | null {
  const t = minuteOfDay(now);
  if (t < COMMUTE_WINDOW[0] || t >= COMMUTE_WINDOW[1]) return null;
  const rows = db.query(`SELECT t.id, t.amount_cents * ${MY_SHARE} AS mine FROM ${FROM}
      WHERE ${MINE} AND t.amount_cents > 0 AND t.ts >= ? AND t.ts <= ?
        AND r.pickup_label IN ('HOME', 'WORK') AND r.dropoff_label IN ('HOME', 'WORK') AND r.pickup_label != r.dropoff_label`)
    .all(startOfMonth(now), now) as { id: string; mine: number }[];
  const sum = rows.reduce((s, r) => s + r.mine, 0);
  const day = localParts(now).d;
  const pace = (sum / day) * daysInMonth(now);
  const over = sum > COMMUTE_LIMIT_CENTS;
  // Pace needs a few days of data, or one ride on the 1st projects to a huge month.
  if (!over && !(day >= 5 && pace > COMMUTE_LIMIT_CENTS)) return null;
  const save = Math.round(TRAIN_DAYS * 2 * (sum / rows.length - TRAIN_FARE_CENTS));
  const facts: Record<string, string> = {
    COST: friendlyUsd(Math.round(over ? sum : pace)), RIDES: `${rows.length} ride${rows.length === 1 ? "" : "s"}`,
    DAYS: String(TRAIN_DAYS), SAVE: friendlyUsd(save), FARE: money(TRAIN_FARE_CENTS),
  };
  const first = over ? "{COST} on office-commute Ubers this month ({RIDES})." : "On pace for {COST} on office-commute Ubers this month ({RIDES} so far).";
  const second = save >= 100 ? "Train {DAYS} days instead and you'd keep about {SAVE} (at {FARE} a ride)." : "Train a few days?";
  return nudge({ kind: "commute_rides", periodKey: monthKey(now), txnIds: rows.map((r) => r.id), facts,
    fallback: `${first}\n${second}`,
    situation: `morning; ${over ? "office commute rides this month already cost a lot" : "office commute rides are on pace to cost a lot this month"}; suggest taking the train a few days and say what it saves` });
}

const DELIVERY = `(r.source IN ('uber_eats', 'doordash') OR LOWER(COALESCE(t.merchant, '')) LIKE '%doordash%'
  OR LOWER(COALESCE(t.merchant, '')) LIKE '%uber eats%' OR LOWER(COALESCE(t.merchant, '')) LIKE '%ubereats%')`;

export function dinnerDelivery(db: Database, now: number): Candidate | null {
  const t = minuteOfDay(now);
  if (t < 17 * 60 + 30 || t >= 19 * 60) return null;
  const status = goalStatus(db, now);
  if (!status || status.paceGap > -MIN_GAP_CENTS) return null; // don't nag about a few dollars
  // Dinner = a delivery charge between 17:00 and 22:00 local on one of the last 7 days (not today).
  const today = startOfDay(now);
  const days: string[] = [];
  const txnIds: string[] = [];
  const merchants = new Map<string, number>();
  const spent: number[] = [];
  for (let i = 1; i <= 7; i++) {
    const p = localParts(today - i * 86_400 + 12 * 3600);
    const from = fromLocal(p.y, p.m, p.d, 17, 0), to = fromLocal(p.y, p.m, p.d, 22, 0);
    const rows = db.query(`SELECT t.id, t.merchant, t.amount_cents * ${MY_SHARE} AS mine FROM ${FROM} WHERE ${MINE} AND ${DELIVERY} AND t.amount_cents > 0 AND t.ts >= ? AND t.ts < ?`)
      .all(from, to) as { id: string; merchant: string | null; mine: number }[];
    if (!rows.length) continue;
    days.push(dayKey(from));
    for (const r of rows) {
      txnIds.push(r.id);
      spent.push(r.mine);
      const m = /eats/i.test(r.merchant ?? "") ? "Uber Eats" : /doordash/i.test(r.merchant ?? "") ? "DoorDash" : (r.merchant ?? "delivery");
      merchants.set(m, (merchants.get(m) ?? 0) + 1);
    }
  }
  if (days.length < 2) return null;
  const top = [...merchants].sort((a, b) => b[1] - a[1])[0][0];
  const typical = spent.reduce((a, b) => a + b, 0) / spent.length;
  return nudge({ kind: "dinner_delivery", periodKey: dayKey(now), txnIds,
    facts: { MERCHANT: top, GAP: friendlyUsd(Math.abs(status.paceGap)), TYPICAL: friendlyUsd(Math.round(typical)) },
    fallback: "Skip {MERCHANT} tonight? Goal is {GAP} behind pace.\nA delivery dinner runs you about {TYPICAL}. Cook or grab pickup and it goes toward the goal.",
    situation: "evening; savings goal is behind pace; several delivery dinners this week; suggest cooking or pickup tonight instead" });
}

// Not time-sensitive: midday, so it never competes with the commute (morning) or dinner (evening) beats.
export const RECURRING_WINDOW = [12 * 60, 14 * 60] as const;

export function newRecurring(db: Database, now: number): Candidate[] {
  const t = minuteOfDay(now);
  if (t < RECURRING_WINDOW[0] || t >= RECURRING_WINDOW[1]) return [];
  const p = localParts(now);
  const cur = startOfMonth(now);
  const prev = p.m === 1 ? fromLocal(p.y - 1, 12, 1) : fromLocal(p.y, p.m - 1, 1);
  const rows = db.query(`SELECT t.merchant AS merchant, t.amount_cents AS amount, MAX(t.id) AS id1, MIN(t.id) AS id0 FROM ${FROM}
      WHERE ${MINE} AND t.merchant IS NOT NULL AND t.amount_cents > 0 AND COALESCE(t.category, '') NOT IN ${NON_SPEND}
        AND t.ts >= ? AND t.ts <= ?
      GROUP BY t.merchant, t.amount_cents
      HAVING SUM(t.ts < ?) >= 1 AND SUM(t.ts >= ?) >= 1
        AND NOT EXISTS (SELECT 1 FROM transactions o LEFT JOIN attributions oa ON oa.txn_id = o.id
          WHERE o.merchant = t.merchant AND o.ts < ? AND COALESCE(oa.owner, 'me') != 'her')`)
    .all(prev, now, cur, cur, prev) as { merchant: string; amount: number; id0: string; id1: string }[];
  return rows.map((r) => nudge({ kind: "new_recurring", periodKey: r.merchant, txnIds: [...new Set([r.id0, r.id1])],
    // The monthly price stays exact ($15.49/mo is how subscriptions are quoted); the yearly total reads like afford.
    facts: { MERCHANT: r.merchant, MONTHLY: money(r.amount), YEARLY: friendlyUsd(r.amount * 12) },
    fallback: "New recurring charge: {MERCHANT} {MONTHLY}/mo.\nThat's about {YEARLY} a year. Keep it?",
    situation: "a new subscription charged the same amount two months in a row; give the yearly cost and ask if it's worth keeping" }));
}
