import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { fromLocal, localParts } from "../src/imessage/clock";
import type { Fm } from "../src/imessage/fm";
import { MemoryTransport } from "../src/imessage/transport";
import { acceptRephrase, runScheduler } from "../src/nudges/scheduler";
import { startDemoServer } from "../src/nudges/server";
import { commuteRides, dinnerDelivery, MIN_GAP_CENTS, newRecurring } from "../src/nudges/triggers";
import { makeAgent, serial } from "../src/main";

const DAY = 86_400;
const paths: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
let seq = 0;
function freshDb(): Database {
  const p = join(tmpdir(), `fin-nudge-${process.pid}-${Date.now()}-${seq++}.db`);
  paths.push(p);
  const db = openDb(p);
  db.run("INSERT INTO accounts(id, name, issuer, type, shared) VALUES ('amex','Amex','amex','credit',1)");
  return db;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const p of paths.splice(0)) for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
});

let n = 0;
type Owner = "me" | "her" | "shared" | null;
function txn(db: Database, o: { ts: number; cents: number; merchant?: string; owner?: Owner; receiptId?: string; category?: string }): string {
  const id = `t${String(n++).padStart(5, "0")}`;
  db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'amex', ?, ?, ?, ?)",
    [id, o.ts, o.cents, o.merchant ?? null, o.category ?? null]);
  const owner = o.owner === undefined ? "me" : o.owner;
  if (owner) db.run("INSERT INTO attributions(txn_id, owner, rule, confidence, receipt_id) VALUES (?, ?, 1, 1, ?)", [id, owner, o.receiptId ?? null]);
  return id;
}
function ride(db: Database, ts: number, cents: number, pickup: string, dropoff: string, owner: Owner = "me"): string {
  const rid = `r${n++}`;
  db.run("INSERT INTO receipts(id, source, ts, amount_cents, pickup_label, dropoff_label) VALUES (?, 'uber', ?, ?, ?, ?)", [rid, ts, cents, pickup, dropoff]);
  return txn(db, { ts, cents, merchant: "Uber", owner, receiptId: rid });
}
function delivery(db: Database, ts: number, owner: Owner = "me", withReceipt = true): string {
  if (!withReceipt) return txn(db, { ts, cents: 3500, merchant: "Uber Eats", owner });
  const rid = `r${n++}`;
  db.run("INSERT INTO receipts(id, source, ts, amount_cents) VALUES (?, 'uber_eats', ?, 3500)", [rid, ts]);
  return txn(db, { ts, cents: 3500, merchant: "UBER *EATS PENDING", owner, receiptId: rid });
}
/** Goal created 30 days before `at`, deadline 60 days after, $9000 target from $0: expected $3000 at `at`. */
function goal(db: Database, at: number, savingsCents: number) {
  db.run("INSERT INTO accounts(id, name, type, subtype, owner, balance_cents) VALUES ('sav','Savings','depository','savings','me',?)", [savingsCents]);
  db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents) VALUES (900000, ?, ?, 0)", [at + 60 * DAY, at - 30 * DAY]);
}
function sender(fail = false) {
  const sent: string[] = [];
  return { sent, send: async (t: string) => { if (fail) throw new Error("send failed"); sent.push(t); } };
}
const nudgeRows = (db: Database) => db.query("SELECT * FROM nudges ORDER BY id").all() as any[];

