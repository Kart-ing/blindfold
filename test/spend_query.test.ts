import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { DAY } from "../src/handlers/finance";
import { keywordQuery, makeHandle } from "../src/handlers/spend_query";
import { monthRange } from "../src/cloud/dsl";
import { setProvider } from "../src/cloud/egress";
import { noFm, type Fm } from "../src/imessage/fm";

const NOW = Math.floor(Date.UTC(2026, 9, 22, 19) / 1000); // Oct 22 2026 12:00 PT
const ctx = { now: NOW };

// Any network attempt fails the file.
let calls = 0;
const prev = setProvider(async () => { calls++; throw new Error("spend_query must not reach the cloud"); });
afterAll(() => { setProvider(prev); expect(calls).toBe(0); });

function db() {
  const d = openDb(":memory:");
  d.run("INSERT INTO accounts VALUES ('amex','Amex','4417','amex','credit','credit card',1,'shared',0,?)", [NOW]);
  let n = 0;
  const tx = (ts: number, cents: number, merchant: string, cat: string, owner?: string) => {
    const id = `t${n++}`;
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?,?,?,?,?,?)", [id, "amex", ts, cents, merchant, cat]);
    if (owner) d.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES (?,?,7,0.5)", [id, owner]);
  };
  const [sep] = monthRange(NOW, 1), [aug] = monthRange(NOW, 2), [oct] = monthRange(NOW, 0);
  tx(sep + DAY, 10000, "Blue Bottle Coffee", "FOOD_AND_DRINK", "me");
  tx(sep + DAY, 4000, "Blue Bottle Coffee", "FOOD_AND_DRINK", "shared"); // 2000
  tx(sep + DAY, 30000, "Nordstrom", "GENERAL_MERCHANDISE", "her"); // 0
  tx(sep + DAY, 25000, "Costco", "GENERAL_MERCHANDISE", "me");
  tx(sep + DAY, 9000, "Uber", "TRANSPORTATION", "me");
  tx(aug + DAY, 77700, "Costco", "FOOD_AND_DRINK", "me");
  tx(oct + DAY, 1500, "Blue Bottle Coffee", "FOOD_AND_DRINK", "me");
  return d;
}

const fakeFm = (out: Record<string, unknown> | null): Fm => ({ extract: async () => out, respond: async () => null });

describe("spend_query (on-device)", () => {
  test("keyword fallback: food last month, my share only", async () => {
    const r = await makeHandle(noFm)(db(), "How much did I spend on food last month?", ctx);
    expect(r).toEqual({ text: "You spent $120 on food and drink last month (your share).", tier: "on-device" });
    expect(r.ledger).toBeUndefined();
  });
  test("top merchants in a named month; her merchant never appears", async () => {
    const r = await makeHandle(noFm)(db(), "top 3 merchants in September", ctx);
    expect(r.text).toBe("Top 3 merchants last month: Costco $250, Blue Bottle Coffee $120, Uber $90.");
    expect(r.text).not.toContain("Nordstrom");
  });
  test("a merchant named in the question narrows the sum", async () => {
    const r = await makeHandle(noFm)(db(), "how much at blue bottle in september", ctx);
    expect(r.text).toBe("You spent $120 at Blue Bottle Coffee last month (your share).");
  });
  test("fm extraction is used when it works", async () => {
    const r = await makeHandle(fakeFm({ kind: "total", category: "food_and_drink", period: "august" }))(db(), "what did groceries run me in aug", ctx);
    expect(r.text).toBe("You spent $777 on food and drink in August (your share).");
  });
  test("fm returning junk falls back to keywords", async () => {
    const r = await makeHandle(fakeFm({ kind: "DROP TABLE", category: "x' OR 1=1", period: 7 }))(db(), "how much on food last month", ctx);
    expect(r.text).toBe("You spent $120 on food and drink last month (your share).");
  });
  test("parsing: this month default, 'may I' is not May, top N clamps", () => {
    expect(keywordQuery("how much have I spent", NOW)).toMatchObject({ kind: "total", category: null, month: 0 });
    expect(keywordQuery("may I see my food spend", NOW).month).toBe(0);
    expect(keywordQuery("food in may", NOW).month).toBe(5);
    expect(keywordQuery("top 50 merchants", NOW).n).toBe(10);
  });
});

describe("spend_query real-data fixes (eng1)", () => {
  test("a period named in the text wins over the model's ('last month' = the previous complete month)", async () => {
    const r = await makeHandle(fakeFm({ kind: "total", category: "any", period: "this_month" }))(db(), "How much did I spend on Uber last month?", ctx);
    expect(r.text).toBe("You spent $90 at Uber last month (your share).");
  });
  test("a model period like '2026-09' is understood when the text names none", async () => {
    const r = await makeHandle(fakeFm({ kind: "total", category: "transportation", period: "2026-09" }))(db(), "how much on rides", ctx);
    expect(r.text).toBe("You spent $90 on transportation last month (your share).");
  });
  test("no category and no merchant = all my spending that month, even if the model says 'income'", async () => {
    for (const f of [noFm, fakeFm({ kind: "total", category: "income", period: "last_month" })]) {
      const r = await makeHandle(f)(db(), "How much did I spend last month?", ctx);
      expect(r.text).toBe("You spent $460 last month (your share)."); // 100 + 20 (shared half) + 250 + 90; hers counts 0
    }
  });
  test("Top N never promises more rows than there are; none → a plain sentence", async () => {
    expect((await makeHandle(noFm)(db(), "top 5 merchants last month", ctx)).text).toBe("Top 3 merchants last month: Costco $250, Blue Bottle Coffee $120, Uber $90.");
    expect((await makeHandle(noFm)(db(), "top 3 transportation merchants last month", ctx)).text).toBe("Top 1 transportation merchant last month: Uber $90.");
    expect((await makeHandle(noFm)(db(), "top 3 travel merchants last month", ctx)).text).toBe("No spending on travel last month.");
  });
});

test("a named merchant isn't also filtered by a keyword category ('uber' is transportation, Uber Eats is food)", async () => {
  const d = openDb(":memory:");
  d.run("INSERT INTO accounts VALUES ('card','Card','1111','bank','credit','credit card',0,'me',0,?)", [NOW]);
  const [sep] = monthRange(NOW, 1);
  d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES ('e1','card',?,2597,'Uber Eats','FOOD_AND_DRINK'), ('e2','card',?,2597,'Uber Eats','FOOD_AND_DRINK'), ('r1','card',?,1800,'Uber','TRANSPORTATION')", [sep + DAY, sep + 2 * DAY, sep + DAY]);
  expect((await makeHandle(noFm)(d, "How much did I spend on Uber Eats last month?", ctx)).text).toBe("You spent $51.94 at Uber Eats last month (your share).");
  expect((await makeHandle(noFm)(d, "How much did I spend on Uber last month?", ctx)).text).toBe("You spent $18 at Uber last month (your share).");
});
