import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { parseCommand } from "../src/imessage/commands";
import { classify, keywordIntent, onboardingText, overrideIntent, preloadHandlers, route, type RouteDeps } from "../src/imessage/router";
import { merchantLookup, merchantNamed } from "../src/imessage/lookup";
import { parseAssetStatement } from "../src/imessage/assets";
import { maybePrompt, promptText } from "../src/imessage/prompts";
import { fromLocal } from "../src/imessage/clock";
import { noFm, type Fm } from "../src/imessage/fm";
import { acceptFromOwner, normalizeHandle } from "../src/imessage/kit";
import type { Handler, Intent, Reply } from "../src/handlers/types";

const NOW = fromLocal(2026, 10, 22, 14, 0); // Thu Oct 22 2026 14:00 PT
const NEXT_DAY = fromLocal(2026, 10, 23, 14, 0);

const paths: string[] = [];
let seq = 0;
function freshDb(): Database {
  const p = join(tmpdir(), `fin-imsg-${process.pid}-${Date.now()}-${seq++}.db`);
  paths.push(p);
  const db = openDb(p);
  db.run("INSERT INTO accounts(id, name, issuer, type, shared) VALUES ('amex','Amex','amex','credit',1)");
  return db;
}
afterEach(() => {
  for (const p of paths.splice(0)) for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
});

let tx = 0;
/** Seeds a flagged (needs_prompt=1) transaction; returns its id. */
function flagged(db: Database, merchant: string, cents: number, ts = NOW - 3600): string {
  const id = `t${tx++}`;
  db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES (?, 'amex', ?, ?, ?)", [id, ts, cents, merchant]);
  db.run("INSERT INTO attributions(txn_id, owner, rule, confidence, needs_prompt) VALUES (?, 'me', 7, 0.5, 1)", [id]);
  return id;
}

const fmReturning = (out: Record<string, unknown> | null): Fm => ({ extract: async () => out, respond: async () => null });

/** Fake handler registry: records calls, returns a canned reply per intent. */
function fakeHandlers(replies: Partial<Record<Intent, Reply | (() => Promise<Reply>)>> = {}) {
  const calls: { intent: Intent; text: string }[] = [];
  const loadHandler = async (intent: Intent): Promise<Handler | null> => {
    const r = replies[intent];
    if (r === undefined) return async (_db, text) => { calls.push({ intent, text }); return { text: `${intent} ok`, tier: "local" }; };
    return async (_db, text) => { calls.push({ intent, text }); return typeof r === "function" ? r() : r; };
  };
  return { calls, loadHandler };
}

const withGoal = (db: Database) =>
  db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (1000000, ?, ?, 0, 1)", [NOW + 200 * 86_400, NOW - 30 * 86_400]);
const ledgerRows = (db: Database) => db.query("SELECT * FROM ledger ORDER BY id").all() as any[];
const attr = (db: Database, id: string) => db.query("SELECT * FROM attributions WHERE txn_id = ?").get(id) as any;
const prompts = (db: Database) => db.query("SELECT * FROM prompts ORDER BY id").all() as any[];

function sender() {
  const sent: string[] = [];
  return { sent, send: async (t: string) => { sent.push(t); } };
}

describe("parseCommand", () => {
  const cases: [string, ReturnType<typeof parseCommand>][] = [
    ["ledger", { kind: "ledger" }],
    ["Ledger.", { kind: "ledger" }],
    ["  LEDGER!  ", { kind: "ledger" }],
    ["privacy", { kind: "privacy" }],
    ["Rules", { kind: "rules" }],
    ["stop nudges", { kind: "nudges", on: false }],
    ["Stop   Nudges!", { kind: "nudges", on: false }],
    ["nudges on", { kind: "nudges", on: true }],
    ["revoke cloud_plan", { kind: "revoke", scope: "cloud_plan" }],
    ["home is 1 Main St", { kind: "place", label: "HOME", address: "1 Main St" }],
    ["Work is 500 Howard St, San Francisco", { kind: "place", label: "WORK", address: "500 Howard St, San Francisco" }],
    ["goal 10000 by june", { kind: "goal" }],
    ["goal $10k by june 2027", { kind: "goal" }],
    ["Goal $10,000 by June.", { kind: "goal" }],
    ["that was hers", { kind: "relabel", owner: "her" }],
    ["That was mine.", { kind: "relabel", owner: "me" }],
    ["that was shared", { kind: "relabel", owner: "shared" }],
    ["1", { kind: "answer", choice: 1 }],
    ["2", { kind: "answer", choice: 2 }],
    ["3.", { kind: "answer", choice: 3 }],
    ["4", null],
    ["tick 17:30", null],
    ["can I afford a $400 jacket?", null],
    ["how much did I spend on food", null],
  ];
  for (const [input, want] of cases) test(JSON.stringify(input), () => expect(parseCommand(input)).toEqual(want));

  test("tick only with cli", () => {
    expect(parseCommand("tick 17:30", { cli: true })).toEqual({ kind: "tick", at: "17:30" });
    expect(parseCommand("tick 17:30", { cli: false })).toBeNull();
  });
});