describe("commute_rides", () => {
  const NOW = fromLocal(2026, 10, 22, 8, 30) // commute nudges are morning-only;
  test("fires over $300 this month, both directions", () => {
    const db = freshDb();
    const ids = [ride(db, fromLocal(2026, 10, 5, 8, 30), 8000, "HOME", "WORK"), ride(db, fromLocal(2026, 10, 5, 18, 0), 8000, "WORK", "HOME"),
      ride(db, fromLocal(2026, 10, 12, 8, 30), 8000, "HOME", "WORK"), ride(db, fromLocal(2026, 10, 12, 18, 0), 8000, "WORK", "HOME")];
    const c = commuteRides(db, NOW)!;
    expect(c.text).toStartWith("$320 on office-commute Ubers this month (");
    expect(c.periodKey).toBe("2026-10");
    expect(c.txnIds.sort()).toEqual(ids.sort());
  });
  test("on-pace variant at day 10", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 3, 8, 30), 6000, "HOME", "WORK");
    ride(db, fromLocal(2026, 10, 3, 18, 0), 6000, "WORK", "HOME");
    const c = commuteRides(db, fromLocal(2026, 10, 10, 8, 30))!;
    expect(c.text).toStartWith("On pace for $372 on office-commute Ubers this month (");
  });
  test("pace before day 5 does not fire", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 2, 8, 30), 12000, "HOME", "WORK");
    expect(commuteRides(db, fromLocal(2026, 10, 4, 8, 30))).toBeNull();
  });
  test("OTHER endpoints don't count", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 5, 8, 0), 50000, "HOME", "OTHER");
    ride(db, fromLocal(2026, 10, 6, 8, 0), 50000, "OTHER", "WORK");
    ride(db, fromLocal(2026, 10, 7, 8, 0), 50000, "HOME", "HOME");
    ride(db, fromLocal(2026, 10, 8, 8, 0), 10000, "HOME", "WORK");
    expect(commuteRides(db, NOW)).toBeNull();
  });
  test("last month's rides don't count", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 9, 30, 18, 0), 50000, "WORK", "HOME");
    ride(db, fromLocal(2026, 10, 1, 0, 30), 10000, "WORK", "HOME");
    expect(commuteRides(db, NOW)).toBeNull();
  });
  test("her rides never count", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 5, 8, 0), 100000, "HOME", "WORK", "her");
    expect(commuteRides(db, NOW)).toBeNull();
  });
  test("shared counted at 50%", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 5, 8, 0), 70000, "HOME", "WORK", "shared");
    expect(commuteRides(db, NOW)!.text).toStartWith("$350 on office-commute Ubers this month (");
    const db2 = freshDb();
    ride(db2, fromLocal(2026, 10, 5, 8, 0), 50000, "HOME", "WORK", "shared"); // $250 mine, pace 250/22*31 = 352
    expect(commuteRides(db2, NOW)!.text).toStartWith("On pace for $352");
  });
});

describe("dinner_delivery", () => {
  const AT = fromLocal(2026, 10, 22, 17, 30);
  function seeded(savings = 100000) {
    const db = freshDb();
    goal(db, AT, savings);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 21, 0), "me", false);
    return db;
  }
  test("fires at 17:30 when behind pace with 2 delivery days", () => {
    const db = seeded();
    const c = dinnerDelivery(db, AT)!;
    expect(c.text).toBe("Skip Uber Eats tonight? Goal is $2,000 behind pace.\nA delivery dinner runs you about $35. Cook or grab pickup and it goes toward the goal.");
    expect(c.periodKey).toBe("2026-10-22");
    expect(c.txnIds).toHaveLength(2);
  });
  test("MIN_GAP_CENTS boundary: $24.99 behind doesn't fire, $25.00 does", () => {
    expect(MIN_GAP_CENTS).toBe(2500);
    const near = seeded(300000 - 2499); // expected $3000 at AT
    expect(dinnerDelivery(near, AT)).toBeNull();
    const at = seeded(300000 - 2500);
    expect(dinnerDelivery(at, AT)!.text.split("\n")[0]).toBe("Skip Uber Eats tonight? Goal is $25 behind pace.");
  });
  test("not at 17:29 or 19:00", () => {
    const db = seeded();
    expect(dinnerDelivery(db, fromLocal(2026, 10, 22, 17, 29))).toBeNull();
    expect(dinnerDelivery(db, fromLocal(2026, 10, 22, 19, 0))).toBeNull();
    expect(dinnerDelivery(db, fromLocal(2026, 10, 22, 18, 59))).not.toBeNull();
  });
  test("one delivery day is not enough", () => {
    const db = freshDb();
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 20, 20, 30));
    delivery(db, fromLocal(2026, 10, 19, 16, 59)); // before 17:00
    delivery(db, fromLocal(2026, 10, 14, 19, 0)); // 8 days ago
    expect(dinnerDelivery(db, AT)).toBeNull();
  });
  test("no goal → nothing", () => {
    const db = freshDb();
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 18, 30));
    expect(dinnerDelivery(db, AT)).toBeNull();
  });
  test("goal ahead of pace → nothing", () => {
    expect(dinnerDelivery(seeded(500000), AT)).toBeNull();
  });
  test("her deliveries don't count", () => {
    const db = freshDb();
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 18, 30), "her");
    delivery(db, fromLocal(2026, 10, 17, 18, 30), "her");
    expect(dinnerDelivery(db, AT)).toBeNull();
  });
  test("delivery today doesn't count", () => {
    const db = freshDb();
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 22, 17, 5));
    expect(dinnerDelivery(db, AT)).toBeNull();
  });
});

