import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { attribute, attributeAll, RULES, setOwner, setPlace } from "../src/attribution/engine";
import { matchReceipts } from "../src/ingest/match";

const PT = (iso: string) => Math.floor(Date.parse(`${iso}-07:00`) / 1000);
const WED_11AM = PT("2026-10-14T11:00:00");
const WED_8PM = PT("2026-10-14T20:00:00");
const SUN_2PM = PT("2026-10-18T14:00:00");

function fresh() {
  const db = openDb(":memory:");
  db.run("INSERT INTO accounts VALUES ('amex','Shared Amex','1009','amex','credit','credit card',1,'shared',0,0)");
  db.run("INSERT INTO accounts VALUES ('chase-cc','Shared Chase','2002','chase','credit','credit card',1,'shared',0,0)");
  db.run("INSERT INTO accounts VALUES ('visa','My Visa','6804','visa','credit','credit card',0,'me',0,0)");
  db.run("INSERT INTO places VALUES ('HOME','1550 Mission Street, San Francisco, CA 94103',37.7744,-122.4192)");
  db.run("INSERT INTO places VALUES ('WORK','1 Market Street, San Francisco, CA 94105',37.7941,-122.3943)");
  return db;
}
let n = 0;
function txn(db: ReturnType<typeof fresh>, o: { acct?: string; ts: number; cents: number; merchant?: string; wallet?: string }) {
  const id = `t${n++}`;
  db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category, wallet) VALUES (?,?,?,?,?,?,?)",
    [id, o.acct ?? "amex", o.ts, o.cents, o.merchant ?? "Store", "GENERAL_MERCHANDISE", o.wallet ?? null]);
  return id;
}
function receipt(db: ReturnType<typeof fresh>, o: { source: string; ts: number; cents: number; pickup?: string; dropoff?: string; items?: number; subtotal?: number }) {
  const id = `r${n++}`;
  db.run("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?,?)", [id, o.source, id, o.ts, o.cents, o.pickup ?? null, o.dropoff ?? null,
    o.items ?? null, o.subtotal ?? null, `/nonexistent/${id}.eml`]);
  return id;
}
const run = (db: ReturnType<typeof fresh>) => { matchReceipts(db); attributeAll(db); };
const row = (db: ReturnType<typeof fresh>, id: string) =>
  db.query("SELECT owner, rule, needs_prompt, labelled_by_user, receipt_id FROM attributions WHERE txn_id = ?").get(id) as
    { owner: string; rule: number; needs_prompt: number; labelled_by_user: number; receipt_id: string | null };

