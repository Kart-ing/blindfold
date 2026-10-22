// Real-data ingest (src/ingest/real.ts, categorize.ts, seed-real.ts) on SYNTHETIC inputs only: invented addresses, merchants
// and amounts that copy the layouts, never real mail or statements.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { categorizeAll, categorizeByRule, cleanMerchant } from "../src/ingest/categorize";
import { addressKey, classifyMailbox, dedupe, inferHomeWork, labelFor, parseMail, realAddressesFor, subjectKind, type RealMail } from "../src/ingest/real";
import { ingestStatements } from "../src/ingest/seed-real";

const A1 = "100 Example St, Springfield, CA 90001, US";
const A2 = "200 Sample Ave, Springfield, CA 90002, US";
const eml = (from: string, subject: string, date: string, html: string) =>
  `From: ${from}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}`;
const RIDE = eml("Uber Receipts <noreply@uber.com>", "Your Thursday morning trip with Uber", "Thu, 15 Oct 2026 16:20:00 +0000",
  `<p>Total</p><p>$12.34</p><p>8:00 AM</p><p>Thursday, October 15, 2026</p><p>8:05 AM</p><p>${A1}</p><p>8:30 AM</p><p>${A2}</p><p>You rode with Sam</p>`);
const EATS = eml("Uber Receipts <noreply@uber.com>", "Your Uber Eats order with Test Kitchen", "Fri, 16 Oct 2026 02:00:00 +0000",
  `<p>Thanks for ordering</p><table><tr><td>1</td><td>Bowl</td><td>$11.00</td></tr></table><p>Tip $2.00</p><p>Total $15.50</p><p>6:40 PM</p><p>Mon, Oct 15</p><p>6:45 PM</p><p>${A2}</p><p>7:10 PM</p><p>${A1}</p>`);
const DASH = eml("DoorDash <no-reply@doordash.com>", "Order Confirmation for Sam from Test Deli", "Sat, 17 Oct 2026 03:00:00 +0000",
  `<div>Item one $9.00 Item two $11.00 Subtotal $20.00 Fees $3.00 Dasher tip $3.03 Total $26.03 Thanks</div>`);
const PROMO = eml("Uber <uber@uber.com>", "50% off your next ride", "Sat, 17 Oct 2026 03:00:00 +0000", "<p>Ride more, save more.</p>");

describe("real mail templates (synthetic)", () => {
  test("ride: total, and stops skip the date header (address lines only)", () => {
    const p = parseMail(RIDE);
    expect(subjectKind(p)).toBe("ride");
  });
  test("classifyMailbox without the model: subject pass + regex; nothing is cached", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-"));
    mkdirSync(join(root, "acct"));
    for (const [n, raw] of [["1", RIDE], ["2", EATS], ["3", DASH], ["4", PROMO]] as const) writeFileSync(join(root, "acct", `${n}.eml`), raw);
    const { mails } = await classifyMailbox(root, { useFm: false });
    const by = Object.fromEntries(mails.map((m) => [m.key, m]));
    expect(by["acct/1.eml"]).toMatchObject({ kind: "ride", via: "subject", total_cents: 1234, pickup: A1, dropoff: A2 });
    expect(by["acct/2.eml"]).toMatchObject({ kind: "eats", via: "subject", total_cents: 1550, subtotal_cents: 1350, restaurant: "Test Kitchen", pickup: A2, dropoff: A1 });
    expect(by["acct/3.eml"]).toMatchObject({ kind: "doordash", via: "subject", total_cents: 2603, subtotal_cents: 2000 });
    expect(by["acct/4.eml"]).toMatchObject({ kind: "promo", via: "subject" });
    expect(existsSync(join(root, ".classified.json"))).toBe(false); // a --no-fm dry run never freezes its guesses
  });
  test("the canary learns addresses from the cache next to the mail", () => {
    const root = mkdtempSync(join(tmpdir(), "mail-"));
    writeFileSync(join(root, ".classified.json"), JSON.stringify({ "acct/1.eml": { key: "acct/1.eml", pickup: A1, dropoff: A2 } }));
    expect(realAddressesFor(join(root, "acct", "1.eml"))).toEqual([A1, A2]);
    expect(realAddressesFor(join(root, "acct", "9.eml"))).toEqual([]);
  });
});