describe("new_recurring", () => {
  const NOW = fromLocal(2026, 10, 22, 12, 0);
  test("same amount last month and this month, never before → fires", () => {
    const db = freshDb();
    const a = txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    const b = txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    const cs = newRecurring(db, NOW);
    expect(cs).toHaveLength(1);
    expect(cs[0].text).toBe("New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?");
    expect(cs[0].txnIds.sort()).toEqual([a, b]);
  });
  test("different amounts → no", () => {
    const db = freshDb();
    txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: 1799, merchant: "Netflix" });
    expect(newRecurring(db, NOW)).toEqual([]);
  });
  test("existed before last month → no", () => {
    const db = freshDb();
    txn(db, { ts: fromLocal(2026, 8, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: 1549, merchant: "Netflix" });
    expect(newRecurring(db, NOW)).toEqual([]);
  });
  test("her charges → no", () => {
    const db = freshDb();
    txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: 1549, merchant: "Netflix", owner: "her" });
    txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: 1549, merchant: "Netflix", owner: "her" });
    expect(newRecurring(db, NOW)).toEqual([]);
  });
  test("January looks back to December", () => {
    const db = freshDb();
    txn(db, { ts: fromLocal(2026, 12, 3, 9, 0), cents: 999, merchant: "Spotify" });
    txn(db, { ts: fromLocal(2027, 1, 3, 9, 0), cents: 999, merchant: "Spotify" });
    expect(newRecurring(db, fromLocal(2027, 1, 10, 12, 0))[0].text).toBe("New recurring charge: Spotify $9.99/mo.\nThat's about $120 a year. Keep it?");
  });
});

/** Three new_recurring merchants ready at once. */
function threeRecurring(db: Database) {
  for (const [m, c] of [["Netflix", 1549], ["Hulu", 799], ["Spotify", 999]] as const) {
    txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: c, merchant: m });
    txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: c, merchant: m });
  }
}
function oneRecurring(db: Database) {
  txn(db, { ts: fromLocal(2026, 9, 15, 9, 0), cents: 1549, merchant: "Netflix" });
  txn(db, { ts: fromLocal(2026, 10, 15, 9, 0), cents: 1549, merchant: "Netflix" });
}

