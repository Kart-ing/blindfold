import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { affordability, goalStatus, netMonthlyCents, parseAmountCents, parseLifetimeYears, ptMonthStart, usd, DAY } from "../src/handlers/finance";
import { affordReply, fill, friendlyMonth, friendlyUsd, handle as afford } from "../src/handlers/afford";
import { handle as goalSet, deadlineFor, parseGoalAmountCents } from "../src/handlers/goal_set";
import { goalStatusReply, handle as goalStatusH } from "../src/handlers/goal_status";
import { monthYear } from "../src/handlers/finance";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000); // Oct 22 2026 12:00 PT

function seed() {
  const db = openDb(":memory:");
  db.run("INSERT INTO accounts VALUES ('chk','Checking','1111','chase','depository','checking',0,'me',300000,?)", [NOW]);
  db.run("INSERT INTO accounts VALUES ('sav','Savings','2222','chase','depository','savings',0,'me',620000,?)", [NOW]);
  db.run("INSERT INTO accounts VALUES ('amex','Amex','4417','amex','credit','credit card',1,'me',90000,?)", [NOW]);
  let n = 0;
  const tx = (acct: string, daysAgo: number, cents: number, cat: string, owner?: string) => {
    const id = `t${n++}`;
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?,?,?,?,?,?)",
      [id, acct, NOW - daysAgo * DAY, cents, "M", cat]);
    if (owner) db.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES (?,?,7,0.5)", [id, owner]);
  };
  for (const d of [90, 60, 30]) tx("chk", d, -650000, "INCOME");          // $6,500/mo income
  for (const d of [89, 59, 29]) tx("chk", d, 300000, "RENT_AND_UTILITIES"); // rent
  for (const d of [80, 50, 20]) tx("chk", d, 200000, "GENERAL_MERCHANDISE", "me");
  for (const d of [70, 40, 10]) tx("amex", d, 60000, "FOOD_AND_DRINK", "shared"); // counts $300
  for (const d of [65, 35, 5]) tx("amex", d, 99999, "GENERAL_MERCHANDISE", "her"); // must not count
  for (const d of [75, 45, 15]) { tx("chk", d, 100000, "TRANSFER_OUT"); tx("sav", d, -100000, "TRANSFER_IN"); }
  for (const d of [74, 44, 14]) tx("chk", d, 120000, "LOAN_PAYMENTS");
  db.run("UPDATE transactions SET merchant = 'American Express Payment' WHERE category = 'LOAN_PAYMENTS'"); // card payments, not loans
  db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents) VALUES (1000000, ?, ?, 500000)",
    [Math.floor(Date.UTC(2027, 6, 1, 7) / 1000) - 1, Math.floor(Date.UTC(2026, 7, 1, 7) / 1000)]);
  return db;
}

