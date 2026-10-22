import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { affordability } from "../src/handlers/finance";
import { findMatches, matchReceipts } from "../src/ingest/match";
import { geofence, knownPeople, parseReceipt, receiptAddresses } from "../src/ingest/receipts";
import { DEMO_NOW, rebuild } from "../src/ingest/seed";
import { setPlace } from "../src/attribution/engine";

const MAIL = join(import.meta.dir, "../fixtures/mail");
const PLACES = [
  { label: "HOME", address: "1550 Mission Street, San Francisco, CA 94103", lat: 37.7744, lng: -122.4192 },
  { label: "WORK", address: "1 Market Street, San Francisco, CA 94105", lat: 37.7941, lng: -122.3943 },
];
const parse = (file: string) => parseReceipt(readFileSync(join(MAIL, file), "utf8"), join(MAIL, file), PLACES);
const tmp = () => join(mkdtempSync(join(tmpdir(), "fin-seed-")), "fin.db");

describe("receipt parsers (one per template)", () => {
  test("Uber ride (HTML)", () => {
    expect(parse("commute-10-14.eml")).toMatchObject({ source: "uber", amount_cents: 2800, pickup_label: "HOME", dropoff_label: "WORK", items: null });
  });
  test("Lyft ride (plain text), OTHER endpoint", () => {
    expect(parse("airport-10-08.eml")).toMatchObject({ source: "lyft", amount_cents: 9175, pickup_label: "OTHER", dropoff_label: "HOME" });
  });
  test("Uber Eats (HTML): drinks are not entrees", () => {
    expect(parse("dinner-10-13.eml")).toMatchObject({ source: "uber_eats", amount_cents: 2825, subtotal_cents: 1950, items: 1, dropoff_label: "HOME" });
  });
  test("DoorDash (plain text): multi-person", () => {
    expect(parse("dinner-10-10.eml")).toMatchObject({ source: "doordash", amount_cents: 6840, subtotal_cents: 5100, items: 3 });
  });
  test("Uber tip receipt", () => {
    expect(parse("tipped-2026-10-15-tip.eml")).toMatchObject({ source: "uber", amount_cents: 400, pickup_label: "WORK", dropoff_label: "HOME" });
  });
  test("unknown sender is rejected", () => {
    expect(() => parseReceipt("From: x@evil.test\nDate: Wed, 14 Oct 2026 15:15:00 GMT\n\nTotal $1.00", "x.eml", PLACES)).toThrow();
  });
  test("geofence: 250m radius, unknown address -> OTHER", () => {
    expect(geofence("1550 mission st, san francisco, ca 94103", PLACES)).toBe("HOME");
    expect(geofence("1355 Market Street, San Francisco, CA 94103", PLACES)).toBe("OTHER"); // ~300m from HOME
    expect(geofence("1 Nowhere Lane", PLACES)).toBe("OTHER");
  });
});

describe("matcher", () => {
  function db() {
    const d = openDb(":memory:");
    d.run("INSERT INTO accounts VALUES ('amex','A','1009','amex','credit','credit card',1,'shared',0,0)");
    return d;
  }
  const T = 1792000000;
  const tx = (d: ReturnType<typeof db>, id: string, ts: number, cents: number, merchant = "Uber") =>
    d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES (?,?,?,?,?)", [id, "amex", ts, cents, merchant]);
  const rc = (d: ReturnType<typeof db>, id: string, ts: number, cents: number, source = "uber") =>
    d.run("INSERT INTO receipts(id, source, ts, amount_cents, raw_path) VALUES (?,?,?,?,?)", [id, source, ts, cents, "/x"]);
  const pairs = (d: ReturnType<typeof db>) => Object.fromEntries(findMatches(d).map(m => [m.receipt_id, m.txn_id]));

  test("two same-amount rides on one day pair by closest time, 1:1", () => {
    const d = db();
    tx(d, "am", T, 2800); tx(d, "pm", T + 9 * 3600, 2800);
    rc(d, "r-am", T + 300, 2800); rc(d, "r-pm", T + 9 * 3600 + 300, 2800);
    expect(pairs(d)).toEqual({ "r-am": "am", "r-pm": "pm" });
  });
  test("tip: receipt total = fare + later tip charge (<=72h, <=20%)", () => {
    const d = db();
    tx(d, "fare", T, 2500); tx(d, "tip", T + 2 * 3600, 400);
    rc(d, "r-fare", T + 300, 2900); rc(d, "r-tip", T + 2 * 3600 + 300, 400);
    expect(pairs(d)).toEqual({ "r-fare": "fare", "r-tip": "tip" });
  });
  test("no tip match without a sibling charge, or a tip over 20%", () => {
    const d = db();
    tx(d, "fare", T, 2500); rc(d, "r", T + 300, 2900);
    expect(findMatches(d)).toEqual([]);
    tx(d, "tip", T + 3600, 1000); rc(d, "r2", T + 600, 3500);
    expect(pairs(d)["r2"]).toBeUndefined();
  });
  test("amount ±$0.50 and time ≤48h bounds; merchant family must agree", () => {
    const d = db();
    tx(d, "ok", T, 2800); rc(d, "r-ok", T + 48 * 3600, 2850);
    tx(d, "late", T + 1e6, 2800); rc(d, "r-late", T + 1e6 + 48 * 3600 + 1, 2800);
    tx(d, "off", T + 2e6, 2800); rc(d, "r-off", T + 2e6, 2851);
    tx(d, "eats", T + 3e6, 2800, "Uber Eats"); rc(d, "r-eats", T + 3e6, 2800, "uber");
    expect(pairs(d)).toEqual({ "r-ok": "ok" });
  });
  test("never matches one receipt twice", () => {
    const d = db();
    tx(d, "a", T, 2800); tx(d, "b", T + 60, 2800); rc(d, "r", T + 30, 2800);
    expect(findMatches(d)).toHaveLength(1);
    expect(matchReceipts(d)).toBe(1);
  });
});