describe("scheduler guardrails", () => {
  const NOON = fromLocal(2026, 10, 22, 12, 0);
  test("nudges off → nothing; stop/on round trip via commands", async () => {
    const db = freshDb();
    oneRecurring(db);
    const t = new MemoryTransport();
    const agent = makeAgent(db, t, {});
    await agent.onText("stop nudges");
    const s = sender();
    expect(await runScheduler(db, NOON, s)).toEqual({ fired: [], skipped: ["nudges off"] });
    expect(s.sent).toEqual([]);
    await agent.onText("nudges on");
    const r = await runScheduler(db, NOON, s);
    expect(r.fired.map((f) => f.kind)).toEqual(["new_recurring"]);
    expect(s.sent).toHaveLength(1);
  });
  const commuteReady = (db: Database) => ride(db, fromLocal(2026, 10, 5, 8, 0), 40000, "HOME", "WORK");
  test("quiet hours: 22:00 and 07:59 nothing, 08:00 ok", async () => {
    const db = freshDb();
    commuteReady(db);
    const s = sender();
    expect((await runScheduler(db, fromLocal(2026, 10, 22, 22, 0), s)).skipped).toEqual(["quiet hours"]);
    expect((await runScheduler(db, fromLocal(2026, 10, 23, 7, 59), s)).skipped).toEqual(["quiet hours"]);
    expect(s.sent).toEqual([]);
    expect((await runScheduler(db, fromLocal(2026, 10, 23, 8, 0), s)).fired).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });
  test("one nudge per tick, max 2 per local day; next day allowed", async () => {
    const db = freshDb();
    threeRecurring(db);
    const s = sender();
    const r = await runScheduler(db, NOON, s);
    expect(r.fired).toHaveLength(1);
    expect(r.skipped.filter((x) => x.endsWith("waits for a later tick"))).toHaveLength(2);
    expect((await runScheduler(db, NOON + 900, s)).fired).toHaveLength(1);
    const r3 = await runScheduler(db, NOON + 1800, s);
    expect(r3.fired).toHaveLength(0);
    expect(r3.skipped).toContain("new_recurring: daily limit");
    expect(s.sent).toHaveLength(2);
    const r4 = await runScheduler(db, fromLocal(2026, 10, 23, 12, 0), s);
    expect(r4.fired).toHaveLength(1);
    expect(new Set(s.sent).size).toBe(3);
  });
  test("daily limit uses the local day across midnight", async () => {
    // Two nudges late on Oct 22 local (Oct 23 UTC). Oct 23 08:00 local is a new local day but the same UTC day.
    const db = freshDb();
    commuteReady(db);
    for (const k of ["a", "b"]) db.run("INSERT INTO nudges(kind, period_key, ts, text) VALUES ('x', ?, ?, 'x')", [k, fromLocal(2026, 10, 22, 23, 59)]);
    const s = sender();
    expect((await runScheduler(db, fromLocal(2026, 10, 23, 8, 0), s)).fired).toHaveLength(1);
    // Two early on Oct 22 local; 13:00 the same local day is blocked.
    const db2 = freshDb();
    oneRecurring(db2);
    for (const k of ["a", "b"]) db2.run("INSERT INTO nudges(kind, period_key, ts, text) VALUES ('x', ?, ?, 'x')", [k, fromLocal(2026, 10, 22, 0, 30)]);
    const r = await runScheduler(db2, fromLocal(2026, 10, 22, 13, 0), s);
    expect(r.fired).toHaveLength(0);
    expect(r.skipped).toEqual(["new_recurring: daily limit"]);
    expect((await runScheduler(db2, fromLocal(2026, 10, 23, 0, 0), s)).skipped).toEqual(["quiet hours"]);
    expect((await runScheduler(db2, fromLocal(2026, 10, 23, 12, 0), s)).fired).toHaveLength(1);
  });
  test("new_recurring window is 12:00–14:00", async () => {
    const db = freshDb();
    oneRecurring(db);
    const s = sender();
    for (const [h, m] of [[11, 59], [14, 0], [8, 30], [17, 30]]) expect((await runScheduler(db, fromLocal(2026, 10, 22, h, m), s)).fired).toEqual([]);
    expect((await runScheduler(db, fromLocal(2026, 10, 22, 13, 59), s)).fired).toHaveLength(1);
  });
  test("once per period: second tick same day doesn't resend", async () => {
    const db = freshDb();
    oneRecurring(db);
    const s = sender();
    await runScheduler(db, NOON, s);
    const r = await runScheduler(db, NOON + 3600, s);
    expect(r.fired).toEqual([]);
    expect(r.skipped).toEqual(["new_recurring: already sent for Netflix"]);
    expect(s.sent).toHaveLength(1);
  });
  test("commute once per month (mornings), dinner once per day (evenings)", async () => {
    const db = freshDb();
    const AT = fromLocal(2026, 10, 22, 17, 30);
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 18, 30));
    ride(db, fromLocal(2026, 10, 5, 8, 0), 40000, "HOME", "WORK");
    const s = sender();
    // Two separate demo beats: 17:30 → dinner only; next morning 08:30 → commute only.
    expect((await runScheduler(db, AT, s)).fired.map((f) => f.kind)).toEqual(["dinner_delivery"]);
    expect((await runScheduler(db, fromLocal(2026, 10, 23, 8, 30), s)).fired.map((f) => f.kind)).toEqual(["commute_rides"]);
    const r = await runScheduler(db, fromLocal(2026, 10, 23, 17, 30), s);
    expect(r.fired.map((f) => f.kind)).toEqual(["dinner_delivery"]);
    const r2 = await runScheduler(db, fromLocal(2026, 10, 24, 8, 30), s);
    expect(r2.skipped).toEqual(["commute_rides: already sent for 2026-10"]);
  });
  test("commute window is 07:30–10:00 local", () => {
    const db = freshDb();
    ride(db, fromLocal(2026, 10, 5, 8, 0), 40000, "HOME", "WORK");
    expect(commuteRides(db, fromLocal(2026, 10, 22, 7, 29))).toBeNull();
    expect(commuteRides(db, fromLocal(2026, 10, 22, 7, 30))).not.toBeNull();
    expect(commuteRides(db, fromLocal(2026, 10, 22, 9, 59))).not.toBeNull();
    expect(commuteRides(db, fromLocal(2026, 10, 22, 10, 0))).toBeNull();
    expect(commuteRides(db, fromLocal(2026, 10, 22, 17, 30))).toBeNull();
  });
  test("send failure deletes the row so a later tick retries", async () => {
    const db = freshDb();
    oneRecurring(db);
    const r = await runScheduler(db, NOON, sender(true));
    expect(r.fired).toEqual([]);
    expect(r.skipped).toEqual(["new_recurring: send failed"]);
    expect(nudgeRows(db)).toEqual([]);
    const s = sender();
    expect((await runScheduler(db, NOON + 900, s)).fired).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });
  test("every sent nudge has a nudges row with txn_ids JSON", async () => {
    const db = freshDb();
    threeRecurring(db);
    const s = sender();
    await runScheduler(db, NOON, s);
    const rows = nudgeRows(db);
    expect(rows.map((r) => r.text)).toEqual(s.sent);
    for (const r of rows) {
      const ids = JSON.parse(r.txn_ids);
      expect(Array.isArray(ids)).toBe(true);
      expect(ids).toHaveLength(2);
      expect(r.ts).toBe(NOON);
    }
  });
  test("no trigger → skipped 'no trigger'", async () => {
    expect(await runScheduler(freshDb(), NOON, sender())).toEqual({ fired: [], skipped: ["no trigger"] });
  });
});