const ride = (key: string, ts: number, total: number, pickup: string | null = null, dropoff: string | null = null): RealMail =>
  ({ key, kind: "ride", via: "subject", ts, total_cents: total, subtotal_cents: null, restaurant: null, pickup, dropoff });
const PT = (iso: string) => Math.floor(Date.parse(`${iso}-07:00`) / 1000);

describe("dedupe, addresses, HOME/WORK", () => {
  test("a resend (≤30 min) or the same receipt in another account is dropped; two same-fare rides hours apart stay", () => {
    const kept = dedupe([ride("a/1", PT("2026-10-15T08:30:00"), 1200), ride("a/2", PT("2026-10-15T08:40:00"), 1200),
      ride("a/3", PT("2026-10-15T18:00:00"), 1200), ride("b/1", PT("2026-10-15T12:00:00"), 1200), ride("b/2", PT("2026-10-15T12:00:00"), 1300)]);
    expect(kept.map((m) => m.key)).toEqual(["a/1", "a/3", "b/2"]);
  });
  test("addressKey ignores house numbers, ranges, units, country and suffix spelling", () => {
    expect(addressKey("1100-1198 Example Street, Springfield, CA 90001, US")).toBe(addressKey("1150 Example St Apt 4, Springfield, CA 90001"));
    expect(addressKey(A1)).not.toBe(addressKey(A2));
  });
  test("HOME = most common weekday-morning pickup, WORK = most common weekday-morning dropoff", () => {
    const rides = [1, 2, 3].map((d) => ride(`a/${d}`, PT(`2026-10-1${d + 3}T08:30:00`), 1000, A1, A2)) // Wed–Fri mornings
      .concat([ride("a/9", PT("2026-10-17T09:00:00"), 1000, A2, A1)]); // a Saturday: ignored
    const { home, work, morning } = inferHomeWork(rides);
    expect(morning).toBe(3);
    expect([home?.address, work?.address]).toEqual([A1, A2]);
    expect([labelFor(A1, home, work), labelFor(A2, home, work), labelFor("9 Other Rd, Springfield, CA 90003", home, work)]).toEqual(["HOME", "WORK", "OTHER"]);
  });
});

describe("statement categories (synthetic descriptions)", () => {
  test("card payments stay recognisable as card payments, so they never count as spending", () => {
    for (const d of ["CITI CARD ONLINE PAYMENT", "CAPITAL ONE AUTOPAY PYMT", "CRCARDPMT 1234"]) {
      const c = categorizeByRule(d, true, null);
      expect(c.category).toBe("LOAN_PAYMENTS");
      expect(c.merchant).toMatch(/card payment$/);
    }
  });
  test("transfers, payroll, Zelle, interest, fees and merchant rules", () => {
    const cat = (d: string, out: boolean, hint: string | null = null) => categorizeByRule(d, out, hint);
    expect(cat("TRANSFER TO 360 PERFORMANCE SAVINGS", true).category).toBe("TRANSFER_OUT");
    expect(cat("DEPOSIT FROM 360 CHECKING", false).category).toBe("TRANSFER_IN");
    expect(cat("EXAMPLE CORP PAYROLL", false).category).toBe("INCOME");
    expect([cat("ZELLE TO SAM", true).category, cat("ZELLE FROM SAM", false).category]).toEqual(["RENT_AND_UTILITIES", "TRANSFER_IN"]); // rent and bills
    expect(cat("MONTHLY INTEREST PAID", false).category).toBe("INCOME");
    expect(cat("LATE FEE", true).category).toBe("BANK_FEES");
    expect(cat("UBER *TRIP HELP.UBER.COM", true)).toMatchObject({ merchant: "Uber", category: "TRANSPORTATION" });
    expect(cat("UBER *EATS", true)).toMatchObject({ merchant: "Uber Eats", category: "FOOD_AND_DRINK" });
    expect(cat("DOORDASH*TEST DELI", true)).toMatchObject({ merchant: "DoorDash", category: "FOOD_AND_DRINK" });
    expect(cat("SAMPLE STORE*12345", true, "Merchandise")).toMatchObject({ category: "GENERAL_MERCHANDISE", via: "hint" });
    expect(cat("APLPAY EXAMPLE SHOP", true).wallet).toBe("apple_pay");
    expect(cleanMerchant("SQ *EXAMPLE CAFE #123 SPRINGFIELD CA")).toBe("Example Cafe");
    expect(cleanMerchant("WITHDRAWAL FROM EXAMPLE UTILITIES")).toBe("Example Utilities");
  });
  test("'food' covers restaurants, cafes and groceries, not just delivery apps", () => {
    for (const d of ["SQ *EXAMPLE CAFE", "TST* EXAMPLE PIZZA", "SAFEWAY #1234", "EXAMPLE SUSHI BAR", "UBER *EATS", "DOORDASH*TEST DELI"]) {
      expect(categorizeByRule(d, true, null).category).toBe("FOOD_AND_DRINK");
    }
    for (const hint of ["Dining", "Grocery"]) expect(categorizeByRule("ZZZ PLACE", true, hint).category).toBe("FOOD_AND_DRINK");
  });
  test("without the model, unknown lines stay uncategorised and nothing is cached", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "cat-")), "c.json");
    const [c] = await categorizeAll([{ desc: "ZZZ UNKNOWN THING", outflow: true, hint: null }], cache, { useFm: false });
    expect(c.category).toBeNull();
    expect(existsSync(cache)).toBe(false);
  });
});

