// Statement parsers on SYNTHETIC snippets that copy each layout (pdftotext -layout). Every name, number and amount here
// is invented; real statements never enter git.
import { describe, expect, test } from "bun:test";
import { categoryHint, cents, parseCapOne360Pdf, parseCapOneCsv, parseCitiPdf, statementFingerprint } from "../src/ingest/statements";
import { fromLocal } from "../src/imessage/clock";

const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const noon = (y: number, m: number, d: number) => fromLocal(y, m, d, 12, 0);

describe("Capital One card CSV", () => {
  const CSV = [
    "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
    "2026-10-06,2026-10-06,1111,SAMPLE STORE*12345,Merchandise,22.80,",
    '2026-10-05,2026-10-06,1111,"EXAMPLE CAFE, SAN FRANCISCO",Dining,9.50,',
    "2026-10-01,2026-10-01,1111,CAPITAL ONE AUTOPAY PYMT,Payment/Credit,,150.00",
    "",
    "2026-09-20,2026-09-21,2222,TEST STREAMING CO,Entertainment,15.99,",
    "",
  ].join("\r\n");
  test("rows, accounts per card, signs, quoted commas, CRLF and blank lines", () => {
    const st = parseCapOneCsv("﻿" + CSV);
    expect(st.source).toBe("capone_csv");
    expect(st.accounts).toEqual([
      { key: "capone-card-1111", institution: "Capital One", type: "credit", subtype: "credit card", mask: "1111" },
      { key: "capone-card-2222", institution: "Capital One", type: "credit", subtype: "credit card", mask: "2222" },
    ]);
    expect(st.rows.map((r) => [r.account_key, day(r.ts), r.amount_cents, r.description, r.bank_category, r.category_hint])).toEqual([
      ["capone-card-1111", "2026-10-06", 2280, "SAMPLE STORE*12345", "Merchandise", null],
      ["capone-card-1111", "2026-10-05", 950, "EXAMPLE CAFE, SAN FRANCISCO", "Dining", null],
      ["capone-card-1111", "2026-10-01", -15000, "CAPITAL ONE AUTOPAY PYMT", "Payment/Credit", "LOAN_PAYMENTS"],
      ["capone-card-2222", "2026-09-20", 1599, "TEST STREAMING CO", "Entertainment", null],
    ]);
    expect(st.rows[1].ts).toBe(noon(2026, 10, 5));
    expect(day(st.rows[1].posted_ts!)).toBe("2026-10-06");
    expect([st.rows[0].line, st.rows[3].line]).toEqual([2, 6]);
    expect([day(st.period_start!), day(st.period_end!)]).toEqual(["2026-09-20", "2026-10-06"]);
    expect(st.balances).toEqual([]);
    expect(st.recon).toEqual([]);
  });
  test("a file that isn't the export is rejected", () => {
    expect(() => parseCapOneCsv("Date,Amount\n2026-01-01,5")).toThrow(/unexpected header/);
  });
});

// Capital One 360 combined statement: checking and savings, a wrapped amount, a page break mid-table.
const P360 = [
  "                                                                  STATEMENT PERIOD",
  "                                                                  Aug 1 - Aug 31, 2026",
  "$1,990.00                                         TOTAL ENDING BALANCE",
  "360 Checking...1111              $1,000.00     $1,240.00",
  "360 Performance Savings...2222      $500.00       $750.00",
  "",
  "360 Checking - 99990001111",
  "DATE      DESCRIPTION                                         CATEGORY        AMOUNT            BALANCE",
  "",
  "Aug 1     Opening Balance                                                                       $1,000.00",
  "Aug 2     Debit Card Purchase - SAMPLE CAFE                   Debit           - $12.50          $987.50",
  "",
  "Aug 3     Digital Card Purchase - TEST MART 123456            Debit                             $887.50",
  "          CA                                                                 - $100.00",
  "",
  "Aug 4     Withdrawal from CITI CARD ONLINE PAYMENT            Debit           - $200.00         $687.50",
  "                                                    Page 1 of 3",
  "\f                                                  JANE SAMPLE      STATEMENT PERIOD",
  "                                                                  Aug 1 - Aug 31, 2026",
  "DATE         DESCRIPTION                                      CATEGORY        AMOUNT            BALANCE",
  "Aug 15       Deposit from EXAMPLE CO PAYROLL                  Credit          + $800.00         $1,487.50",
  "Aug 20       Withdrawal to 360 Performance Savings XXXX2222   Debit           - $250.00         $1,237.50",
  "Aug 31       Monthly Interest Paid                            Credit          + $2.50           $1,240.00",
  "Aug 31       Closing Balance                                                                    $1,240.00",
  "",
  "360 Performance Savings - 99990002222",
  "                                                    Page 2 of 3",
  "\f                                                  JANE SAMPLE      STATEMENT PERIOD",
  "                                                                  Aug 1 - Aug 31, 2026",
  "DATE      DESCRIPTION                                    CATEGORY        AMOUNT            BALANCE",
  "Aug 1     Opening Balance                                                                  $500.00",
  "Aug 20    Deposit from 360 Checking XXXX1111              Credit          + $250.00         $750.00",
  "Aug 31    Closing Balance                                                                  $750.00",
  "                                                    Page 3 of 3",
].join("\n");