describe("rephrase", () => {
  const T = "$450 on office-commute Ubers this month. Train a few days?";
  test("acceptRephrase", () => {
    expect(acceptRephrase(T, "Spent four hundred fifty dollars on commute Ubers…")).toBe(T);
    expect(acceptRephrase(T, "  You've spent $450 on commute Ubers. Maybe train?  ")).toBe("You've spent $450 on commute Ubers. Maybe train?");
    expect(acceptRephrase(T, "$450 on Ubers in 2 weeks. Train?")).toBe(T);
    expect(acceptRephrase(T, "$4500 on Ubers. Train?")).toBe(T);
    expect(acceptRephrase(T, null)).toBe(T);
    expect(acceptRephrase(T, "")).toBe(T);
    expect(acceptRephrase(T, "   ")).toBe(T);
  });
  test("rejects preambles, newlines, 'here', and output over 1.3x the template", () => {
    const T449 = "$449 on office-commute Ubers this month. Train a few days?";
    expect(acceptRephrase(T449, "Sure! Here's the text message you requested:\n\n$449 on office-commute Ubers this month. Train a few days?")).toBe(T449);
    expect(acceptRephrase(T, "$450 on commute Ubers.\nTrain?")).toBe(T);
    expect(acceptRephrase(T, "$450 on commute Ubers.\r\nTrain?")).toBe(T);
    expect(acceptRephrase(T, "HERE: $450 on commute Ubers. Train?")).toBe(T);
    expect(acceptRephrase(T, "Here's one: $450 on commute Ubers. Train?")).toBe(T);
    expect(acceptRephrase(T, "$450 on commute Ubers. Train? There you go")).toBe("$450 on commute Ubers. Train? There you go"); // "there" is not "here"
    const max = Math.floor(T.length * 1.3);
    const fit = ("$450 on commute Ubers this month, train a few days? " + "a".repeat(200)).slice(0, max);
    expect(acceptRephrase(T, fit)).toBe(fit);
    expect(acceptRephrase(T, fit + "a")).toBe(T);
  });
  test("runScheduler sends the template even when fm.respond returns a valid rephrase", async () => {
    const db = freshDb();
    oneRecurring(db);
    const s = sender();
    const prompts: string[] = [];
    const fm: Fm = { extract: async () => null, respond: async (p) => { prompts.push(p); return "Netflix is now $15.49/mo. Keep it?"; } };
    expect(acceptRephrase("New recurring charge: Netflix $15.49/mo. Keep it?", "Netflix is now $15.49/mo. Keep it?")).toBe("Netflix is now $15.49/mo. Keep it?");
    const r = await runScheduler(db, fromLocal(2026, 10, 22, 12, 0), { send: s.send, fm });
    expect(s.sent).toEqual(["New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?"]);
    expect(r.fired[0].text).toBe("New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?");
    expect(nudgeRows(db)[0].text).toBe("New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?");
    expect(prompts).toEqual([]);
  });
});