describe("ingestStatements (synthetic CSV exports)", () => {
  const CSV1 = ["Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
    "2026-10-06,2026-10-06,1111,SAMPLE STORE*12345,Merchandise,22.80,",
    "2026-10-06,2026-10-06,1111,SAMPLE STORE*12345,Merchandise,22.80,", // a genuine second identical purchase
    "2026-10-07,2026-10-07,1111,UBER *TRIP,Other Travel,14.20,",
    "2026-10-01,2026-10-01,1111,CAPITAL ONE AUTOPAY PYMT,Payment/Credit,,150.00",
    "2026-07-01,2026-07-01,1111,OLD THING,Merchandise,5.00,"].join("\n");
  const CSV2 = ["Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit", // an overlapping later export
    "2026-10-07,2026-10-07,1111,UBER *TRIP,Other Travel,14.20,",
    "2026-10-08,2026-10-08,1111,UBER *EATS,Dining,18.00,"].join("\n");
  test("fingerprint skips a duplicate file; overlapping exports dedupe by row; ingest_log and provenance are written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stmts-"));
    mkdirSync(join(dir, "CapitalOne"));
    writeFileSync(join(dir, "CapitalOne", "a.csv"), CSV1);
    writeFileSync(join(dir, "CapitalOne", "a copy.csv"), CSV1 + "\n"); // different bytes, same statement
    writeFileSync(join(dir, "CapitalOne", "b.csv"), CSV2);
    const db = openDb(":memory:");
    const st = await ingestStatements(db, dir, { useFm: false, categoriesCache: join(dir, "cats.json"), from: PT("2026-08-01T00:00:00"), to: PT("2026-10-22T12:00:00") });
    expect(st).toMatchObject({ files: 3, duplicateFiles: 1, parsed: 2, failed: 0, accounts: 1, rows: 5, rowDuplicates: 1, beforeWindow: 1 });
    expect(db.query("SELECT shared, owner FROM accounts").all()).toEqual([{ shared: 0, owner: "me" }]);
    expect((db.query("SELECT COUNT(*) AS n FROM transactions WHERE merchant = 'Sample Store'").get() as { n: number }).n).toBe(2);
    expect(db.query("SELECT category FROM transactions WHERE merchant = 'Uber'").all()).toEqual([{ category: "TRANSPORTATION" }]);
    expect((db.query("SELECT COUNT(*) AS n FROM ingest_log").get() as { n: number }).n).toBe(2);
    const raw = JSON.parse((db.query("SELECT raw_json FROM transactions LIMIT 1").get() as { raw_json: string }).raw_json);
    expect(Object.keys(raw)).toEqual(expect.arrayContaining(["file_sha", "source", "page", "line"]));
    // Idempotent: the same files again add nothing.
    const again = await ingestStatements(db, dir, { useFm: false, categoriesCache: join(dir, "cats.json"), from: PT("2026-08-01T00:00:00"), to: PT("2026-10-22T12:00:00") });
    expect([again.parsed, again.duplicateFiles]).toEqual([0, 3]);
  });
});