describe("Capital One 360 PDF", () => {
  test("two accounts, a wrapped amount, a credit, a payment, a transfer, across pages", () => {
    const st = parseCapOne360Pdf(P360);
    expect(st.accounts.map((a) => [a.key, a.type, a.subtype, a.mask])).toEqual([
      ["capone360-checking-1111", "depository", "checking", "1111"],
      ["capone360-savings-2222", "depository", "savings", "2222"],
    ]);
    expect(st.rows.map((r) => [r.account_key.split("-")[1], day(r.ts), r.amount_cents, r.description, r.category_hint, r.page])).toEqual([
      ["checking", "2026-08-02", 1250, "Debit Card Purchase - SAMPLE CAFE", null, 1],
      ["checking", "2026-08-03", 10000, "Digital Card Purchase - TEST MART 123456 CA", null, 1],
      ["checking", "2026-08-04", 20000, "Withdrawal from CITI CARD ONLINE PAYMENT", "LOAN_PAYMENTS", 1],
      ["checking", "2026-08-15", -80000, "Deposit from EXAMPLE CO PAYROLL", "INCOME", 2],
      ["checking", "2026-08-20", 25000, "Withdrawal to 360 Performance Savings XXXX2222", "TRANSFER_OUT", 2],
      ["checking", "2026-08-31", -250, "Monthly Interest Paid", "INCOME", 2],
      ["savings", "2026-08-20", -25000, "Deposit from 360 Checking XXXX1111", "TRANSFER_IN", 3],
    ]);
    expect(st.balances).toEqual([
      { account_key: "capone360-checking-1111", opening_cents: 100000, closing_cents: 124000, period_start: noon(2026, 8, 1), period_end: noon(2026, 8, 31) },
      { account_key: "capone360-savings-2222", opening_cents: 50000, closing_cents: 75000, period_start: noon(2026, 8, 1), period_end: noon(2026, 8, 31) },
    ]);
    expect(st.recon.map((r) => [r.account_key, r.ok, r.diff_cents])).toEqual([["capone360-checking-1111", true, 0], ["capone360-savings-2222", true, 0]]);
    expect(st.recon[0].note).toContain("1 amount from the running balance");
  });
  test("a closing balance that doesn't add up is reported, not thrown", () => {
    const st = parseCapOne360Pdf(P360.replace("Aug 31       Closing Balance                                                                    $1,240.00",
      "Aug 31       Closing Balance                                                                    $1,250.00"));
    expect(st.recon[0]).toMatchObject({ ok: false, expected_cents: 125000, computed_cents: 124000, diff_cents: -1000 });
  });
  test("a wrapped amount that disagrees with the running balance fails recon", () => {
    const st = parseCapOne360Pdf(P360.replace("- $100.00", "- $90.00"));
    expect(st.recon[0].ok).toBe(false);
    expect(st.recon[0].note).toMatch(/1 row amount\(s\) disagree/);
  });
  test("a period across New Year dates December rows in the earlier year", () => {
    const st = parseCapOne360Pdf(P360.replaceAll("Aug 1 - Aug 31, 2026", "Dec 15 - Jan 14, 2027").replace("Aug 2 ", "Dec 20").replace("Aug 4 ", "Jan 4 "));
    expect(day(st.rows[0].ts)).toBe("2026-12-20");
    expect(day(st.rows[2].ts)).toBe("2027-01-04");
    expect([day(st.period_start!), day(st.period_end!)]).toEqual(["2026-12-15", "2027-01-14"]);
  });
  test("something that isn't a 360 statement is rejected", () => expect(() => parseCapOne360Pdf("hello")).toThrow(/statement period/));
});