describe("demo tick server", () => {
  test("routes, 400, 404, loopback", async () => {
    const calls: string[] = [];
    const server = startDemoServer(async (at) => { calls.push(at); return /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? { at, fired: [], skipped: [] } : null; }, 0);
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;
    const ok = await fetch(`${base}/demo/tick?at=17:30`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ at: "17:30", fired: [], skipped: [] });
    const bad = await fetch(`${base}/demo/tick?at=25:99`);
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/demo/tick`)).status).toBe(400);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/demo/tick?at=17:30`, { method: "POST" })).status).toBe(404);
    expect(calls).toEqual(["17:30", "25:99", ""]);
  });

  test("end to end with makeAgent.tick (real today)", async () => {
    const db = freshDb();
    // new_recurring relative to the real current month: day 1 of last month and day 1 of this month, 00:30 local.
    const p = localParts(Math.floor(Date.now() / 1000));
    const prev = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 };
    txn(db, { ts: fromLocal(prev.y, prev.m, 1, 0, 30), cents: 1549, merchant: "Netflix" });
    txn(db, { ts: fromLocal(p.y, p.m, 1, 0, 30), cents: 1549, merchant: "Netflix" });
    const transport = new MemoryTransport();
    const agent = makeAgent(db, transport, {});
    const server = startDemoServer(agent.tick, 0);
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/demo/tick?at=12:00`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({ at: "12:00", fired: [{ kind: "new_recurring", text: "New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?" }], skipped: [] });
    expect(transport.sent).toEqual(["New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?"]);
    const again = await (await fetch(`${base}/demo/tick?at=12:05`)).json() as any;
    expect(again.fired).toEqual([]);
    expect((await fetch(`${base}/demo/tick?at=noon`)).status).toBe(400);
    expect(transport.sent).toHaveLength(1);
  });
});

describe("makeAgent.tick with a fixed clock", () => {
  test("dinner nudge at 17:30 via the demo server, then once per day", async () => {
    const db = freshDb();
    const AT = fromLocal(2026, 10, 22, 17, 30);
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 18, 30));
    const transport = new MemoryTransport();
    const agent = makeAgent(db, transport, { now: () => fromLocal(2026, 10, 22, 9, 0) });
    const server = startDemoServer(agent.tick, 0);
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    expect(((await (await fetch(`${base}/demo/tick?at=17:29`)).json()) as any).fired).toEqual([]);
    const body = await (await fetch(`${base}/demo/tick?at=17:30`)).json() as any;
    expect(body.fired).toEqual([{ kind: "dinner_delivery", text: "Skip Uber Eats tonight? Goal is $2,000 behind pace.\nA delivery dinner runs you about $35. Cook or grab pickup and it goes toward the goal." }]);
    expect(transport.sent).toEqual(["Skip Uber Eats tonight? Goal is $2,000 behind pace.\nA delivery dinner runs you about $35. Cook or grab pickup and it goes toward the goal."]);
    const again = await (await fetch(`${base}/demo/tick?at=18:00`)).json() as any;
    expect(again.skipped).toEqual(["dinner_delivery: already sent for 2026-10-22"]);
    expect(transport.sent).toHaveLength(1);
  });
});

describe("makeAgent", () => {
  test("onText routes and replies through the transport", async () => {
    const db = freshDb();
    const transport = new MemoryTransport();
    const agent = makeAgent(db, transport, {});
    await transport.start(agent.onText);
    await transport.receive("stop nudges");
    expect(transport.sent).toEqual(['Nudges stopped. Text "nudges on" to restart.']);
    expect((db.query("SELECT value FROM settings WHERE key = 'nudges'").get() as any).value).toBe("off");
    expect((db.query("SELECT COUNT(*) AS n FROM ledger").get() as any).n).toBe(1);
  });
  test("serial() runs tasks FIFO even when the first is slower", async () => {
    const lane = serial();
    const order: string[] = [];
    const a = lane(async () => { await Bun.sleep(30); order.push("a"); return 1; });
    const b = lane(async () => { order.push("b"); return 2; });
    const c = lane(async () => { throw new Error("boom"); });
    const d = lane(async () => { order.push("d"); return 4; });
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    await expect(c).rejects.toThrow("boom");
    expect(await d).toBe(4);
    expect(order).toEqual(["a", "b", "d"]);
  });
});

describe("richer nudges: every number computed locally, max 3 lines", () => {
  test("commute: rides count and cost, plus train savings at the stated fare", () => {
    const db = freshDb();
    for (let d = 1; d <= 10; d++) ride(db, fromLocal(2026, 10, d, 8, 0), 4000, d % 2 ? "HOME" : "WORK", d % 2 ? "WORK" : "HOME");
    const c = commuteRides(db, fromLocal(2026, 10, 22, 8, 30))!;
    // $400 over 10 rides = $40 avg; 3 days × 2 rides × ($40 − $2.50) = $225.
    expect(c.text).toBe("$400 on office-commute Ubers this month (10 rides).\nTrain 3 days instead and you'd keep about $225 (at $2.50 a ride).");
    expect(c.facts).toMatchObject({ COST: "$400", RIDES: "10 rides", DAYS: "3", SAVE: "$225", FARE: "$2.50" });
    expect(c.situation).not.toMatch(/\d/);
  });
  test("dinner: typical delivery cost (my share) against the goal gap", () => {
    const db = freshDb();
    const AT = fromLocal(2026, 10, 22, 17, 30);
    goal(db, AT, 100000);
    delivery(db, fromLocal(2026, 10, 20, 18, 30));
    delivery(db, fromLocal(2026, 10, 18, 18, 30), "shared"); // counts half: $17.50
    const c = dinnerDelivery(db, AT)!;
    expect(c.text.split("\n")[1]).toBe("A delivery dinner runs you about $26. Cook or grab pickup and it goes toward the goal.");
    expect(c.situation).not.toMatch(/\d/);
  });
  test("recurring: monthly stays exact, yearly reads like afford; every nudge ≤ 3 lines", () => {
    const db = freshDb();
    oneRecurring(db);
    const [c] = newRecurring(db, fromLocal(2026, 10, 22, 12, 0));
    expect(c.text).toBe("New recurring charge: Netflix $15.49/mo.\nThat's about $186 a year. Keep it?");
    for (const t of [c.text]) expect(t.split("\n").length).toBeLessThanOrEqual(3);
  });
  test("the scheduler sends the phrased text; under VOICE=plain that's the fallback, and no who-paid question rides along", async () => {
    const db = freshDb();
    oneRecurring(db);
    const s = sender();
    const r = await runScheduler(db, fromLocal(2026, 10, 22, 12, 0), { send: s.send });
    expect(s.sent).toEqual([r.fired[0].text]);
    expect(s.sent[0]).toContain("$186 a year");
  });
});