describe("seeded fixture", () => {
  const path = tmp();
  const { db, summary } = rebuild(path);

  test("every transaction attributed; every ride/food charge has a matched receipt", () => {
    expect(summary.attributed).toBe(summary.transactions);
    expect(summary.matched).toBe(summary.receipts);
    const unmatched = db.query(`SELECT t.id FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
      WHERE t.merchant IN ('Uber','Lyft','Uber Eats','DoorDash') AND a.receipt_id IS NULL`).all();
    expect(unmatched).toEqual([]);
  });

  test("tuning: $400 jacket is TIGHT, slightly behind pace", () => {
    const a = affordability(db, 40000, DEMO_NOW)!;
    expect(a.verdict).toBe("TIGHT");
    expect(a.paceGap).toBeGreaterThan(-30000);
    expect(a.paceGap).toBeLessThan(-10000);
  });

  test("demo facts: Oct commute ≈ $450, 2+ delivery dinners in last 7 days, one injection memo, people", () => {
    const commute = db.query(`SELECT SUM(t.amount_cents) AS s FROM transactions t JOIN attributions a ON a.txn_id = t.id
      WHERE a.rule = 3 AND t.ts >= ?`).get(PT_OCT1) as { s: number };
    expect(Math.abs(commute.s - 45000)).toBeLessThan(2000);
    const dinners = db.query(`SELECT COUNT(DISTINCT date(ts, 'unixepoch', '-7 hours')) AS n FROM transactions
      WHERE merchant IN ('Uber Eats','DoorDash') AND ts > ?`).get(DEMO_NOW - 7 * 86400) as { n: number };
    expect(dinners.n).toBeGreaterThanOrEqual(2);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE 'ignore previous instructions%'").get()).toEqual({ n: 1 });
    expect(knownPeople(db)).toEqual(["Aisha", "Marcus", "Priya", "Priya Shah"]);
  });

  test("Apple Pay on the Amex at 11am on a weekday is hers", () => {
    expect(db.query("SELECT owner, rule FROM attributions WHERE txn_id = 'apple-pay-weekday-11am'").get()).toEqual({ owner: "her", rule: 2 });
  });

  test("raw addresses appear in no DB column (only places, for HOME/WORK, and the .eml at raw_path)", () => {
    const addresses = receiptAddresses(db);
    expect(addresses.length).toBeGreaterThanOrEqual(4);
    const needles = addresses.flatMap(a => [a, a.split(",")[0]]); // full and street-only forms
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name);
    for (const table of tables) {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
      for (const r of db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        for (const c of cols) {
          if ((table === "receipts" && c === "raw_path") || (table === "places" && c === "address")) continue;
          const v = String(r[c] ?? "");
          for (const n of needles) expect(v.includes(n) ? `${table}.${c} contains ${n}` : "").toBe("");
        }
      }
    }
  });

  test("setPlace re-geofences receipts: moving WORK turns commutes into OTHER rides", () => {
    const { db: d } = rebuild(tmp());
    expect(setPlace(d, "WORK", "24 Willie Mays Plaza, San Francisco, CA 94107").ok).toBe(true);
    expect(d.query("SELECT owner, rule, needs_prompt FROM attributions WHERE txn_id = 'commute-10-14'").get())
      .toEqual({ owner: "me", rule: 7, needs_prompt: 1 });
  });

  test("seed is deterministic", () => {
    const { db: again } = rebuild(tmp());
    const dump = (d: typeof db) => ["accounts", "transactions", "places", "goals", "attributions"]
      .map(t => JSON.stringify(d.query(`SELECT * FROM ${t} ORDER BY 1`).all())).join("\n")
      + JSON.stringify(d.query("SELECT id, source, email_id, ts, amount_cents, pickup_label, dropoff_label, items, subtotal_cents FROM receipts ORDER BY id").all());
    expect(dump(again)).toBe(dump(db));
  });
});

const PT_OCT1 = Math.floor(Date.parse("2026-10-01T00:00:00-07:00") / 1000);

describe("plaid mapping", () => {
  test("AplPay descriptor -> wallet apple_pay; amounts in cents; merchant cleaned", async () => {
    const { mapTransaction } = await import("../src/ingest/plaid");
    const t = mapTransaction({ transaction_id: "x", account_id: "a", amount: 64.2, date: "2026-10-14", authorized_datetime: "2026-10-14T18:00:00Z",
      name: "AplPay SEPHORA", original_description: "AplPay SEPHORA SAN FRANCISCO CA", payment_channel: "in store",
      personal_finance_category: { primary: "GENERAL_MERCHANDISE" } });
    expect(t).toMatchObject({ id: "plaid-x", account_id: "plaid-a", amount_cents: 6420, merchant: "SEPHORA", wallet: "apple_pay", category: "GENERAL_MERCHANDISE" });
    expect(mapTransaction({ transaction_id: "y", account_id: "a", amount: -3250, date: "2026-10-05", name: "PAYROLL" }))
      .toMatchObject({ amount_cents: -325000, wallet: null, ts: Math.floor(Date.parse("2026-10-05T12:00:00-07:00") / 1000) });
  });
});