describe("attribution rules (PRD §4)", () => {
  test("non-shared account -> me, rule 0", () => {
    const db = fresh();
    const id = txn(db, { acct: "visa", ts: WED_8PM, cents: 50000, wallet: "apple_pay" });
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "me", rule: 0, needs_prompt: 0 });
  });

  test("rule 2: Apple Pay on Amex at 11am on a weekday is hers (beats work hours)", () => {
    const db = fresh();
    const id = txn(db, { ts: WED_11AM, cents: 6420, merchant: "Sephora", wallet: "apple_pay" });
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "her", rule: 2, needs_prompt: 0 });
  });

  test("rule 2 needs both apple_pay and Amex", () => {
    const db = fresh();
    const otherIssuer = txn(db, { acct: "chase-cc", ts: WED_11AM, cents: 6420, wallet: "apple_pay" });
    const noWallet = txn(db, { ts: WED_11AM, cents: 6420 });
    run(db);
    expect(row(db, otherIssuer).rule).toBe(6);
    expect(row(db, noWallet).rule).toBe(6);
  });

  test("rule 3: matched ride HOME<->WORK either direction -> me", () => {
    const db = fresh();
    const a = txn(db, { ts: WED_8PM, cents: 2800, merchant: "Uber" });
    receipt(db, { source: "uber", ts: WED_8PM + 300, cents: 2800, pickup: "WORK", dropoff: "HOME" });
    const b = txn(db, { ts: SUN_2PM, cents: 2200, merchant: "Lyft" });
    receipt(db, { source: "lyft", ts: SUN_2PM + 300, cents: 2200, pickup: "HOME", dropoff: "WORK" });
    run(db);
    expect(row(db, a)).toMatchObject({ owner: "me", rule: 3, needs_prompt: 0 });
    expect(row(db, b)).toMatchObject({ owner: "me", rule: 3 });
  });

  test("ride with an OTHER endpoint falls through and prompts", () => {
    const db = fresh();
    const id = txn(db, { ts: WED_8PM, cents: 3820, merchant: "Uber" });
    receipt(db, { source: "uber", ts: WED_8PM + 300, cents: 3820, pickup: "HOME", dropoff: "OTHER" });
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "me", rule: 7, needs_prompt: 1 });
  });

  test("rule 4: single-person food order (1 entree or subtotal <= $30) -> me", () => {
    const db = fresh();
    const a = txn(db, { ts: WED_8PM, cents: 2825, merchant: "Uber Eats" });
    receipt(db, { source: "uber_eats", ts: WED_8PM + 300, cents: 2825, dropoff: "HOME", items: 1, subtotal: 1950 });
    const b = txn(db, { ts: SUN_2PM, cents: 3500, merchant: "DoorDash" });
    receipt(db, { source: "doordash", ts: SUN_2PM + 300, cents: 3500, dropoff: "HOME", items: 2, subtotal: 2900 });
    run(db);
    expect(row(db, a)).toMatchObject({ owner: "me", rule: 4 });
    expect(row(db, b)).toMatchObject({ owner: "me", rule: 4 });
  });

  test("rule 5: multi-person food order -> shared", () => {
    const db = fresh();
    const id = txn(db, { ts: WED_8PM, cents: 6840, merchant: "DoorDash" });
    receipt(db, { source: "doordash", ts: WED_8PM + 300, cents: 6840, dropoff: "HOME", items: 3, subtotal: 5100 });
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "shared", rule: 5, needs_prompt: 0 });
  });

  test("rule 6: weekday 9-18 -> me; prompts only above $75", () => {
    const db = fresh();
    const small = txn(db, { ts: WED_11AM, cents: 1450 });
    const big = txn(db, { ts: WED_11AM, cents: 12999 });
    const edge = txn(db, { ts: WED_11AM, cents: 7500 });
    run(db);
    expect(row(db, small)).toMatchObject({ owner: "me", rule: 6, needs_prompt: 0 });
    expect(row(db, big)).toMatchObject({ rule: 6, needs_prompt: 1 });
    expect(row(db, edge).needs_prompt).toBe(0);
  });

  test("work-hour boundaries: 08:59 and 18:00 are not rule 6", () => {
    const db = fresh();
    const early = txn(db, { ts: PT("2026-10-14T08:59:00"), cents: 1000 });
    const nine = txn(db, { ts: PT("2026-10-14T09:00:00"), cents: 1000 });
    const six = txn(db, { ts: PT("2026-10-14T18:00:00"), cents: 1000 });
    run(db);
    expect([row(db, early).rule, row(db, nine).rule, row(db, six).rule]).toEqual([7, 6, 7]);
  });

  test("rule 7: default (weekend) -> me; prompts above $75", () => {
    const db = fresh();
    const id = txn(db, { ts: SUN_2PM, cents: 15900, merchant: "Nordstrom" });
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "me", rule: 7, needs_prompt: 1 });
  });

  test("rule 1 beats rule 2, and attributeAll never overwrites user labels", () => {
    const db = fresh();
    const id = txn(db, { ts: WED_11AM, cents: 6420, wallet: "apple_pay" });
    run(db);
    expect(row(db, id).owner).toBe("her");
    setOwner(db, id, "shared");
    run(db);
    run(db);
    expect(row(db, id)).toMatchObject({ owner: "shared", rule: 1, labelled_by_user: 1, needs_prompt: 0 });
    expect(attribute(db, id).owner).toBe("shared");
  });

  test("setOwner clears a pending prompt and rejects bad input", () => {
    const db = fresh();
    const id = txn(db, { ts: SUN_2PM, cents: 15900 });
    run(db);
    expect(row(db, id).needs_prompt).toBe(1);
    setOwner(db, id, "her");
    expect(row(db, id)).toMatchObject({ owner: "her", rule: 1, needs_prompt: 0 });
    expect(() => setOwner(db, id, "nobody" as "me")).toThrow();
    expect(() => setOwner(db, "missing", "me")).toThrow();
  });

  test("RULES covers every rule number used", () => {
    for (const r of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(typeof RULES[r]).toBe("string");
  });
});

describe("setPlace", () => {
  test("unknown address -> ok:false, places unchanged", () => {
    const db = fresh();
    expect(setPlace(db, "HOME", "22 Elm Ave").ok).toBe(false);
    expect((db.query("SELECT address FROM places WHERE label='HOME'").get() as { address: string }).address).toContain("1550 Mission");
  });

  test("known address (loose formatting) updates the place", () => {
    const db = fresh();
    expect(setPlace(db, "WORK", "3200 california st san francisco ca 94118")).toEqual({ ok: true });
    expect(db.query("SELECT address, lat FROM places WHERE label='WORK'").get()).toEqual({ address: "3200 California Street, San Francisco, CA 94118", lat: 37.7866 });
  });
});

describe("standing preferences (rule 8)", () => {
  test("a re-ingest keeps \"X is always hers\" charges on her side", () => {
    const db = fresh();
    const a = txn(db, { ts: SUN_2PM, cents: 3820, merchant: "Lyft" });
    const b = txn(db, { ts: WED_8PM, cents: 2210, merchant: "Lyft" });
    const other = txn(db, { ts: SUN_2PM, cents: 1500, merchant: "Store" });
    run(db);
    expect(row(db, a).owner).toBe("me");
    db.run("INSERT INTO memories (text, created_ts, kind, merchant, owner) VALUES ('Lyft is always hers', 1, 'owner_pref', 'Lyft', 'her')");
    run(db); // what seed / seed-real / any ingest does
    expect([row(db, a), row(db, b)].map((r) => [r.owner, r.rule])).toEqual([["her", 8], ["her", 8]]);
    expect(row(db, other)).toMatchObject({ owner: "me", rule: 7 });
    run(db); // idempotent
    expect(row(db, a)).toMatchObject({ owner: "her", rule: 8 });
  });
});