// Citi card: summary on page 1, a period across New Year, a wrapped credit, cont'd pages, Flex Plan, fees and interest.
const CITI = [
  "                     www.citicards.com                                   Member Since 2025. Account number ending in:",
  "           Billing Period: 12/12/26-01/11/27",
  "           New balance as of 01/11/27:                                     $160.00",
  "                                                                                       Previous balance                       $100.00",
  "         Late Payment Warning: If we do not receive your Minimum Payment                Payments                              -$100.00",
  "         by the date listed above, you may have to pay a late fee of up to $41          Credits                                -$10.00",
  "                                                                                       Purchases                             +$120.00",
  "                                                                                       Cash advances                           +$0.00",
  "                                                                                       Citi Flex Plans                        +$15.00",
  "                                                                                       Fees                                   +$30.00",
  "                                                                                       Interest                                +$5.00",
  "                                                                                       New balance                            $160.00",
  "\f                     www.citicards.com                                   Member Since 2025. Account number ending in: 9999",
  "         Account Summary",
  "         Trans.            Post",
  "         date              date         Description                                               Amount",
  "         Payments, Credits and Adjustments",
  "                           01/02        ONLINE PAYMENT, THANK YOU                                  -$100.00",
  "                           12/20        SECURITY CREDIT-ITEM UNDER INVESTIGATION",
  "                                        *See Account Messages for details                           -$10.00",
  "         Standard Purchases",
  "         12/12             12/13        SAMPLE DINER           SAN FRANCISCO CA                      $40.00",
  "                           12/30        EXAMPLE BOOKS          SAN FRANCISCO CA                      $50.00",
  "123400",
  "\f                     www.citicards.com                                   Member Since 2025. Account number ending in: 9999",
  "         JANE SAMPLE",
  "         Standard Purchases, cont'd",
  "                           01/05        TEST GROCER            OAKLAND CA                            $30.00",
  "         Citi Flex Plan - 1",
  "         01/03             01/03        CITI FLEX PAY-EXAMPLE STORE                                   $15.00",
  "         Fees Charged",
  "         Date                           Description                                                Amount",
  "         01/11                          LATE FEE - DEC PAYMENT PAST DUE                            $30.00",
  "         Total fees charged in this billing period                                                 $30.00",
  "         Interest Charged",
  "         01/11                          INTEREST CHARGED TO STANDARD PURCH                          $5.00",
  "         Total interest charged in this billing period                                              $5.00",
  "          2027 totals year-to-date",
  "          Total fees charged in 2027                                                               $30.00",
].join("\n");