describe("finance math", () => {
  test("net averages complete calendar months; her, transfers and card payments excluded", () => {
    // seed(): first txn is 90 days back (Jul 24), so Aug and Sep are complete and July isn't. Oct is in progress.
    const db = seed();
    const aug = [ptMonthStart(2026, 7), ptMonthStart(2026, 8)], sep = [ptMonthStart(2026, 8), ptMonthStart(2026, 9)];
    const net = (s: number, e: number) => {
      let n = 0;
      for (const r of db.query(`SELECT t.amount_cents c, t.category cat, COALESCE(a.owner,'me') o FROM transactions t
          LEFT JOIN attributions a ON a.txn_id = t.id WHERE ts >= ? AND ts < ?`).all(s, e) as any[]) {
        const share = r.o === "her" ? 0 : r.o === "shared" ? 0.5 : 1;
        if (r.cat === "INCOME") n += -r.c * share;
        else if (!["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"].includes(r.cat)) n -= r.c * share;
      }
      return n;
    };
    expect(netMonthlyCents(db, NOW)).toBe(Math.round((net(aug[0], aug[1]) + net(sep[0], sep[1])) / 2));
  });
  test("a partial current month never skews the average", () => {
    const db = seed(); const before = netMonthlyCents(db, NOW);
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('oct','chk',?,900000,'TRAVEL')", [NOW - DAY]);
    expect(netMonthlyCents(db, NOW)).toBe(before);
  });
  test("with under a month of history it falls back to the trailing window", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO accounts(id, type) VALUES ('chk','depository')");
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('i','chk',?,-300000,'INCOME')", [NOW - 10 * DAY]);
    expect(netMonthlyCents(db, NOW)).toBe(Math.round((300000 / (10 * DAY)) * 30.4375 * DAY));
  });
  test("her income doesn't count toward my net (codex #11)", () => {
    const db = seed(); const before = netMonthlyCents(db, NOW);
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('hi','chk',?,-300000,'INCOME')", [ptMonthStart(2026, 8) + 5 * DAY]);
    db.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES ('hi','her',1,1)");
    expect(netMonthlyCents(db, NOW)).toBe(before);
  });
  test("a real loan payment is spending; a card payment isn't (codex #16)", () => {
    const db = seed(); const before = netMonthlyCents(db, NOW), mid = ptMonthStart(2026, 8) + 5 * DAY;
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES ('cc','chk',?,50000,'American Express Payment','LOAN_PAYMENTS')", [mid]);
    expect(netMonthlyCents(db, NOW)).toBe(before);
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES ('sl','chk',?,100000,'Navient Student Loan','LOAN_PAYMENTS')", [mid]);
    expect(netMonthlyCents(db, NOW)).toBe(before - 50000); // $1,000 in Sep, averaged over 2 months
  });
  test("savings use the account share: shared 50%, hers 0 (codex #15)", () => {
    const db = seed();
    db.run("INSERT INTO accounts(id, type, subtype, shared, owner, balance_cents) VALUES ('js','depository','savings',1,'shared',1000000)");
    db.run("INSERT INTO accounts(id, type, subtype, shared, owner, balance_cents) VALUES ('hs','depository','savings',0,'her',5000000)");
    expect(goalStatus(db, NOW)!.savings).toBe(620000 + 500000);
  });
  test("her charges never move the number", () => {
    const db = seed(); const before = netMonthlyCents(db, NOW);
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('big','amex',?,5000000,'TRAVEL')", [ptMonthStart(2026, 8) + 5 * DAY]);
    db.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES ('big','her',2,0.95)");
    expect(netMonthlyCents(db, NOW)).toBe(before);
  });
  test("unattributed spend counts as mine", () => {
    const db = seed(); const before = netMonthlyCents(db, NOW);
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('u','amex',?,30438,'TRAVEL')", [ptMonthStart(2026, 8) + 5 * DAY]);
    expect(netMonthlyCents(db, NOW)).toBeLessThan(before);
  });
  test("pace and projection", () => {
    const s = goalStatus(seed(), NOW)!;
    expect(s.savings).toBe(620000);
    expect(s.expectedToday).toBeGreaterThan(500000);
    expect(s.paceGap).toBe(s.savings - s.expectedToday);
    expect(s.projected).toBe(s.savings + Math.round(s.netMonthly * s.monthsLeft));
  });
  test("verdict thresholds are monotonic in price", () => {
    const db = seed();
    const order = { OK: 0, TIGHT: 1, NO: 2 } as const;
    let prev = 0;
    for (const p of [0, 1000, 100000, 500000, 900000, 2000000, 5000000]) {
      const v = order[affordability(db, p, NOW)!.verdict];
      expect(v).toBeGreaterThanOrEqual(prev); prev = v;
    }
  });
  test("goal unreachable when net <= 0", () => {
    const db = seed();
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, category) VALUES ('x','chk',?,9000000,'TRAVEL')", [ptMonthStart(2026, 8) + 5 * DAY]);
    expect(affordability(db, 40000, NOW)!.newGoalTs).toBeNull();
  });
});

describe("parsing", () => {
  test.each([["can I buy a $400 jacket", 40000], ["1,500.50 trip", 150050], ["$1.5k", 150000], ["$10k by june", 1000000], ["no number", null], ["Can I buy an iPhone 16 for $999?", 99900], ["1.5k couch", 150000], ["buy 2 chairs for 300", null], ["goal 10000 by june", 1000000], ["Can I buy a jacket? Like it\u2019s 400$ but it\u2019s arteryx to it would last me Like 20 years", 40000], ["375$ jacket", 37500], ["it is 250 dollars", 25000], ["about 300 bucks for 2 chairs", 30000]])
    ("%s", (t, c) => expect(parseAmountCents(t as string)).toBe(c as number | null));
  test("deadline rolls to next year once the month has passed", () => {
    expect(monthYear(deadlineFor("goal 10000 by june", NOW)!)).toBe("Jun 2027");
    expect(monthYear(deadlineFor("goal 10000 by december", NOW)!)).toBe("Dec 2026");
    expect(monthYear(deadlineFor("goal 10000 by october", NOW)!)).toBe("Oct 2026"); // still 9 days left
    expect(deadlineFor("goal 10000 by june 2028", NOW)! > deadlineFor("goal 10000 by june", NOW)!).toBe(true);
  });
});