describe("route: ledger rows", () => {
  test("every answer writes exactly one row with tier and intent", async () => {
    const db = freshDb();
    const h = fakeHandlers({ afford: { text: "yes", tier: "on-device" } });
    const deps: RouteDeps = { fm: noFm, loadHandler: h.loadHandler };
    await route(db, "rules", { now: NOW }, deps);
    await route(db, "Can I buy a $400 jacket?", { now: NOW }, deps);
    await route(db, "1", { now: NOW }, deps); // nothing pending
    const rows = ledgerRows(db);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => [r.tier, r.intent, r.ts])).toEqual([
      ["local", "command", NOW], ["on-device", "afford", NOW], ["local", "command", NOW],
    ]);
  });

  test("Reply.ledger meta is copied into the row", async () => {
    const db = freshDb();
    const meta = { question_sym: "Q(A1)", payload_json: '{"x":1}', exact_disclosed: 2, partial_count: 3, canary_checked: 1, canary_hits: 0, consent: "cloud_plan" };
    const h = fakeHandlers({ other: { text: "plan", tier: "cloud", ledger: meta } });
    await route(db, "what should my financial plan be", { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
    const [r] = ledgerRows(db);
    expect(r.tier).toBe("cloud");
    expect(r.intent).toBe("other");
    expect(h.calls).toEqual([{ intent: "other", text: "what should my financial plan be" }]);
    for (const [k, v] of Object.entries(meta)) expect(r[k]).toBe(v);
  });

  test("ledger summary: non-command rows only, local vs cloud, exact values, computed before its own row", async () => {
    const db = freshDb();
    const first = await route(db, "ledger", { now: NOW }, { fm: noFm });
    expect(first.text).toBe("0 questions, 0 never left your Mac, 0 exact values sent.\nCloud today: nothing left your Mac.");
    const h = fakeHandlers({
      afford: { text: "a", tier: "local" },
      spend_query: { text: "s", tier: "on-device" },
      other: { text: "o", tier: "cloud", ledger: { exact_disclosed: 2, partial_count: 1, consent: "cloud_plan", canary_checked: 1, canary_hits: 0,
        payload_json: JSON.stringify({ system: "static MERCHANT_9", messages: [{ role: "user", content: "spend at MERCHANT_4 over Q_AMT_1?" }] }) } },
    });
    const deps: RouteDeps = { fm: noFm, loadHandler: h.loadHandler };
    await route(db, "can I afford a bike", { now: NOW }, deps);
    await route(db, "how much did I spend on food", { now: NOW }, deps);
    await route(db, "tell me a story about money", { now: NOW }, deps);
    await route(db, "rules", { now: NOW }, deps);
    await route(db, "privacy", { now: NOW }, deps);
    const s = (await route(db, "ledger", { now: NOW }, deps)).text;
    expect(s).toContain("3 questions, 2 never left your Mac, 2 exact values sent.");
    // Cloud details come from eng3's privacyLine, stated once.
    expect(s).toBe("3 questions, 2 never left your Mac, 2 exact values sent.\n" +
      "Cloud today: 1 call. Sent as symbols only: MERCHANT_4, Q_AMT_1. 2 exact values, 1 partial.");
    expect(s).not.toContain("Cloud:");
    expect(ledgerRows(db).length).toBe(7);
  });

  test("ledger reports blocked canary calls", async () => {
    const db = freshDb();
    const h = fakeHandlers({ other: { text: "blocked", tier: "cloud", ledger: { canary_checked: 1, canary_hits: 2 } } });
    await route(db, "something open ended", { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
    expect((await route(db, "ledger", { now: NOW }, { fm: noFm })).text).toContain("1 blocked by the leak check.");
  });
});

describe("route: commands", () => {
  test("home is <addr> upserts places and never echoes the address", async () => {
    const db = freshDb();
    // Known addresses come from eng-1's local lookup (fixtures/locations.json); unknown ones are refused.
    const r1 = await route(db, "home is 1550 Mission St, San Francisco, CA 94103", { now: NOW }, { fm: noFm });
    expect(r1.text).toStartWith("Saved HOME");
    expect(r1.text).not.toContain("Mission");
    expect(r1.tier).toBe("local");
    const r2 = await route(db, "work is 1 Market Street, San Francisco, CA 94105", { now: NOW }, { fm: noFm });
    expect(r2.text).toStartWith("Saved WORK");
    expect(r2.text).not.toContain("Market");
    const r3 = await route(db, "Home is 22 Elm Ave", { now: NOW }, { fm: noFm });
    expect(r3.text).toBe("I can only use addresses I know offline. HOME is unchanged.");
    expect(r3.text).not.toContain("Elm");
    expect((db.query("SELECT label FROM places WHERE label IN ('HOME','WORK') ORDER BY label").all() as any[]).map((r) => r.label))
      .toEqual(["HOME", "WORK"]);
    for (const r of ledgerRows(db)) expect(JSON.stringify(r)).not.toMatch(/Mission|Market|Elm Ave/);
  });

  test("stop nudges / nudges on set settings.nudges", async () => {
    const db = freshDb();
    const get = () => (db.query("SELECT value FROM settings WHERE key = 'nudges'").get() as any)?.value;
    await route(db, "stop nudges", { now: NOW }, { fm: noFm });
    expect(get()).toBe("off");
    await route(db, "nudges on", { now: NOW }, { fm: noFm });
    expect(get()).toBe("on");
  });

  test("revoke deletes a consent", async () => {
    const db = freshDb();
    db.run("INSERT INTO consents(scope, grant_kind, ts) VALUES ('cloud_plan', 'always', ?)", [NOW]);
    expect((await route(db, "privacy", { now: NOW }, { fm: noFm })).text).toContain("cloud_plan (always)");
    expect((await route(db, "revoke cloud_plan", { now: NOW }, { fm: noFm })).text).toBe("Revoked cloud_plan.");
    expect(db.query("SELECT COUNT(*) AS n FROM consents").get()).toEqual({ n: 0 });
    expect((await route(db, "revoke cloud_plan", { now: NOW }, { fm: noFm })).text).toBe("No consent named cloud_plan.");
  });

  test("goal command dispatches to goal_set with raw text", async () => {
    const db = freshDb();
    const h = fakeHandlers({ goal_set: { text: "goal saved", tier: "local" } });
    const r = await route(db, "Goal $10k by June 2027", { now: NOW }, { fm: fmReturning({ intent: "other" }), loadHandler: h.loadHandler });
    expect(r.text).toBe("goal saved");
    expect(h.calls).toEqual([{ intent: "goal_set", text: "Goal $10k by June 2027" }]);
    expect(ledgerRows(db).map((x) => x.intent)).toEqual(["goal_set"]);
  });

  test("tick runs only in cli mode", async () => {
    const db = freshDb();
    const tick = async (at: string) => `ticked ${at}`;
    expect((await route(db, "tick 17:30", { now: NOW }, { fm: noFm, cli: true, tick })).text).toBe("ticked 17:30");
    const h = fakeHandlers();
    await route(db, "tick 17:30", { now: NOW }, { fm: noFm, tick, loadHandler: h.loadHandler });
    expect(h.calls.map((c) => c.intent)).toEqual(["other"]);
  });
});

describe("route: intent classification", () => {
  test("no local model in routing: an fm verdict is ignored, keywords decide (Luna is tried first, elsewhere)", async () => {
    const db = freshDb();
    const h = fakeHandlers();
    await route(db, "hmm what about that coat", { now: NOW }, { fm: fmReturning({ intent: "afford" }), loadHandler: h.loadHandler });
    await route(db, "Can I buy a $400 jacket?", { now: NOW }, { fm: fmReturning({ intent: "other" }), loadHandler: h.loadHandler });
    expect(h.calls.map((c) => c.intent)).toEqual(["other", "afford"]);
  });

  test("fm null → keyword fallback", async () => {
    const db = freshDb();
    const h = fakeHandlers();
    const deps: RouteDeps = { fm: noFm, loadHandler: h.loadHandler };
    await route(db, "Can I buy a $400 jacket?", { now: NOW }, deps);
    await route(db, "how much did I spend on food", { now: NOW }, deps);
    await route(db, "the weather is nice", { now: NOW }, deps);
    expect(h.calls.map((c) => c.intent)).toEqual(["afford", "spend_query", "other"]);
  });

  test("fm invalid intent → keyword fallback", async () => {
    const db = freshDb();
    const h = fakeHandlers();
    await route(db, "Can I buy a $400 jacket?", { now: NOW }, { fm: fmReturning({ intent: "shopping" }), loadHandler: h.loadHandler });
    await route(db, "how much did I spend on food", { now: NOW }, { fm: fmReturning({ intent: 3 }), loadHandler: h.loadHandler });
    expect(h.calls.map((c) => c.intent)).toEqual(["afford", "spend_query"]);
  });

  test("an fm 'command' verdict is ignored too: the text routes by keywords", async () => {
    const db = freshDb();
    const h = fakeHandlers();
    await route(db, "turn off the reminders please", { now: NOW }, { fm: fmReturning({ intent: "command" }), loadHandler: h.loadHandler });
    expect(h.calls.map((c) => c.intent)).toEqual(["other"]);
  });

  test("missing handler → not ready, local", async () => {
    const db = freshDb();
    const r = await route(db, "am I on track", { now: NOW }, { fm: fmReturning({ intent: "goal_status" }), loadHandler: async () => null });
    expect(r).toEqual({ text: "goal_status: not ready yet.", tier: "local" });
    expect(ledgerRows(db).map((x) => [x.tier, x.intent])).toEqual([["local", "goal_status"]]);
  });

  test("handler throwing → apology, still one ledger row", async () => {
    const db = freshDb();
    const origErr = console.error;
    console.error = () => {};
    try {
      const h = fakeHandlers({ afford: async () => { throw new Error("boom"); } });
      const r = await route(db, "can I afford it", { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
      expect(r.text).toBe("Sorry, something went wrong answering that.");
      expect(r.tier).toBe("local");
    } finally {
      console.error = origErr;
    }
    expect(ledgerRows(db).map((x) => [x.tier, x.intent])).toEqual([["local", "afford"]]);
  });
});

describe("low-confidence prompts", () => {
  test("sends the PRD prompt for a needs_prompt row", async () => {
    const db = freshDb();
    const id = flagged(db, "Nordstrom", 12_500);
    const s = sender();
    const t = await maybePrompt(db, NOW, s.send);
    expect(t).toBe("Quick one: was that $125 Nordstrom yours? 1 me · 2 her · 3 split");
    expect(s.sent).toEqual([t!]);
    expect(prompts(db).map((p) => [p.kind, p.ref, p.sent_ts, p.answered])).toEqual([["who_paid", id, NOW, null]]);
    expect(promptText("X", 7_650)).toBe("Quick one: was that $76.50 X yours? 1 me · 2 her · 3 split");
  });

  test("failed send releases the pending slot so the next tick retries", async () => {
    const db = freshDb();
    flagged(db, "Retry", 10_000);
    await expect(maybePrompt(db, NOW, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(prompts(db)).toEqual([]);
    const s = sender();
    expect(await maybePrompt(db, NOW + 60, s.send)).toBe("Quick one: was that $100 Retry yours? 1 me · 2 her · 3 split");
  });

  test("nothing while one is pending", async () => {
    const db = freshDb();
    flagged(db, "A", 10_000);
    flagged(db, "B", 20_000);
    const s = sender();
    expect(await maybePrompt(db, NOW, s.send)).not.toBeNull();
    expect(await maybePrompt(db, NOW + 60, s.send)).toBeNull();
    expect(s.sent.length).toBe(1);
  });

  test("at most 3 per local day; next day allowed", async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) flagged(db, `M${i}`, 10_000 + i, NOW - 3600 * (i + 1));
    const s = sender();
    for (let i = 0; i < 3; i++) {
      expect(await maybePrompt(db, NOW + i * 60, s.send)).not.toBeNull();
      await route(db, "1", { now: NOW + i * 60 + 30 }, { fm: noFm });
    }
    expect(await maybePrompt(db, NOW + 600, s.send)).toBeNull();
    expect(s.sent.length).toBe(3);
    expect(await maybePrompt(db, NEXT_DAY, s.send)).not.toBeNull();
    expect(s.sent.length).toBe(4);
  });

  test("never re-prompts the same txn", async () => {
    const db = freshDb();
    const id = flagged(db, "Once", 9_000);
    const s = sender();
    await maybePrompt(db, NOW, s.send);
    db.run("UPDATE prompts SET answered = '1', answered_ts = ?", [NOW]);
    db.run("UPDATE attributions SET needs_prompt = 1, labelled_by_user = 0 WHERE txn_id = ?", [id]);
    expect(await maybePrompt(db, NEXT_DAY, s.send)).toBeNull();
    expect(s.sent.length).toBe(1);
  });

  test("nothing during quiet hours", async () => {
    const db = freshDb();
    flagged(db, "Late", 9_000, fromLocal(2026, 10, 21, 12));
    const s = sender();
    expect(await maybePrompt(db, fromLocal(2026, 10, 22, 23, 0), s.send)).toBeNull();
    expect(await maybePrompt(db, fromLocal(2026, 10, 22, 7, 30), s.send)).toBeNull();
    expect(s.sent).toEqual([]);
    expect(prompts(db)).toEqual([]);
  });

  test("answer 2 → her, rule 1, labelled, prompt answered", async () => {
    const db = freshDb();
    const id = flagged(db, "Sephora", 8_800);
    await maybePrompt(db, NOW, sender().send);
    const r = await route(db, "2", { now: NOW + 60 }, { fm: noFm });
    expect(r.text).toContain("hers");
    expect(attr(db, id)).toMatchObject({ owner: "her", rule: 1, labelled_by_user: 1, needs_prompt: 0, confidence: 1 });
    expect(prompts(db)[0]).toMatchObject({ answered: "2", answered_ts: NOW + 60 });
    expect(ledgerRows(db).map((x) => [x.tier, x.intent])).toEqual([["local", "command"]]);
  });

  for (const [choice, owner] of [["1", "me"], ["3", "shared"]] as const) {
    test(`answer ${choice} → ${owner}`, async () => {
      const db = freshDb();
      const id = flagged(db, "Target", 9_900);
      await maybePrompt(db, NOW, sender().send);
      await route(db, choice, { now: NOW + 60 }, { fm: noFm });
      expect(attr(db, id)).toMatchObject({ owner, rule: 1, labelled_by_user: 1, needs_prompt: 0 });
      expect(prompts(db)[0].answered).toBe(choice);
    });
  }

  for (const bad of ["4", "yes"]) {
    test(`"${bad}" with a pending prompt gets one soft re-ask, no label change`, async () => {
      const db = freshDb();
      const id = flagged(db, "Uber", 4_200);
      await maybePrompt(db, NOW, sender().send);
      const h = fakeHandlers();
      const r = await route(db, bad, { now: NOW + 60 }, { fm: noFm, loadHandler: h.loadHandler });
      expect(r.text).toBe("No stress. Was that $42 Uber yours? 1 me · 2 her · 3 split");
      expect(r.tier).toBe("local");
      expect(h.calls).toEqual([]);
      expect(attr(db, id)).toMatchObject({ owner: "me", rule: 7, labelled_by_user: 0, needs_prompt: 1 });
      expect(prompts(db)[0].answered).toBeNull();
    });
  }

  test('"1" with nothing pending → Nothing to answer', async () => {
    const db = freshDb();
    expect((await route(db, "1", { now: NOW }, { fm: noFm })).text).toBe("Nothing to answer right now.");
  });

  test("a long question while pending routes normally", async () => {
    const db = freshDb();
    const id = flagged(db, "Uber", 4_200);
    await maybePrompt(db, NOW, sender().send);
    const h = fakeHandlers();
    await route(db, "Can I buy a $400 jacket?", { now: NOW + 60 }, { fm: noFm, loadHandler: h.loadHandler });
    expect(h.calls.map((c) => c.intent)).toEqual(["afford"]);
    expect(prompts(db)[0].answered).toBeNull();
    expect(attr(db, id).needs_prompt).toBe(1);
  });

  test('"that was hers" relabels the last prompted txn', async () => {
    const db = freshDb();
    const older = flagged(db, "Older", 5_000, NOW - 7200);
    const prompted = flagged(db, "Lyft", 3_100, NOW - 3600);
    const other = flagged(db, "Newer", 6_000, NOW + 10); // not yet visible to maybePrompt (ts > now)
    await maybePrompt(db, NOW, sender().send);
    expect(prompts(db)[0].ref).toBe(prompted);
    const r = await route(db, "That was hers.", { now: NOW + 60 }, { fm: noFm });
    expect(r.text).toBe("Relabelled Lyft $31 as hers.");
    expect(attr(db, prompted)).toMatchObject({ owner: "her", rule: 1, labelled_by_user: 1, needs_prompt: 0 });
    expect(attr(db, older).needs_prompt).toBe(1);
    expect(attr(db, other).needs_prompt).toBe(1);
    expect(prompts(db)[0].answered).toBe("2");
  });

  test('"that was mine" with no prompt ever sent relabels the newest flagged txn', async () => {
    const db = freshDb();
    const a = flagged(db, "A", 1_000, NOW - 7200);
    const b = flagged(db, "B", 2_000, NOW - 3600);
    expect((await route(db, "that was shared", { now: NOW }, { fm: noFm })).text).toBe("Relabelled B $20 as split.");
    expect(attr(db, b).owner).toBe("shared");
    expect(attr(db, a).labelled_by_user).toBe(0);
  });
});

describe("kit owner filter", () => {
  const OWNER = "+1 (555) 123-4567";
  const msg = (o: Partial<Parameters<typeof acceptFromOwner>[0]>) =>
    ({ id: "m", participant: "5551234567", text: "hi", isFromMe: false, chatKind: "dm", ...o });

  test("normalizeHandle", () => {
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("5551234567");
    expect(normalizeHandle("5551234567")).toBe("5551234567");
    expect(normalizeHandle(" Me@Example.COM ")).toBe("me@example.com");
    expect(normalizeHandle(null)).toBe("");
    expect(normalizeHandle("")).toBe("");
  });

  test("owner phone in different formats accepted", () => {
    expect(acceptFromOwner(msg({}), OWNER)).toBe(true);
    expect(acceptFromOwner(msg({ participant: "+15551234567" }), "5551234567")).toBe(true);
    expect(acceptFromOwner(msg({ participant: "555-123-4567" }), OWNER)).toBe(true);
  });

  test("rejects other number, isFromMe, group, empty text", () => {
    expect(acceptFromOwner(msg({ participant: "+1 555 123 9999" }), OWNER)).toBe(false);
    expect(acceptFromOwner(msg({ isFromMe: true }), OWNER)).toBe(false);
    expect(acceptFromOwner(msg({ chatKind: "group" }), OWNER)).toBe(false);
    expect(acceptFromOwner(msg({ text: "   " }), OWNER)).toBe(false);
    expect(acceptFromOwner(msg({ participant: null }), OWNER)).toBe(false);
  });

  test("email case-insensitive", () => {
    expect(acceptFromOwner(msg({ participant: "Owner@iCloud.com" }), "owner@icloud.com")).toBe(true);
    expect(acceptFromOwner(msg({ participant: "other@icloud.com" }), "owner@icloud.com")).toBe(false);
  });

  test("empty owner rejects everything", () => {
    expect(acceptFromOwner(msg({}), "")).toBe(false);
    expect(acceptFromOwner(msg({ participant: "" }), "")).toBe(false);
    expect(acceptFromOwner(msg({ participant: null }), "  ")).toBe(false);
  });
});

describe("routing table: single-period lookups stay local, comparative/open-ended go to other", () => {
  const CASES: [string, string][] = [
    ["What changed in my spending since August?", "other"],
    ["Can I afford a $1,200 trip in December if I keep spending like the last three months?", "other"],
    ["Which subscriptions am I paying for every month?", "other"],
    ["how much did I spend on food last month", "spend_query"],
    ["How much did I spend on Uber in October?", "spend_query"],
    ["total spent on groceries this month", "spend_query"],
    ["top 3 merchants I spent at in September", "spend_query"],
    ["Can I buy a $400 jacket?", "afford"],
    ["can I afford a $90 dinner", "afford"],
    ["am I on track for my goal", "goal_status"],
    ["compare my food spending to last month", "other"],
    ["Uber vs Lyft spending", "other"],
    ["what's my spending trend", "other"],
    ["did I spend more than last month on takeout", "other"],
    ["why am I behind on my goal", "other"],
    ["should I cancel Netflix", "other"],
    ["which recurring charges should I cancel", "other"],
    ["how much have I spent since July", "other"],
    ["Why did Neighborhood Books charge me?", "other"],
  ];
  for (const [q, want] of CASES) {
    test(`${want} ← ${q}`, async () => {
      expect(keywordIntent(q) === want || overrideIntent(q, keywordIntent(q)) === want).toBe(true);
      // fm saying spend_query/afford is overridden deterministically for open-ended questions.
      const fmSays = want === "other" ? (/spend/i.test(q) ? "spend_query" : /charge/i.test(q) ? "attribution_fix" : "afford") : want;
      expect(await classify(q, { extract: async () => ({ intent: fmSays }), respond: async () => null })).toBe(want);
      expect(await classify(q, noFm)).toBe(want);
    });
  }
});

test("exact relabel commands still win over the open-ended override", async () => {
  const fmAttr = { extract: async () => ({ intent: "attribution_fix" }), respond: async () => null };
  expect(await classify("that one wasn't mine", fmAttr)).toBe("attribution_fix");
  expect(await classify("why was I charged twice by them", fmAttr)).toBe("other");
});

test("ledger: fake-planner rows never left the Mac", async () => {
  const db = freshDb();
  const fakeBody = JSON.stringify({ provider: "fake", system: "…", messages: [{ role: "user", content: "what changed since MERCHANT_1?" }] });
  const h = fakeHandlers({
    afford: { text: "a", tier: "local" },
    other: { text: "[fake planner] o", tier: "cloud", ledger: { payload_json: fakeBody, canary_checked: 10, canary_hits: 0 } },
  });
  const deps: RouteDeps = { fm: noFm, loadHandler: h.loadHandler };
  await route(db, "can I afford a bike", { now: NOW }, deps);
  await route(db, "tell me a story about money", { now: NOW }, deps);
  await route(db, "what is the meaning of my budget", { now: NOW }, deps);
  const s = (await route(db, "ledger", { now: NOW }, deps)).text;
  expect(s).toStartWith("3 questions, 3 never left your Mac, 0 exact values sent.");
  expect(s).toContain("Cloud today: nothing left your Mac.");
  // A real cloud row still counts as having left, and a question that merely mentions the marker can't fake it.
  const real = fakeHandlers({ other: { text: "o", tier: "cloud", ledger: { payload_json: JSON.stringify({ messages: [{ role: "user", content: '"provider":"fake"' }] }) } } });
  await route(db, "another open question", { now: NOW }, { fm: noFm, loadHandler: real.loadHandler });
  expect((await route(db, "ledger", { now: NOW }, deps)).text).toStartWith("4 questions, 3 never left your Mac");
});

describe("pending who-paid question: tiers for non-1/2/3 replies (live strings)", () => {
  const withPrompt = async () => {
    const db = freshDb();
    withGoal(db); // greetings without a goal are the onboarding; these tests are about the who-paid tiers
    const id = flagged(db, "Uber", 4275);
    await maybePrompt(db, NOW, sender().send);
    return { db, id };
  };
  const fmOther = { extract: async () => ({ intent: "other" }), respond: async () => null };
  const run = (db: Database, text: string) => {
    const h = fakeHandlers({ other: { text: "cloud", tier: "cloud" } });
    return route(db, text, { now: NOW + 60 }, { fm: fmOther, loadHandler: h.loadHandler }).then((r) => ({ r, calls: h.calls.map((c) => c.intent) }));
  };

  for (const [word, owner] of [["me", "me"], ["mine", "me"], ["Hers", "her"], ["her", "her"], ["split", "shared"], ["both", "shared"], ["shared", "shared"]] as const) {
    test(`(1) "${word}" answers it → ${owner}`, async () => {
      const { db, id } = await withPrompt();
      const { r, calls } = await run(db, word);
      expect(calls).toEqual([]);
      expect(r.text).toStartWith("Got it");
      expect(attr(db, id)).toMatchObject({ owner, rule: 1, labelled_by_user: 1, needs_prompt: 0 });
    });
  }

  for (const reply of ["nah fam idk what that is", "idk", "not sure", "no idea", "dunno", "I don't know"]) {
    test(`(2) "${reply}" keeps it as mine and closes the question`, async () => {
      const { db, id } = await withPrompt();
      const { r, calls } = await run(db, reply);
      expect(r).toEqual({ text: "No problem, I'll keep it as yours for now. Text 'that was hers' if it turns out to be hers.", tier: "local" });
      expect(calls).toEqual([]);
      expect(attr(db, id)).toMatchObject({ owner: "me", labelled_by_user: 0, needs_prompt: 0 });
      expect(prompts(db)[0].answered).toBe("idk");
      expect(ledgerRows(db).map((x) => x.intent)).toEqual(["command"]);
    });
  }

  test('(3) "Hello" gets a friendly reply plus ONE soft reminder; never "Reply 1, 2 or 3"', async () => {
    const { db } = await withPrompt();
    const first = (await run(db, "Hello")).r.text;
    expect(first).toStartWith("Hey! I'm your money sidekick.");
    expect(first).toEndWith("Also, quick one when you have a sec: was that $42.75 Uber yours? 1 me · 2 her · 3 split");
    expect(first).not.toContain("Reply 1, 2 or 3");
    const again = (await run(db, "hey")).r.text;
    expect(again).toStartWith("Hey! I'm your money sidekick.");
    expect(again).not.toContain("Uber");
  });
  test('(3) "thanks" → Anytime 🙌; "ok" → 👍; with nothing pending, no reminder', async () => {
    const db = freshDb();
    expect((await run(db, "thanks")).r.text).toBe("Anytime 🙌");
    expect((await run(db, "ok")).r.text).toBe("👍");
    expect((await run(db, "Hello")).r.text).not.toContain("Also,");
    const { db: db2 } = await withPrompt();
    expect((await run(db2, "thanks")).r.text).toBe("Anytime 🙌\n\nAlso, quick one when you have a sec: was that $42.75 Uber yours? 1 me · 2 her · 3 split");
  });

  test("(4) other short non-question text: one soft re-ask per question, then left alone", async () => {
    const { db } = await withPrompt();
    expect((await run(db, "not mine")).r.text).toBe("No stress. Was that $42.75 Uber yours? 1 me · 2 her · 3 split");
    const second = await run(db, "lol");
    expect(second.r.text).not.toContain("Uber");
    expect(second.calls).toEqual(["other"]); // routed normally; the question stays open
    expect(prompts(db)[0].answered).toBeNull();
  });
  test("(4) a greeting's reminder counts as the one re-ask", async () => {
    const { db } = await withPrompt();
    await run(db, "Hello");
    expect((await run(db, "hmm")).calls).toEqual(["other"]);
  });

  for (const [q, intent] of [["how much did I spend on food last month", "spend_query"], ["What changed in my spending since August?", "other"], ["can I afford a $90 dinner", "afford"], ["what's my balance", "other"], ["I'm not sure I can afford a $400 jacket?", "afford"]] as const) {
    test(`(5) real question "${q}" → ${intent}, question stays open`, async () => {
      const { db } = await withPrompt();
      const h = fakeHandlers({ [intent]: { text: "ok", tier: intent === "other" ? "cloud" : "local" } } as any);
      await route(db, q, { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
      expect(h.calls.map((c) => c.intent)).toEqual([intent]);
      expect(prompts(db)[0].answered).toBeNull();
    });
  }
  test("with nothing pending, short text routes normally", async () => {
    const db = freshDb();
    expect((await run(db, "nah fam idk what that is")).calls).toEqual(["other"]);
  });
});

test("preloadHandlers loads every built handler once, up front", async () => {
  const { loaded, missing } = await preloadHandlers();
  expect(loaded).toEqual(expect.arrayContaining(["afford", "goal_set", "goal_status", "spend_query", "other"]));
  expect([...loaded, ...missing].sort()).toEqual(["afford", "attribution_fix", "goal_set", "goal_status", "other", "spend_query"]);
});

describe('"what is <merchant>?" is answered locally', () => {
  const seed = () => {
    const db = freshDb();
    db.run("INSERT INTO accounts(id, name, type, subtype, shared, owner) VALUES ('amex', 'Shared Amex', 'credit', 'credit card', 1, 'shared') ON CONFLICT(id) DO NOTHING");
    let n = 0;
    const add = (merchant: string, cents: number, owner: string, month: number) => {
      const id = `m${n++}`;
      db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'amex', ?, ?, ?, 'TRANSPORTATION')",
        [id, fromLocal(2026, month, 10, 9, 0), cents, merchant]);
      db.run("INSERT INTO attributions(txn_id, owner, rule, confidence) VALUES (?, ?, 7, 0.5)", [id, owner]);
    };
    add("Uber", 2000, "me", 8); add("Uber", 3000, "me", 9); add("Uber", 4000, "shared", 10); add("Uber", 9900, "her", 10);
    add("Sephora", 5000, "her", 9); add("Uber Eats", 2500, "me", 10);
    return db;
  };
  test("a known merchant: count and my share since the first charge", () => {
    expect(merchantLookup(seed(), "what is an Uber?")).toBe("Uber is one you've paid 3 times since August, ~$70 total (your share).");
  });
  test("a her-only merchant gets the her-side line", () => {
    expect(merchantLookup(seed(), "what's Sephora")).toBe("Sephora is on her side of the card, so I keep it out of your numbers.");
  });
  test("totals read like a text: thousands get a comma", () => {
    const db = seed();
    for (let i = 0; i < 40; i++) db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, 'amex', ?, 4100, 'Uber', 'TRANSPORTATION')",
      [`big${i}`, fromLocal(2026, 9, 1 + (i % 28), 9, 0)]);
    expect(merchantLookup(db, "what is an Uber?")).toBe("Uber is one you've paid 43 times since August, ~$1,710 total (your share).");
  });
  test("exact name beats a prefix; a unique prefix still matches; unknown → null", () => {
    const db = seed();
    expect(merchantNamed(db, "What is Uber?")).toBe("Uber");
    expect(merchantNamed(db, "who is uber eats")).toBe("Uber Eats");
    expect(merchantNamed(db, "what is Lyft?")).toBeNull();
    expect(merchantLookup(db, "what's my balance")).toBeNull();
    expect(merchantLookup(db, "how much did I spend at Uber")).toBeNull();
  });
  test("the router answers it locally as a spend lookup, no handler or planner", async () => {
    const db = seed();
    const h = fakeHandlers();
    const r = await route(db, "what is an Uber?", { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
    expect(r.tier).toBe("local");
    expect(r.text).toStartWith("Uber is one you've paid 3 times");
    expect(h.calls).toEqual([]);
    expect(ledgerRows(db).at(-1).intent).toBe("spend_query");
  });
});

describe("onboarding: no goal yet", () => {
  const ingest = (db: Database, statements: [string, string][]) => {
    for (const [sha, acct] of statements)
      db.run("INSERT INTO ingest_log(file_sha, path, source, account_id, rows, ingested_ts) VALUES (?, ?, 'csv', ?, 10, ?)", [sha, `/tmp/${sha}.csv`, acct, NOW]);
  };
  const receipts = (db: Database, k: number) => {
    for (let i = 0; i < k; i++) db.run("INSERT INTO receipts(id, source, ts, amount_cents) VALUES (?, 'uber', ?, 1500)", [`rc${i}`, NOW - i * 3600]);
  };
  test('"hello" with no goal → onboarding with counts from ingest_log and receipts', async () => {
    const db = freshDb();
    ingest(db, [["a", "chk"], ["b", "chk"], ["c", "amex"]]);
    receipts(db, 5);
    expect((await route(db, "hello", { now: NOW }, { fm: noFm })).text).toBe(
      "Hey! I'm your money sidekick. Everything stays on this Mac.\n" +
      "I've read 3 statements across 2 accounts and 5 ride/food receipts.\n" +
      'First: what are you saving for, and by when? e.g. "goal 10000 by june"');
  });
  test("clauses with a zero count are left out", () => {
    const db = freshDb();
    expect(onboardingText(db)).toBe('Hey! I\'m your money sidekick. Everything stays on this Mac.\nFirst: what are you saving for, and by when? e.g. "goal 10000 by june"');
    receipts(db, 1);
    expect(onboardingText(db).split("\n")[1]).toBe("I've read 1 ride/food receipt.");
    ingest(db, [["only", "chk"]]);
    expect(onboardingText(db).split("\n")[1]).toBe("I've read 1 statement across 1 account and 1 ride/food receipt.");
  });
  test("the first goal_set adds what happens next; a second one doesn't", async () => {
    const db = freshDb();
    const first = (await route(db, "goal 10000 by june", { now: NOW }, { fm: noFm })).text;
    expect(first).toEndWith('\nI\'ll nudge you on commute and dinner days when you drift off pace (text "stop nudges" anytime).\n' +
      'Teach me anything with "remember …", and text "privacy" to see what stays on your Mac.');
    expect(first).toStartWith("Goal set");
    const second = (await route(db, "goal 12000 by july", { now: NOW + 60 }, { fm: noFm })).text;
    expect(second).not.toContain("I'll nudge you");
  });
  test("a free-text first goal (fm says goal_set) gets the same next steps", async () => {
    const db = freshDb();
    const r = await route(db, "I want to save 10000 by june", { now: NOW }, { fm: { extract: async () => ({ intent: "goal_set" }), respond: async () => null } });
    expect(r.text).toContain("I'll nudge you on commute and dinner days");
  });
  test("a malformed first goal doesn't get the next steps (nothing was set)", async () => {
    const db = freshDb();
    const r = await route(db, "goal lots by someday", { now: NOW }, { fm: { extract: async () => ({ intent: "goal_set" }), respond: async () => null } });
    expect(r.text).not.toContain("I'll nudge you");
  });
  test("once a goal exists, hello is the usual greeting", async () => {
    const db = freshDb();
    withGoal(db);
    expect((await route(db, "hello", { now: NOW }, { fm: noFm })).text).toStartWith("Hey! I'm your money sidekick.\nI keep your finances on this Mac");
  });
});

test('privacy mentions "her charges" only when a shared account exists', async () => {
  const db = freshDb();
  db.run("DELETE FROM accounts WHERE shared = 1");
  const solo = (await route(db, "privacy", { now: NOW }, { fm: noFm })).text;
  expect(solo).not.toContain("Her charges");
  expect(solo).toContain('Text "ledger" for what was sent.');
  db.run("INSERT INTO accounts(id, name, type, subtype, shared, owner) VALUES ('amex2', 'Shared Amex', 'credit', 'credit card', 1, 'shared')");
  expect((await route(db, "privacy", { now: NOW }, { fm: noFm })).text).toContain("Her charges are only subtracted, never analysed or sent anywhere. Text \"ledger\" for what was sent.");
});

describe("balance statements are read locally (no model, no Luna)", () => {
  const live = [
    ["No, I’ve got 17k almost, cause the robinhood counts, 10k in the invested amount", "Robinhood", 1_000_000],
    ["I have like 10k in savings in Robinhood", "Robinhood", 1_000_000],
    ["I also have around 10k in my robinhood", "Robinhood", 1_000_000],
    ["I have $2,500 in my 401k", "401(k)", 250_000],
    ["there is about 3.5k sitting in fidelity", "Fidelity", 350_000],
  ] as const;
  for (const [text, name, cents] of live) {
    test(`"${text}" → ${name} ${cents / 100}`, async () => {
      const db = freshDb();
      withGoal(db);
      const before = (db.query("SELECT savings_at_creation_cents AS s FROM goals WHERE active = 1").get() as any).s;
      const h = fakeHandlers();
      const r = await route(db, text, { now: NOW }, { fm: noFm, loadHandler: h.loadHandler });
      expect(h.calls).toEqual([]);
      expect(r.tier).toBe("local");
      expect(r.text.split("\n")[0]).toMatch(new RegExp(`^Noted: about \\$[\\d.,k]+ in ${name.replace(/[()]/g, "\\$&")}, counted toward your goal\\.$`));
      expect(db.query("SELECT name, amount_cents FROM manual_assets").all()).toEqual([{ name, amount_cents: cents }]);
      expect((db.query("SELECT savings_at_creation_cents AS s FROM goals WHERE active = 1").get() as any).s).toBe(before + cents);
    });
  }
  test("the same account again replaces the amount (no double counting), and forget removes it", async () => {
    const db = freshDb();
    withGoal(db);
    const base = (db.query("SELECT savings_at_creation_cents AS s FROM goals WHERE active = 1").get() as any).s;
    await route(db, "I have like 10k in savings in Robinhood", { now: NOW }, { fm: noFm });
    const r = await route(db, "actually I've got 12k in robinhood now", { now: NOW + 60 }, { fm: noFm });
    expect(r.text.split("\n")[0]).toBe("Updated: about $12k in Robinhood, counted toward your goal.");
    expect(db.query("SELECT amount_cents FROM manual_assets").all()).toEqual([{ amount_cents: 1_200_000 }]);
    expect((db.query("SELECT savings_at_creation_cents AS s FROM goals WHERE active = 1").get() as any).s).toBe(base + 1_200_000);
    expect((await route(db, "forget 1", { now: NOW + 120 }, { fm: noFm })).text).toBe("Forgot: Robinhood: about $12k.");
    expect(db.query("SELECT COUNT(*) AS n FROM manual_assets").get()).toEqual({ n: 0 });
    expect((db.query("SELECT savings_at_creation_cents AS s FROM goals WHERE active = 1").get() as any).s).toBe(base);
  });
  test("questions, spending and goal statements are not balance statements", async () => {
    for (const t of ["how much is in my robinhood?", "I spent 10k at robinhood", "my saving goal is 40k by december and I have 10k in robinhood"])
      expect(parseAssetStatement(t)).toBeNull();
  });
});

describe("routing table without a local model (Luna fallback = keywords)", () => {
  const table: [string, string][] = [
    ["I want to save 40000 by December so I can quit my job", "goal_set"],
    ["So I wanna save 40k $ by end of 2026, so that basically I can quit my job.", "goal_set"],
    ["Alright, my saving goal is 40k in total cash by end of December. You can see my savings, my rent is 1.8k and I have like 10k in savings in Robinhood", "goal_set"],
    ["Can I buy a $400 jacket?", "afford"],
    ["how much did I spend on food last month", "spend_query"],
    ["am I on track", "goal_status"],
    ["What changed in my spending since August?", "other"],
  ];
  for (const [q, want] of table) test(`${want} ← ${q.slice(0, 50)}`, () => expect(overrideIntent(q, keywordIntent(q))).toBe(want));
});