describe("Citi PDF", () => {
  test("rows from every section, wrapped credit, cont'd page, Flex Plan, fees and interest; recon both ways", () => {
    const st = parseCitiPdf(CITI);
    expect(st.accounts).toEqual([{ key: "citi-card-9999", institution: "Citi", type: "credit", subtype: "credit card", mask: "9999" }]);
    expect(st.rows.map((r) => [day(r.ts), r.amount_cents, r.description, r.bank_category, r.category_hint, r.page])).toEqual([
      ["2027-01-02", -10000, "ONLINE PAYMENT, THANK YOU", "payments_credits", "LOAN_PAYMENTS", 2],
      ["2026-12-20", -1000, "SECURITY CREDIT-ITEM UNDER INVESTIGATION *See Account Messages for details", "payments_credits", null, 2],
      ["2026-12-12", 4000, "SAMPLE DINER           SAN FRANCISCO CA", "purchases", null, 2],
      ["2026-12-30", 5000, "EXAMPLE BOOKS          SAN FRANCISCO CA", "purchases", null, 2],
      ["2027-01-05", 3000, "TEST GROCER            OAKLAND CA", "purchases", null, 3],
      ["2027-01-03", 1500, "CITI FLEX PAY-EXAMPLE STORE", "flex_plan", null, 3],
      ["2027-01-11", 3000, "LATE FEE - DEC PAYMENT PAST DUE", "fees", "BANK_FEES", 3],
      ["2027-01-11", 500, "INTEREST CHARGED TO STANDARD PURCH", "interest", "BANK_FEES", 3],
    ]);
    expect(day(st.rows[2].posted_ts!)).toBe("2026-12-13"); // two-date row: ts is the transaction date
    expect(st.balances).toEqual([{ account_key: "citi-card-9999", opening_cents: 10000, closing_cents: 16000, period_start: noon(2026, 12, 12), period_end: noon(2027, 1, 11) }]);
    expect(st.recon).toEqual([{ account_key: "citi-card-9999", ok: true, expected_cents: 16000, computed_cents: 16000, diff_cents: 0, note: "previous + rows = new balance; summary adds up" }]);
  });
  test("a missed row shows up as a recon failure with the difference", () => {
    const st = parseCitiPdf(CITI.replace(/^.*TEST GROCER.*$/m, ""));
    expect(st.recon[0]).toMatchObject({ ok: false, diff_cents: -3000 });
    expect(st.recon[0].note).toBe("previous + rows ≠ new balance");
  });
  test("a summary that doesn't add up is reported too", () => {
    expect(parseCitiPdf(CITI.replace("+$120.00", "+$125.00")).recon[0].note).toMatch(/^summary doesn't add up/);
  });
  test("without a billing period the year hint dates the rows; without either it's rejected", () => {
    const noPeriod = CITI.replace(/^.*Billing Period.*$/m, "");
    expect(day(parseCitiPdf(noPeriod, { year: 2027 }).rows[0].ts)).toBe("2027-01-02");
    expect(() => parseCitiPdf(noPeriod)).toThrow(/no billing period/);
  });
});

describe("helpers", () => {
  test("cents", () => {
    expect([cents("$1,285.12"), cents("- $7.99"), cents("-$0.00"), cents("12.3")]).toEqual([128512, -799, -0, 1230]);
  });
  test.each([
    ["CITI CARD ONLINE PAYMENT", 5000, "LOAN_PAYMENTS"], ["CAPITAL ONE MOBILE PMT", 5000, "LOAN_PAYMENTS"], ["EXAMPLE BANK CRCARDPMT", 5000, "LOAN_PAYMENTS"],
    ["Withdrawal from SAMPLE CCB Payment", 799, "LOAN_PAYMENTS"], ["Zelle from A FRIEND", -2000, "TRANSFER_IN"], ["Zelle to A FRIEND", 2000, null],
    ["EXAMPLE CO PAYROLL", -100000, "INCOME"], ["SAMPLE CAFE", 500, null],
  ])("categoryHint(%s, %d) = %s", (d, a, want) => expect(categoryHint(d as string, a as number)).toBe(want as string | null));
});

describe("statementFingerprint", () => {
  test("same statement content → same fingerprint, even when the surrounding text differs (re-downloads)", () => {
    const a = parseCapOne360Pdf(P360), b = parseCapOne360Pdf(P360.replace("TOTAL ENDING BALANCE", "TOTAL ENDING BALANCE  (downloaded again)"));
    expect(statementFingerprint(a)).toBe(statementFingerprint(b));
  });
  test("a different row or period → a different fingerprint", () => {
    const base = statementFingerprint(parseCapOne360Pdf(P360));
    expect(statementFingerprint(parseCapOne360Pdf(P360.replace("SAMPLE CAFE", "SAMPLE DELI")))).not.toBe(base);
    expect(statementFingerprint(parseCitiPdf(CITI))).not.toBe(statementFingerprint(parseCitiPdf(CITI.replace("12/12/26-01/11/27", "12/11/26-01/11/27"))));
  });
});
