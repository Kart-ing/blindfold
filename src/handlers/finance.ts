// Deterministic money math (tier T0). Every number a reply shows comes from here, never from a model.
import type { Database } from "bun:sqlite";

export const DAY = 86_400;
export const MONTH = 30.4375 * DAY;
const WINDOW = 90 * DAY;
const TZ = "America/Los_Angeles";
// Not spending: money moving between my own accounts. LOAN_PAYMENTS only counts as a move when it's a card payment
// (the card's own charges are counted instead); a real loan payment (student loan, car, mortgage) is spending.
const NON_SPEND = ["INCOME", "TRANSFER_IN", "TRANSFER_OUT"];
const CARD_PAYMENT = /(american express|amex|visa|mastercard|discover|card|credit).*payment|payment.*(card|credit)|autopay/i;

export type Goal = { id: number; target_cents: number; deadline: number; created_ts: number; savings_at_creation_cents: number };

export function activeGoal(db: Database): Goal | null {
  return db.query("SELECT * FROM goals WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as Goal | null;
}

// My share of an account, by the same rule as transactions: hers 0, shared 50%, mine 100%.
const ACCOUNT_SHARE = `CASE WHEN owner = 'her' THEN 0.0 WHEN shared = 1 OR owner = 'shared' THEN 0.5 ELSE 1.0 END`;

export function savingsCents(db: Database): number {
  const r = db.query(`SELECT COALESCE(SUM(balance_cents * ${ACCOUNT_SHARE}), 0) AS s FROM accounts
      WHERE type = 'depository' AND subtype = 'savings'`).get() as { s: number };
  return Math.round(r.s) + manualAssetsCents(db);
}

/** Balances the user told us about by text (manual_assets): they count toward the goal like savings. */
export function manualAssetsCents(db: Database): number {
  try {
    return (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM manual_assets").get() as { s: number }).s;
  } catch { return 0; } // a DB from before the table existed
}

// My share of a transaction: her charges never count; shared splits 50/50; unattributed counts as mine (conservative).
export const MY_SHARE = `CASE COALESCE(a.owner, 'me') WHEN 'her' THEN 0.0 WHEN 'shared' THEN 0.5 ELSE 1.0 END`;

/** My income and my spend over [start, end), by the same rules netMonthlyCents uses (the dashboard shows these). */
export function totalsBetween(db: Database, start: number, end: number): { income: number; spend: number } {
  const n = netParts(db, start, end);
  return { income: Math.round(n.income), spend: Math.round(n.spend) };
}

/** My income minus my spend over [start, end). Income gets the same ownership rule as spending. */
function netBetween(db: Database, start: number, end: number): number {
  const n = netParts(db, start, end);
  return n.income - n.spend;
}

function netParts(db: Database, start: number, end: number): { income: number; spend: number } {
  const rows = db.query(`SELECT t.amount_cents AS c, t.category AS cat, t.merchant AS m, acc.type AS acct, ${MY_SHARE} AS share
      FROM transactions t JOIN accounts acc ON acc.id = t.account_id LEFT JOIN attributions a ON a.txn_id = t.id
      WHERE t.ts >= ? AND t.ts < ?`).all(start, end) as { c: number; cat: string | null; m: string | null; acct: string; share: number }[];
  let income = 0, spend = 0;
  for (const r of rows) {
    const cat = r.cat ?? "";
    if (cat === "INCOME") { income += -r.c * r.share; continue; }
    if (NON_SPEND.includes(cat)) continue;
    if (cat === "LOAN_PAYMENTS" && (r.acct === "credit" || CARD_PAYMENT.test(r.m ?? ""))) continue;
    spend += r.c * r.share;
  }
  return { income, spend };
}

/** Same exclusions as the spend math: what counts as my spending in a category breakdown. */
export function isSpend(category: string | null, merchant: string | null, accountType: string): boolean {
  const cat = category ?? "";
  if (cat === "INCOME" || NON_SPEND.includes(cat)) return false;
  return !(cat === "LOAN_PAYMENTS" && (accountType === "credit" || CARD_PAYMENT.test(merchant ?? "")));
}

function ptParts(ts: number) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", timeZoneName: "shortOffset" })
    .formatToParts(new Date(ts * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")) - 1, offsetH: Number(get("timeZoneName").replace("GMT", "") || 0) };
}

/** Unix seconds of local midnight on the 1st of a month in PT (month may overflow, e.g. 12 → next January). */
export function ptMonthStart(year: number, month: number): number {
  const guess = Date.UTC(year, month, 1, 8) / 1000;
  return Date.UTC(year, month, 1, -ptParts(guess).offsetH) / 1000;
}

/**
 * Income minus my attributed spend, per month: the average of up to 3 most recent complete calendar months (PT).
 * With less than one complete month of history it falls back to the trailing window, scaled to a month.
 */
export function netMonthlyCents(db: Database, now: number): number {
  const first = (db.query("SELECT MIN(ts) AS t FROM transactions").get() as { t: number | null }).t;
  if (first === null) return 0;
  const { year, month } = ptParts(now);
  const months: number[] = [];
  for (let k = 1; k <= 3; k++) {
    const s = ptMonthStart(year, month - k), e = ptMonthStart(year, month - k + 1);
    if (first > s + 3 * DAY) break; // history doesn't cover (almost) all of that month
    months.push(netBetween(db, s, e));
  }
  if (months.length) return Math.round(months.reduce((a, b) => a + b, 0) / months.length);
  const start = Math.max(now - WINDOW, first);
  return Math.round((netBetween(db, start, now + 1) / Math.max(now - start, DAY)) * MONTH);
}

export type Verdict = "OK" | "TIGHT" | "NO";
export type GoalStatus = {
  goal: Goal; savings: number; netMonthly: number; monthsLeft: number;
  requiredMonthly: number; expectedToday: number; paceGap: number; projected: number;
};

export function goalStatus(db: Database, now: number): GoalStatus | null {
  const goal = activeGoal(db);
  if (!goal) return null;
  const savings = savingsCents(db);
  const netMonthly = netMonthlyCents(db, now);
  const monthsLeft = Math.max((goal.deadline - now) / MONTH, 0);
  const span = Math.max(goal.deadline - goal.created_ts, 1);
  const elapsed = Math.min(Math.max(now - goal.created_ts, 0), span);
  const expectedToday = Math.round(goal.savings_at_creation_cents + (goal.target_cents - goal.savings_at_creation_cents) * (elapsed / span));
  return {
    goal, savings, netMonthly, monthsLeft,
    requiredMonthly: monthsLeft > 0 ? Math.ceil(Math.max(goal.target_cents - savings, 0) / monthsLeft) : Math.max(goal.target_cents - savings, 0),
    expectedToday,
    paceGap: savings - expectedToday,
    projected: savings + Math.round(netMonthly * monthsLeft),
  };
}

export type Afford = GoalStatus & { price: number; afterPurchase: number; verdict: Verdict; newGoalTs: number | null };

export function affordability(db: Database, priceCents: number, now: number): Afford | null {
  const s = goalStatus(db, now);
  if (!s) return null;
  const afterPurchase = s.projected - priceCents;
  const verdict: Verdict = afterPurchase >= s.goal.target_cents ? "OK" : afterPurchase >= s.goal.target_cents * 0.9 ? "TIGHT" : "NO";
  // When the goal would be reached if they buy it, at the current pace. null = not reachable at this pace.
  const remaining = s.goal.target_cents - (s.savings - priceCents);
  const newGoalTs = remaining <= 0 ? now : s.netMonthly > 0 ? Math.round(now + (remaining / s.netMonthly) * MONTH) : null;
  return { ...s, price: priceCents, afterPurchase, verdict, newGoalTs };
}

const DELIVERY = ["%uber eats%", "%doordash%", "%grubhub%", "%postmates%", "%caviar%"];

/** My average share of a delivery order over the trailing 90 days; null with fewer than 3 orders. */
export function deliveryAvgCents(db: Database, now: number): number | null {
  const like = DELIVERY.map(() => "lower(t.merchant) LIKE ?").join(" OR ");
  const r = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents * ${MY_SHARE}), 0) AS c FROM transactions t
      LEFT JOIN attributions a ON a.txn_id = t.id
      WHERE (${like}) AND t.amount_cents > 0 AND COALESCE(a.owner, 'me') <> 'her' AND t.ts >= ? AND t.ts <= ?`)
    .get(...DELIVERY, now - WINDOW, now) as { n: number; c: number };
  return r.n >= 3 ? Math.round(r.c / r.n) : null;
}

export const usd = (c: number) => {
  const d = Math.abs(c) / 100;
  return (c < 0 ? "-$" : "$") + d.toLocaleString("en-US", { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
};
export const monthYear = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/Los_Angeles" });

/**
 * The price in free text: "$400", "400$", "400 dollars/bucks", "1,500.50", "$1.5k", "1.5k". An explicit money form wins,
 * so "iPhone 16 for $999" is $999 and "it's 400$ but it'd last 20 years" is $400. Without one, a bare number is used
 * only if it's the only number; otherwise null (ask).
 */
export function parseAmountCents(text: string): number | null {
  const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?`;
  const toCents = (m: RegExpMatchArray, k: boolean) => {
    const v = (Number(m[1].replace(/,/g, "")) + (m[2] ? Number(m[2]) : 0)) * (k ? 1000 : 1);
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  };
  const forms: [RegExp, (m: RegExpMatchArray) => boolean][] = [
    [new RegExp(String.raw`\$\s*${NUM}\s*(k)?\b`, "i"), (m) => !!m[3]],                    // $400, $1.5k
    [new RegExp(String.raw`\b${NUM}\s*(k)?\s*\$`, "i"), (m) => !!m[3]],                    // 400$, 1.5k$
    [new RegExp(String.raw`\b${NUM}\s*(k)?\s*(?:dollars?|bucks|usd)\b`, "i"), (m) => !!m[3]], // 400 dollars
    [new RegExp(String.raw`\b${NUM}\s*k\b`, "i"), () => true],                              // 1.5k
  ];
  for (const [re, isK] of forms) { const m = text.match(re); if (m) return toCents(m, isK(m)); }
  const bare = [...text.matchAll(new RegExp(String.raw`\b${NUM}\b`, "g"))];
  return bare.length === 1 ? toCents(bare[0], false) : null;
}

/** "it would last me like 20 years" / "lasts 5 yrs" → 20 / 5; null when the text doesn't say. */
export function parseLifetimeYears(text: string): number | null {
  const m = text.match(/\blast(?:s|ing)?\b[^.?!\d]{0,20}?(\d{1,2})\s*(?:years?|yrs?)\b/i);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 50 ? n : null;
}
