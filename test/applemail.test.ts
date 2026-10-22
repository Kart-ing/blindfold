import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { DEFAULT_SINCE, findEmlx, senderAddress, headerBlock, headOf, ingestAppleMail, isReceiptHeader, mailCheck, parseEmlx, parseSince, receiptId } from "../src/ingest/applemail.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { receiptAddresses } from "../src/ingest/receipts.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "mail");
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n`;
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) {
    for (const p of [d, join(d, "V10")]) try { chmodSync(p, 0o700); } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

const emlx = (rfc822: string) => {
  const body = Buffer.from(rfc822, "utf8");
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from(PLIST)]);
};

/** A fake ~/Library/Mail with one mailbox; returns root and the Messages dir. */
function mailRoot() {
  const root = mkdtempSync(join(tmpdir(), "fin-mail-"));
  tmp.push(root);
  const msgs = join(root, "V10", "ACCT-UUID", "INBOX.mbox", "STORE-UUID", "Data", "1", "Messages");
  mkdirSync(msgs, { recursive: true });
  return { root, msgs };
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "fin-amdb-"));
  tmp.push(dir);
  const db = openDb(join(dir, "fin.db"));
  return { db, cache: join(dir, "mail-cache") };
}

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const fixtureNames = () => readdirSync(FIXTURES).filter((f) => f.endsWith(".eml")).sort();

describe("emlx framing", () => {
  test("byte count is bytes, not characters, and the plist is ignored", () => {
    const rfc = "From: Uber <noreply@uber.com>\nSubject: café ☕ receipt\n\nTotal €12 — ✓\n";
    expect(parseEmlx(emlx(rfc))).toBe(rfc);
  });
  test("bad framing → null", () => {
    expect(parseEmlx(Buffer.from("From: x\n\nbody"))).toBeNull();
    expect(parseEmlx(Buffer.from("999999\nFrom: x\n\nshort"))).toBeNull();
    expect(parseEmlx(Buffer.from(""))).toBeNull();
  });
  test("folded headers unfold; a repeated From is rejected", () => {
    expect(headerBlock("From: Uber\n <noreply@uber.com>\nDate: x\n\nbody").from).toBe("Uber <noreply@uber.com>");
    const h = headerBlock("From: Uber\n <noreply@uber.com>\nDate: Tue, 04 Aug 2026 00:45:00 GMT\nFrom: other@x.com\n\nbody");
    expect(h.from).toBe("");
    expect(isReceiptHeader(h)).toBe(false);
  });
});

describe("header filter", () => {
  const h = (from: string, date = "Tue, 04 Aug 2026 00:45:00 GMT") => ({ from, date });
  test("receipt senders after Aug 1", () => {
    expect(isReceiptHeader(h("Uber Receipts <noreply@uber.com>"))).toBe(true);
    expect(isReceiptHeader(h("Lyft <no-reply@lyftmail.com>"))).toBe(true);
    expect(isReceiptHeader(h("DoorDash <no-reply@doordash.com>"))).toBe(true);
    expect(isReceiptHeader(h("x@mail.uber.com"))).toBe(true);
  });
  test("lookalikes, other senders, old mail and bad dates are excluded", () => {
    expect(isReceiptHeader(h("Phish <noreply@evil-uber.com>"))).toBe(false);
    expect(isReceiptHeader(h("noreply@uber.com.attacker.io"))).toBe(false);
    expect(isReceiptHeader(h("Amazon <ship@amazon.com>"))).toBe(false);
    expect(isReceiptHeader(h("noreply@uber.com", "Fri, 31 Jul 2026 23:00:00 -0700"))).toBe(false);
    expect(isReceiptHeader(h("noreply@uber.com", "not a date"))).toBe(false);
  });
});

describe("findEmlx", () => {
  test("walks V*/…/Messages only; missing root → []", () => {
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx(fixture(fixtureNames()[0])));
    writeFileSync(join(msgs, "2.partial.emlx"), emlx(fixture(fixtureNames()[1])));
    writeFileSync(join(msgs, "note.txt"), "x");
    mkdirSync(join(root, "MailData", "Messages"), { recursive: true });
    writeFileSync(join(root, "MailData", "Messages", "3.emlx"), "x"); // not under V*
    expect(findEmlx(root).map((p) => p.split("/").pop())).toEqual(["1.emlx", "2.partial.emlx"]);
    expect(findEmlx(join(root, "nope"))).toEqual([]);
  });
});

describe("ingestAppleMail", () => {
  test("every fixture receipt round-trips through .emlx; others are skipped", () => {
    const { root, msgs } = mailRoot();
    const names = fixtureNames();
    names.forEach((n, i) => writeFileSync(join(msgs, `${i + 1}.emlx`), emlx(fixture(n))));
    writeFileSync(join(msgs, "900.emlx"), emlx("From: Amazon <ship@amazon.com>\nDate: Tue, 04 Aug 2026 00:45:00 GMT\n\nYour order"));
    writeFileSync(join(msgs, "901.emlx"), Buffer.from("garbage without framing"));
    const { db, cache } = freshDb();
    db.run("INSERT INTO places(label, address, lat, lng) VALUES ('HOME', '1550 Mission Street, San Francisco, CA 94103', 37.7726, -122.4177), ('WORK', '1 Market Street, San Francisco, CA 94105', 37.7941, -122.3951)");
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    expect(res.error).toBeUndefined();
    expect(res.found).toBe(names.length + 2);
    // Everything after Aug 1 from a receipt sender matches; parse failures are counted, not thrown.
    expect(res.parsed + res.failed).toBe(res.matched);
    expect(res.parsed).toBeGreaterThan(0);
    const rows = db.query("SELECT id, source, pickup_label, dropoff_label, raw_path FROM receipts").all() as any[];
    expect(rows.length).toBe(res.parsed);
    for (const r of rows) {
      expect(r.id).toStartWith("receipt-am-");
      expect(r.raw_path.startsWith(cache)).toBe(true);
      expect(statSync(r.raw_path).mode & 0o077).toBe(0); // owner-only
    }
    // Commute fixtures geofence to HOME/WORK, same as the .eml path.
    expect(rows.some((r) => [r.pickup_label, r.dropoff_label].sort().join() === "HOME,WORK")).toBe(true);
    // The canary can still read addresses back from raw_path.
    expect(receiptAddresses(db).length).toBeGreaterThan(0);
    // Idempotent.
    const again = ingestAppleMail(db, { root, cacheDir: cache });
    expect(again.parsed).toBe(res.parsed);
    expect((db.query("SELECT COUNT(*) AS n FROM receipts").get() as any).n).toBe(res.parsed);
  });

  test("ids follow Message-ID, so copies and moves dedupe", () => {
    const { root, msgs } = mailRoot();
    const commute = fixture(fixtureNames().find((n) => n.startsWith("commute"))!);
    const other = join(root, "V10", "ACCT-2", "Archive.mbox", "S", "Data", "Messages");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(msgs, "1.emlx"), emlx(commute));
    writeFileSync(join(other, "77.emlx"), emlx(commute)); // same message copied to another account
    const { db, cache } = freshDb();
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    expect(res).toMatchObject({ found: 2, matched: 2, duplicates: 1, parsed: 1, failed: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM receipts").get() as any).n).toBe(1);
    // Moved: the original disappears, the copy remains → same id, still one row.
    rmSync(join(msgs, "1.emlx"));
    ingestAppleMail(db, { root, cacheDir: cache });
    expect((db.query("SELECT COUNT(*) AS n FROM receipts").get() as any).n).toBe(1);
    expect(readdirSync(cache).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("without a Message-ID the id falls back to From|Date|Subject|size", () => {
    const a = "From: noreply@uber.com\nDate: Tue, 04 Aug 2026 00:45:00 GMT\nSubject: trip\n\nbody";
    expect(receiptId(a)).toBe(receiptId(a));
    expect(receiptId(a)).not.toBe(receiptId(a.replace("body", "body2"))); // content fingerprint: distinct messages never merge
    expect(receiptId("Message-ID: <X@uber.com>\n\na")).toBe(receiptId("Message-ID: <x@uber.com>\n\nb"));
  });

  test("a matching header with an unparseable body is skipped", () => {
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx("From: Uber <noreply@uber.com>\nDate: Tue, 04 Aug 2026 00:45:00 GMT\n\nNew template we don't know"));
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toEqual({ found: 1, skipped: 0, matched: 1, duplicates: 0, parsed: 0, failed: 1, unreadableDirs: 0 });
    expect(readdirSync(cache)).toEqual([]); // no cache file or .tmp left behind
  });

  test("without Full Disk Access it fails soft and writes nothing", () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const { root } = mailRoot();
    chmodSync(join(root, "V10"), 0o000);
    const { db, cache } = freshDb();
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    expect(res.error).toContain("Full Disk Access");
    expect(res.parsed).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM receipts").get() as any).n).toBe(0);
    expect(mailCheck(root)).toBe("Apple Mail receipts readable: no (Full Disk Access needed)");
  });

  test("mailCheck counts receipts without writing", () => {
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx(fixture(fixtureNames().find((n) => n.startsWith("commute"))!)));
    writeFileSync(join(msgs, "2.emlx"), emlx("From: Amazon <ship@amazon.com>\nDate: Tue, 04 Aug 2026 00:45:00 GMT\n\nx"));
    expect(mailCheck(root)).toBe("Apple Mail receipts readable: yes (1 found)");
  });
});

describe("headers, dates, races", () => {
  test("headers beyond 16 KB are found; no terminator within 256 KB is skipped", () => {
    const { root, msgs } = mailRoot();
    const pad = `X-Pad: ${"a".repeat(20_000)}\n`;
    writeFileSync(join(msgs, "1.emlx"), emlx(`${pad}From: Uber <noreply@uber.com>\nDate: Tue, 04 Aug 2026 00:45:00 GMT\n\nbody`));
    expect(headOf(join(msgs, "1.emlx"))!.from).toBe("Uber <noreply@uber.com>");
    writeFileSync(join(msgs, "2.emlx"), emlx(`From: noreply@uber.com\n${"X-Pad: b\n".repeat(40_000)}`));
    expect(headOf(join(msgs, "2.emlx"))).toBeNull();
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toMatchObject({ found: 2, matched: 1, skipped: 1 });
  });

  test("since is inclusive; missing Date excluded", () => {
    expect(isReceiptHeader({ from: "noreply@uber.com", date: "Sat, 01 Aug 2026 00:00:00 -0700" })).toBe(true);
    expect(isReceiptHeader({ from: "noreply@uber.com", date: "Fri, 31 Jul 2026 23:59:59 -0700" })).toBe(false);
    expect(isReceiptHeader({ from: "noreply@uber.com" })).toBe(false);
  });

  test("MAIL_SINCE parsing", () => {
    expect(parseSince(undefined)).toBe(DEFAULT_SINCE);
    expect(DEFAULT_SINCE).toBe(fromLocal(2026, 8, 1));
    expect(parseSince("2026-09-15")).toBe(fromLocal(2026, 9, 15));
    expect(parseSince("1790000000")).toBe(1790000000);
    expect(parseSince("2026-09-15T12:00:00Z")).toBe(Date.parse("2026-09-15T12:00:00Z") / 1000);
    expect(parseSince("2026-09-15T12:00:00")).toBe(DEFAULT_SINCE); // no offset → ambiguous → default
    expect(parseSince("last tuesday")).toBe(DEFAULT_SINCE);
  });

  test("an unreadable single file is a per-file failure, not fatal", () => {
    if (process.getuid?.() === 0) return;
    const { root, msgs } = mailRoot();
    const names = fixtureNames().filter((n) => n.startsWith("commute")).slice(0, 2);
    writeFileSync(join(msgs, "1.emlx"), emlx(fixture(names[0])));
    writeFileSync(join(msgs, "2.emlx"), emlx(fixture(names[1])));
    chmodSync(join(msgs, "2.emlx"), 0o000);
    const { db, cache } = freshDb();
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    chmodSync(join(msgs, "2.emlx"), 0o600);
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ found: 2, matched: 1, skipped: 1, parsed: 1 });
  });
});

test("acceptance: the Apple Mail path attributes exactly like the fixture .eml path", async () => {
  const { rebuild } = await import("../src/ingest/seed.ts");
  const { matchReceipts } = await import("../src/ingest/match.ts");
  const { attributeAll } = await import("../src/attribution/engine.ts");
  const dir = mkdtempSync(join(tmpdir(), "fin-amacc-"));
  tmp.push(dir);
  const owners = (db: any) => db.query("SELECT txn_id, owner, rule FROM attributions ORDER BY txn_id").all();

  const viaEml = rebuild(join(dir, "eml.db")).db;
  const expected = owners(viaEml);

  const viaEmlx = rebuild(join(dir, "emlx.db")).db;
  viaEmlx.run("DELETE FROM attributions");
  viaEmlx.run("DELETE FROM receipts");
  const { root, msgs } = mailRoot();
  fixtureNames().forEach((n, i) => writeFileSync(join(msgs, `${i + 1}.emlx`), emlx(fixture(n))));
  const res = ingestAppleMail(viaEmlx, { root, cacheDir: join(dir, "cache"), since: 0 });
  expect(res.failed).toBe(0);
  expect(res.parsed).toBe((viaEml.query("SELECT COUNT(*) AS n FROM receipts").get() as any).n);
  matchReceipts(viaEmlx);
  attributeAll(viaEmlx);
  expect(owners(viaEmlx)).toEqual(expected);
  viaEml.close();
  viaEmlx.close();
});

describe("round-2 contract", () => {
  const commuteName = () => fixtureNames().find((n) => n.startsWith("commute"))!;
  const withPlaces = (db: any) => db.run("INSERT INTO places(label, address, lat, lng) VALUES ('HOME', '1550 Mission Street, San Francisco, CA 94103', 37.7726, -122.4177), ('WORK', '1 Market Street, San Francisco, CA 94105', 37.7941, -122.3951)");

  test("same Message-ID with a different body: first by path wins, counted as duplicate", () => {
    const { root, msgs } = mailRoot();
    const c = fixture(commuteName());
    writeFileSync(join(msgs, "1.emlx"), emlx(c));
    writeFileSync(join(msgs, "2.emlx"), emlx(c.replace("Thanks for riding", "Thanks again for riding")));
    const { db, cache } = freshDb();
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    expect(res).toMatchObject({ matched: 2, duplicates: 1, parsed: 1, failed: 0 });
    const row = db.query("SELECT raw_path FROM receipts").get() as any;
    expect(readFileSync(row.raw_path, "utf8")).toBe(c);
  });

  test("no Message-ID and different bodies → two rows", () => {
    const { root, msgs } = mailRoot();
    const c = fixture(commuteName()).replace(/^Message-ID:[^\n]*\n/im, "");
    writeFileSync(join(msgs, "1.emlx"), emlx(c));
    writeFileSync(join(msgs, "2.emlx"), emlx(c.replace("Thanks for riding", "Thanks again for riding")));
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toMatchObject({ duplicates: 0, parsed: 2 });
  });

  test("transaction failure writes no cache files and leaves a pre-existing one byte-identical", () => {
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx(fixture(commuteName())));
    const { db, cache } = freshDb();
    withPlaces(db);
    expect(ingestAppleMail(db, { root, cacheDir: cache }).parsed).toBe(1);
    const [cached] = readdirSync(cache);
    writeFileSync(join(cache, cached), "PREVIOUS", { mode: 0o600 });
    const before = (db.query("SELECT * FROM receipts").all() as any[]);
    expect(() => ingestAppleMail(db, { root, cacheDir: cache }, { beforeCommit: () => { throw new Error("disk full"); } })).toThrow("disk full");
    expect(readFileSync(join(cache, cached), "utf8")).toBe("PREVIOUS");
    expect(readdirSync(cache)).toEqual([cached]);
    expect(db.query("SELECT * FROM receipts").all()).toEqual(before);
  });

  test("a cache write failure deletes that row, so raw_path never dangles", () => {
    const { root, msgs } = mailRoot();
    const names = fixtureNames().filter((n) => n.startsWith("commute")).slice(0, 2);
    names.forEach((n, i) => writeFileSync(join(msgs, `${i + 1}.emlx`), emlx(fixture(n))));
    const { db, cache } = freshDb();
    let calls = 0;
    const res = ingestAppleMail(db, { root, cacheDir: cache }, {
      writeCache: (path, data) => { if (calls++ === 0) throw new Error("EROFS"); writeFileSync(path, data); },
    });
    expect(res).toMatchObject({ matched: 2, parsed: 1, failed: 1 });
    const rows = db.query("SELECT raw_path FROM receipts").all() as any[];
    expect(rows.length).toBe(1);
    for (const r of rows) expect(existsSync(r.raw_path)).toBe(true);
  });

  test("real cache writer leaves no temp files", () => {
    const { root, msgs } = mailRoot();
    fixtureNames().slice(0, 5).forEach((n, i) => writeFileSync(join(msgs, `${i + 1}.emlx`), emlx(fixture(n))));
    const { db, cache } = freshDb();
    ingestAppleMail(db, { root, cacheDir: cache });
    expect(readdirSync(cache).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a locked folder below V<n> is skipped and counted; the root missing is reported", () => {
    if (process.getuid?.() === 0) return;
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx(fixture(commuteName())));
    const locked = join(root, "V10", "LOCKED-ACCT");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const { db, cache } = freshDb();
    const res = ingestAppleMail(db, { root, cacheDir: cache });
    chmodSync(locked, 0o700);
    expect(res).toMatchObject({ unreadableDirs: 1, parsed: 1 });
    expect(res.error).toBeUndefined();
    chmodSync(locked, 0o000);
    expect(mailCheck(root)).toBe("Apple Mail receipts readable: yes (1 found, 1 folders unreadable)");
    chmodSync(locked, 0o700);
    expect(mailCheck(join(root, "nope"))).toBe("Apple Mail receipts readable: no (no Apple Mail data found)");
  });

  test("invariant matched = parsed + failed + duplicates over the whole fixture set", () => {
    const { root, msgs } = mailRoot();
    fixtureNames().forEach((n, i) => writeFileSync(join(msgs, `${i + 1}.emlx`), emlx(fixture(n))));
    writeFileSync(join(msgs, "dup.emlx"), emlx(fixture(fixtureNames()[0])));
    writeFileSync(join(msgs, "trunc.emlx"), Buffer.from(`99999\nFrom: noreply@uber.com\nDate: Tue, 04 Aug 2026 00:45:00 GMT\n\nshort`));
    const { db, cache } = freshDb();
    const r = ingestAppleMail(db, { root, cacheDir: cache, since: 0 });
    expect(r.matched).toBe(r.parsed + r.failed + r.duplicates);
    expect(r.duplicates).toBe(1);
    expect(r.failed).toBeGreaterThanOrEqual(1); // the truncated body
  });
});

describe("round-3 contract", () => {
  const commute = () => fixture(fixtureNames().find((n) => n.startsWith("commute"))!);
  const D = "Tue, 04 Aug 2026 00:45:00 GMT";

  test("sender is the addr-spec, never a display name or comment", () => {
    expect(senderAddress("Uber Receipts <noreply@uber.com>")).toBe("noreply@uber.com");
    expect(senderAddress("noreply@uber.com")).toBe("noreply@uber.com");
    expect(senderAddress('"noreply@uber.com" <attacker@evil.com>')).toBe("attacker@evil.com");
    expect(senderAddress("Uber (noreply@uber.com) <x@evil.com>")).toBe("x@evil.com");
    expect(senderAddress("noreply@uber.com (Uber)")).toBe("noreply@uber.com");
    expect(senderAddress("a@uber.com, b@x.com")).toBeNull();
    expect(senderAddress("<a@uber.com>, <b@x.com>")).toBeNull();
    expect(senderAddress("Uber")).toBeNull();
    for (const from of ['"noreply@uber.com" <attacker@evil.com>', "Uber (noreply@uber.com) <x@evil.com>", "a@uber.com, b@x.com"])
      expect(isReceiptHeader({ from, date: D })).toBe(false);
  });

  test("crash before commit: prior row and file intact, at most an orphan file", () => {
    const { root, msgs } = mailRoot();
    const c = commute();
    writeFileSync(join(msgs, "1.emlx"), emlx(c));
    const { db, cache } = freshDb();
    ingestAppleMail(db, { root, cacheDir: cache });
    const before = db.query("SELECT * FROM receipts").all() as any[];
    const oldBody = readFileSync(before[0].raw_path, "utf8");
    writeFileSync(join(msgs, "1.emlx"), emlx(c.replace("Thanks for riding", "Thanks again for riding"))); // same Message-ID, new body
    expect(() => ingestAppleMail(db, { root, cacheDir: cache }, { beforeCommit: () => { throw new Error("crash"); } })).toThrow("crash");
    expect(db.query("SELECT * FROM receipts").all()).toEqual(before);
    expect(readFileSync(before[0].raw_path, "utf8")).toBe(oldBody);
    expect(readdirSync(cache).filter((f) => f.endsWith(".eml")).length).toBe(2); // old + orphan
    // A later successful run pairs the row with its own body.
    ingestAppleMail(db, { root, cacheDir: cache });
    const row = db.query("SELECT raw_path FROM receipts").get() as any;
    expect(readFileSync(row.raw_path, "utf8")).toContain("Thanks again for riding");
  });

  test("cache write failure leaves a pre-existing row untouched", () => {
    const { root, msgs } = mailRoot();
    const c = commute();
    writeFileSync(join(msgs, "1.emlx"), emlx(c));
    const { db, cache } = freshDb();
    ingestAppleMail(db, { root, cacheDir: cache });
    const before = db.query("SELECT * FROM receipts").all();
    writeFileSync(join(msgs, "1.emlx"), emlx(c.replace("Thanks for riding", "Thanks again for riding")));
    const res = ingestAppleMail(db, { root, cacheDir: cache }, { writeCache: () => { throw new Error("EROFS"); } });
    expect(res).toMatchObject({ matched: 1, failed: 1, parsed: 0 });
    expect(db.query("SELECT * FROM receipts").all()).toEqual(before);
  });

  test("an invalid first copy doesn't hide a valid later copy of the same id", () => {
    const { root, msgs } = mailRoot();
    const c = commute();
    const mid = /^Message-ID:[^\n]*\n/im.exec(c)![0];
    writeFileSync(join(msgs, "1.emlx"), emlx(`From: Uber <noreply@uber.com>\r\nDate: ${D}\r\n${mid}\r\nunparseable body`));
    writeFileSync(join(msgs, "2.emlx"), emlx(c));
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toMatchObject({ matched: 2, failed: 1, duplicates: 0, parsed: 1 });
  });

  test("header scan stops at the declared RFC822 length (never reads the plist)", () => {
    const { root, msgs } = mailRoot();
    const rfc = `From: Uber <noreply@uber.com>\nDate: ${D}\nX-No-Blank-Line: true`; // no header terminator inside N
    const body = Buffer.from(rfc);
    writeFileSync(join(msgs, "1.emlx"), Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from("\n\n<plist/>\n")]));
    expect(headOf(join(msgs, "1.emlx"))).toBeNull();
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toMatchObject({ found: 1, skipped: 1, matched: 0 });
  });

  test("files over 10 MB are failed without parsing", () => {
    const { root, msgs } = mailRoot();
    writeFileSync(join(msgs, "1.emlx"), emlx(`From: Uber <noreply@uber.com>\nDate: ${D}\n\n${"x".repeat(11 * 1024 * 1024)}`));
    const { db, cache } = freshDb();
    expect(ingestAppleMail(db, { root, cacheDir: cache })).toMatchObject({ matched: 1, failed: 1, parsed: 0 });
  });
});
