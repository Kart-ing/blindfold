import { expect, test } from "bun:test";
import { KitTransport } from "../src/imessage/kit";

const OWNER = "+14155550123";
const row = (rowId: number, participant = OWNER, text = "Can I buy a $400 jacket?") =>
  ({ rowId, id: `g${rowId}`, participant, text, isFromMe: false, chatKind: "dm" });

function fakeSdk(rows: any[]) {
  let events: any;
  return {
    sdk: {
      startWatching: async (e: any) => { events = e; },
      stopWatching: async () => {},
      close: async () => {},
      send: async () => {},
      getMessages: async () => rows,
    },
    fire: (m: any) => events.onIncomingMessage(m),
  };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("polling picks up a message the file watch missed", async () => {
  const { sdk } = fakeSdk([row(1)]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, sdk as any, { pollMs: 10 });
  await t.start(async (text) => { got.push(text); });
  await wait(60);
  await t.stop();
  expect(got).toEqual(["Can I buy a $400 jacket?"]);
});

test("a message found by both the watcher and the poll is handled once", async () => {
  const m = row(2);
  const { sdk, fire } = fakeSdk([m]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, sdk as any, { pollMs: 10 });
  await t.start(async (text) => { got.push(text); });
  fire(m);
  await wait(60);
  await t.stop();
  expect(got.length).toBe(1);
});

test("the poll still applies the owner filter", async () => {
  const { sdk } = fakeSdk([row(3, "+14155559999", "hi"), row(4)]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, sdk as any, { pollMs: 10 });
  await t.start(async (text) => { got.push(text); });
  await wait(60);
  await t.stop();
  expect(got).toEqual(["Can I buy a $400 jacket?"]);
});

test("no getMessages on the sdk → no polling (older fakes keep working)", async () => {
  const { sdk } = fakeSdk([row(5)]);
  delete (sdk as any).getMessages;
  const got: string[] = [];
  const t = new KitTransport(OWNER, sdk as any, { pollMs: 10 });
  await t.start(async (text) => { got.push(text); });
  await wait(40);
  await t.stop();
  expect(got).toEqual([]);
});

// ---- ROWID cursor hardening ----
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaxRowId } from "../src/imessage/kit";

function cursorSdk(rows: any[]) {
  const queries: any[] = [];
  let events: any;
  return {
    queries,
    rows,
    fire: (m: any) => events.onIncomingMessage(m),
    sdk: {
      startWatching: async (e: any) => { events = e; },
      stopWatching: async () => {},
      close: async () => {},
      send: async () => {},
      // Like a kit that ignores the cursor fields: returns everything; the transport must filter by ROWID itself.
      getMessages: async (q: any) => { queries.push(q); return [...rows]; },
    },
  };
}
const run = async (f: ReturnType<typeof cursorSdk>, opts: any, ms = 60) => {
  const got: string[] = [];
  const t = new KitTransport(OWNER, f.sdk as any, { pollMs: 5, ...opts });
  await t.start(async (text) => { got.push(text); });
  await wait(ms);
  return { got, stop: () => t.stop() };
};

test("rows at or below the start cursor are never replayed", async () => {
  const f = cursorSdk([row(9, OWNER, "old"), row(10, OWNER, "also old"), row(11, OWNER, "new")]);
  const { got, stop } = await run(f, { startRowId: () => 10 });
  await stop();
  expect(got).toEqual(["new"]);
});

test("the poll queries by ROWID cursor (ascending), never by date, and advances it", async () => {
  const f = cursorSdk([row(11, OWNER, "a")]);
  const { stop } = await run(f, { startRowId: () => 10 });
  await stop();
  expect(f.queries[0]).toMatchObject({ isFromMe: false, sinceRowId: 10, orderByRowIdAsc: true });
  expect(f.queries[0].since).toBeUndefined();
  expect(f.queries.at(-1).sinceRowId).toBe(11);
});

test("a skewed or late message date doesn't hide a new row", async () => {
  const late = { ...row(11, OWNER, "sent while the Mac was offline"), date: new Date("2026-10-22T08:00:00Z") };
  const { got, stop } = await run(cursorSdk([late]), { startRowId: () => 10 });
  await stop();
  expect(got).toEqual(["sent while the Mac was offline"]);
});

test("a half-written row is retried, not lost; later rows aren't blocked; handled exactly once", async () => {
  const half = row(12, null as any, "first");
  const f = cursorSdk([half, row(13, OWNER, "second")]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, f.sdk as any, { pollMs: 5, startRowId: () => 11 });
  await t.start(async (text) => { got.push(text); });
  await wait(30);
  expect(got).toEqual(["second"]);
  expect(f.queries.at(-1).sinceRowId).toBe(11); // cursor held before the half-written row
  f.rows[0] = row(12, OWNER, "first"); // the handle join lands
  await wait(40);
  await t.stop();
  expect(got).toEqual(["second", "first"]);
  expect(f.queries.at(-1).sinceRowId).toBe(13);
});

test("a row that never completes is skipped after the grace period", async () => {
  const f = cursorSdk([row(12, null as any, "ghost"), row(13, OWNER, "real")]);
  const { got, stop } = await run(f, { startRowId: () => 11, incompleteGraceMs: 20 }, 80);
  await stop();
  expect(got).toEqual(["real"]);
  expect(f.queries.at(-1).sinceRowId).toBe(13);
});

test("the watcher seeing a half-written row first doesn't poison the dedupe", async () => {
  const f = cursorSdk([]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, f.sdk as any, { pollMs: 5, startRowId: () => 13 });
  await t.start(async (text) => { got.push(text); });
  f.fire(row(14, null as any, "hello"));
  f.rows.push(row(14, OWNER, "hello"));
  await wait(40);
  f.fire(row(14, OWNER, "hello")); // a late watcher copy
  await wait(20);
  await t.stop();
  expect(got).toEqual(["hello"]);
});

test("chat.db unreadable at start: the first readable max becomes the baseline (no history replay)", async () => {
  let readable = false;
  const f = cursorSdk([row(49, OWNER, "history"), row(50, OWNER, "history too")]);
  const got: string[] = [];
  const t = new KitTransport(OWNER, f.sdk as any, { pollMs: 5, startRowId: () => (readable ? 50 : null) });
  await t.start(async (text) => { got.push(text); });
  await wait(20);
  readable = true;
  await wait(20);
  f.rows.push(row(51, OWNER, "first live"));
  await wait(30);
  await t.stop();
  expect(got).toEqual(["first live"]);
});

test("readMaxRowId reads MAX(ROWID) read-only, null when unreadable", () => {
  const p = join(tmpdir(), `fin-chatdb-${process.pid}-${Date.now()}.db`);
  const db = new Database(p, { create: true });
  db.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT)");
  db.run("INSERT INTO message (ROWID, text) VALUES (7, 'a'), (42, 'b')");
  db.close();
  try {
    expect(readMaxRowId(p)).toBe(42);
    expect(readMaxRowId(join(tmpdir(), "definitely-missing-chat.db"))).toBeNull();
  } finally {
    rmSync(p, { force: true });
  }
});
