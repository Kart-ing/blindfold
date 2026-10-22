// Zelle counterparties (synthetic names only). A statement line names the person, but the merchant is just "Zelle": the import
// must keep the name where knownPeople() finds it, or a text that names them goes to the cloud in clear.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symbolizeText } from "../src/cloud/symbolize";
import { openDb } from "../src/db";
import { p2pMemo } from "../src/ingest/categorize";
import { knownPeople } from "../src/ingest/receipts";
import { backfillP2pMemos, ingestStatements } from "../src/ingest/seed-real";

describe("Zelle counterparties (synthetic names)", () => {
  test("p2pMemo keeps the counterparty's name, title-cased, and stops at anything that isn't one", () => {
    expect(p2pMemo("Zelle money sent to ZORYA QUILLFEATHER")).toBe("Zelle to Zorya Quillfeather");
    expect(p2pMemo("Zelle money received from BRAMWELL T OSTERGAARD")).toBe("Zelle from Bramwell T Ostergaard");
    expect(p2pMemo("ZELLE PAYMENT TO OSTERGAARD, BRAMWELL ON 08/14 REF 991")).toBe("Zelle to Ostergaard Bramwell");
    expect(p2pMemo("Venmo payment to Zorya Quillfeather")).toBe("Venmo to Zorya Quillfeather");
    expect(p2pMemo("Zelle money sent to")).toBeNull();
    expect(p2pMemo("Zelle transfer to my savings")).toBeNull();
    expect(p2pMemo("Debit Card Purchase - PAYPAL *SAMPLESHOP 4029357733 CA")).toBeNull();
  });

  test("the import keeps the name in the memo, the backfill restores it by the same ids, and a text naming them is symbolized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p2p-"));
    mkdirSync(join(dir, "CapitalOne"));
    writeFileSync(join(dir, "CapitalOne", "a.csv"), ["Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
      "2026-09-01,2026-09-01,1111,Zelle money sent to ZORYA QUILLFEATHER,Other Services,1800.00,",
      "2026-09-03,2026-09-03,1111,Zelle money received from BRAMWELL T OSTERGAARD,Payment/Credit,,40.00",
      "2026-09-04,2026-09-04,1111,SAMPLE STORE*12345,Merchandise,22.80,"].join("\n"));
    const db = openDb(":memory:");
    await ingestStatements(db, dir, { useFm: false, categoriesCache: join(dir, "cats.json"), from: 0, to: Infinity });
    const memos = () => (db.query("SELECT memo FROM transactions WHERE memo IS NOT NULL ORDER BY memo").all() as { memo: string }[]).map((r) => r.memo);
    expect(memos()).toEqual(["Zelle from Bramwell T Ostergaard", "Zelle to Zorya Quillfeather"]);
    db.run("UPDATE transactions SET memo = NULL"); // a DB built before this fix
    expect(await backfillP2pMemos(db, dir)).toEqual({ named: 2, set: 2, missing: 0 });
    expect(memos()).toEqual(["Zelle from Bramwell T Ostergaard", "Zelle to Zorya Quillfeather"]);
    expect(knownPeople(db)).toEqual(["Bramwell T Ostergaard", "Zorya Quillfeather"]);
    for (const msg of ["I usually send my friend Zorya the rent", "Quillfeather paid me back", "did Bramwell send the money back?"]) {
      const out = symbolizeText(db, msg).text.toLowerCase();
      for (const part of ["zorya", "quillfeather", "bramwell", "ostergaard"]) expect(out).not.toContain(part);
    }
  });
});