describe("goal amounts", () => {
  test.each([
    ["I want to save 40000 by December so I can quit my job and work on my startup without worrying about rent (about 1700$) and some other stuff till my OPT runs out - which is end of June.", 4000000],
    ["goal 10000 by june", 1000000], ["goal $12k by march", 1200000], ["goal 10000 by june 2027", 1000000],
    ["$10k by june", 1000000], ["save up $5,000 for a trip by may 2027", 500000], ["I need 8k by april", 800000], ["no amount by june", null],
  ])("parseGoalAmountCents(%s)", (t, c) => expect(parseGoalAmountCents(t as string)).toBe(c as number | null));
});

describe("handlers", () => {
  test("afford reply: verdict first, then why, then computed options (VOICE=plain)", async () => {
    process.env.VOICE = "plain";
    const r = await afford(seed(), "can I buy a $400 jacket?", { now: NOW });
    expect(r.tier).toBe("local");
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^(Yes, go for it|Tight, but doable|I'd hold off for now)\.$/);
    expect(r.text).toContain("$400");
    expect(r.text).toContain('Want the full plan? Text "goal".');
    expect(r.text).not.toMatch(/\{[A-Z_]+\}/); // every placeholder filled
  });
  test("price ceiling = projected headroom, rounded down to $10, shown only when it's below the price", () => {
    const a = affordability(seed(), 9_000_000, NOW)!;
    const r = affordReply(a, null);
    const headroom = a.projected - a.goal.target_cents;
    if (headroom >= 2000) expect(r.facts.CEILING).toBe(friendlyUsd(Math.floor(headroom / 1000) * 1000));
    else expect(r.facts.CEILING).toBeUndefined();
  });
  test("skip-deliveries option covers the shortfall exactly, and only when realistic", () => {
    const a = affordability(seed(), 2_000_000, NOW)!;
    const shortfall = a.goal.target_cents - a.afterPurchase;
    const r = affordReply(a, 3000);
    const n = Math.ceil(shortfall / 3000);
    if (n <= 24) { expect(r.facts.SKIP_N).toBe(String(n)); expect(r.facts.SKIP_COST).toBe(friendlyUsd(n * 3000)); expect(n * 3000).toBeGreaterThanOrEqual(shortfall); }
    else expect(r.facts.SKIP_N).toBeUndefined();
    expect(affordReply(a, null).facts.SKIP_N).toBeUndefined(); // no delivery history, no suggestion
  });
  test("lifetime framing: 'would last me like 20 years' → cost per year", async () => {
    process.env.VOICE = "plain";
    const r = await afford(seed(), "Can I buy a jacket? Like it's 400$ but it's arteryx to it would last me Like 20 years", { now: NOW });
    expect(r.text).toContain("$400");
    expect(r.text).toContain("If it really lasts 20 years, that's only ~$20 a year.");
    expect((await afford(seed(), "can I buy a $400 jacket", { now: NOW })).text).not.toContain("a year");
  });
  test.each([[4000, "$40"], [15503, "$155"], [35520, "$355"], [120000, "$1,200"], [1000000, "$10k"], [999, "$9.99"]])
    ("friendlyUsd(%d) = %s", (c, s) => expect(friendlyUsd(c as number)).toBe(s as string));
  test("friendlyMonth: bare month within a year, with the year beyond", () => {
    const june27 = Math.floor(Date.UTC(2027, 5, 30, 19) / 1000), june28 = Math.floor(Date.UTC(2028, 5, 30, 19) / 1000);
    expect(friendlyMonth(june27, NOW)).toBe("June");
    expect(friendlyMonth(june28, NOW)).toBe("June 2028");
  });
  test.each([["it would last me like 20 years", 20], ["lasts 5 yrs", 5], ["the last 3 months", null], ["2 years ago", null]])
    ("parseLifetimeYears(%s)", (t, n) => expect(parseLifetimeYears(t as string)).toBe(n as number | null));
  test("a goal set just now reads 'right on pace', never '$0 ahead'", async () => {
    process.env.VOICE = "plain";
    const db = seed();
    await goalSet(db, "goal 10000 by june", { now: NOW });
    const r = await afford(db, "can I buy a $400 jacket", { now: NOW + 60 });
    expect(r.text).toContain("right on pace for your $10k June goal");
    expect(r.text).not.toContain("$0 ahead");
  });
  test("an OK purchase offers no options, and the situation text carries no numbers", () => {
    const a = affordability(seed(), 100, NOW)!;
    const r = affordReply(a, 3000);
    expect(r.fallback).not.toContain("If you still want it");
    expect(r.situation).not.toMatch(/\d|\$/);
    expect(affordReply(affordability(seed(), 2_000_000, NOW)!, 3000).situation).not.toMatch(/\d|\$/);
  });
  test("required placeholders are exactly the facts the fallback uses", () => {
    const r = affordReply(affordability(seed(), 40000, NOW)!, 3000);
    const used = new Set([...r.fallback.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]));
    for (const k of r.required) expect(used.has(k)).toBe(true);
    for (const k of used) expect(r.required).toContain(k);
    expect(fill(r.fallback, r.facts)).not.toMatch(/\{[A-Z_]+\}/);
  });
  test("afford without a goal or price", async () => {
    const db = openDb(":memory:");
    expect((await afford(db, "can I buy a jacket", { now: NOW })).text).toContain("How much");
    expect((await afford(db, "can I buy a $40 jacket", { now: NOW })).text).toContain("goal");
  });
  test.each([["by end of 2026", "Dec 2026"], ["by the end of the year", "Dec 2026"], ["by 2027", "Dec 2027"], ["by end of 2027", "Dec 2027"]])
    ("deadlineFor(%s) = %s", (t, m) => expect(monthYear(deadlineFor(t as string, NOW)!)).toBe(m as string));
  test("the live sentence sets $40k by Dec 2026 locally too", async () => {
    const r = await goalSet(seed(), "So I wanna save 40k $ by end of 2026, so that basically I can quit my job. My rent is around 1800$ and you know my approx monthly spend, I usually send my friend Priya the rent, cause she pays it.", { now: NOW });
    expect(r.text).toStartWith("Goal set: $40,000 by Dec 2026.");
  });
  test("changing the amount without a date keeps the current deadline", async () => {
    const db = seed();
    await goalSet(db, "goal 40000 by december", { now: NOW });
    const r = await goalSet(db, "Let's change the goal to 30k", { now: NOW + 60 });
    expect(r.text).toStartWith("Goal set: $30,000 by Dec 2026.");
  });
  test("typo 'my' for 'by' still finds the deadline", () => {
    expect(monthYear(deadlineFor("No. 40k my Dec 2026", NOW)!)).toBe("Dec 2026");
  });
  test("a balance the user told us about counts toward savings", () => {
    const db = seed(); const before = goalStatus(db, NOW)!.savings;
    db.run("INSERT INTO manual_assets(name, amount_cents, created_ts) VALUES ('Robinhood', 1000000, ?)", [NOW]);
    expect(goalStatus(db, NOW)!.savings).toBe(before + 1000000);
  });
  test("a fresh goal that misses never says 'right on pace'", async () => {
    const db = seed();
    await goalSet(db, "goal 40000 by december", { now: NOW });
    const r = await goalStatusH(db, "how am I doing", { now: NOW + 60 });
    expect(r.text).toMatch(/you'd reach \$40k around .+, not December\./);
    expect(r.text).not.toContain("on pace");
  });
  test("goalStatusReply: facts are exactly the placeholders used, and the situation has no numbers", () => {
    const db = seed();
    const s = goalStatus(db, NOW)!;
    const r = goalStatusReply(s, NOW);
    const used = new Set([...r.fallback.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.keys(r.facts).sort());
    expect(r.situation).not.toMatch(/\d|\$/);
  });
  test("goal_set says where the current pace lands", async () => {
    const r = await goalSet(seed(), "I want to save 40000 by December", { now: NOW });
    expect(r.text).toStartWith("Goal set: $40,000 by Dec 2026.");
    expect(r.text).toMatch(/At your current pace you('d get there around \w+|'ll get there on time| won't get there)/);
  });
  test("goal_set replaces the active goal", async () => {
    const db = seed();
    await goalSet(db, "goal $12k by march", { now: NOW });
    const rows = db.query("SELECT target_cents, active FROM goals ORDER BY id").all() as any[];
    expect(rows.filter(r => r.active).length).toBe(1);
    expect(rows.at(-1)).toEqual({ target_cents: 1200000, active: 1 });
  });
});
