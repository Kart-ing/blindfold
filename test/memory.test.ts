import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { attribute } from "../src/attribution/engine.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { noFm } from "../src/imessage/fm.ts";
import { merchantLookup } from "../src/imessage/lookup.ts";
import { maybePrompt } from "../src/imessage/prompts.ts";
import { route } from "../src/imessage/router.ts";
import { parseMemoryCommand } from "../src/memory/commands.ts";
import { PREF_RULE, reapplyPreferences } from "../src/memory/prefs.ts";
import { attributeAll } from "../src/attribution/engine.ts";
import { listMemories } from "../src/memory/store.ts";

const NOW = fromLocal(2026, 10, 22, 14, 0);
const paths: string[] = [];
afterAll(() => { for (const p of paths) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });
let n = 0;
function freshDb(): Database {
  const p = join(tmpdir(), `fin-mem-${process.pid}-${Date.now()}-${n++}.db`);
  paths.push(p);
  const db = openDb(p);
  db.run(`INSERT INTO accounts(id, name, type, subtype, shared, owner) VALUES
    ('amex', 'Shared Amex', 'credit', 'credit card', 1, 'shared'), ('chk', 'Checking', 'depository', 'checking', 0, 'me')`);
  return db;
}
let t = 0;
function txn(db: Database, merchant: string, cents: number, acct = "amex", ts = fromLocal(2026, 10, 10 + (t % 9), 20, 0)) {
  const id = `t${t++}`;
  db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant, category) VALUES (?, ?, ?, ?, ?, 'GENERAL_MERCHANDISE')", [id, acct, ts, cents, merchant]);
  attribute(db, id); // the engine's own rules, as after ingest
  return id;
}
const say = (db: Database, text: string, now = NOW) => route(db, text, { now }, { fm: noFm, loadHandler: async () => null }).then((r) => r.text);
const attr = (db: Database, id: string) => db.query("SELECT owner, rule, labelled_by_user, needs_prompt FROM attributions WHERE txn_id = ?").get(id) as any;

describe("remember / memories / forget", () => {
  test("save, list newest first, forget by number", async () => {
    const db = freshDb();
    expect(await say(db, "memories")).toBe("Nothing yet. Text 'remember …' to teach me.");
    expect(await say(db, "remember my rent is due on the 1st")).toBe('Saved. Text "memories" to see everything I remember.');
    expect(await say(db, "Remember that I'm saving for a trip to Japan", NOW + 60)).toBe('Saved. Text "memories" to see everything I remember.');
    expect(await say(db, "memories")).toBe("What I remember:\n1. I'm saving for a trip to Japan\n2. my rent is due on the 1st\n\nText \"forget 2\" to delete one.");
    expect(await say(db, "forget 1")).toBe("Forgot: I'm saving for a trip to Japan.");
    expect(await say(db, "memories")).toBe("What I remember:\n1. my rent is due on the 1st\n\nText \"forget 1\" to delete one.");
    expect(listMemories(db).map((m) => m.text)).toEqual(["my rent is due on the 1st"]);
    expect(await say(db, "forget 9")).toBe('There\'s no memory #9. Text "memories" to see the list.');
  });
  test("more than 10: shows 10, then +N more", async () => {
    const db = freshDb();
    for (let i = 0; i < 13; i++) await say(db, `remember note ${String.fromCharCode(97 + i)}`, NOW + i);
    const list = await say(db, "memories");
    expect(list.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(list).toContain("+3 more");
  });
  test("memory commands stay local: no handler, no planner, tier local", async () => {
    const db = freshDb();
    let called = false;
    const r = await route(db, "remember my landlord is Priya", { now: NOW }, { fm: noFm, loadHandler: async () => { called = true; return null; } });
    expect(called).toBe(false);
    expect(r.tier).toBe("local");
    const row = db.query("SELECT tier, intent, payload_json FROM ledger").get() as any;
    expect(row).toEqual({ tier: "local", intent: "command", payload_json: null });
  });
});

describe("forget everything (1 yes · 2 no)", () => {
  test("2 keeps them, 1 clears them", async () => {
    const db = freshDb();
    await say(db, "remember a"); await say(db, "remember b", NOW + 1);
    expect(await say(db, "forget everything")).toBe("Forget all 2 things I remember? 1 yes · 2 no");
    expect(await say(db, "2")).toBe("OK, keeping them.");
    expect(listMemories(db)).toHaveLength(2);
    await say(db, "forget everything");
    expect(await say(db, "1")).toBe("Done, I've forgotten everything (2 memories).");
    expect(listMemories(db)).toEqual([]);
    expect(await say(db, "forget everything")).toBe("Nothing to forget.");
  });
  test("its 1/2 comes before a pending who-paid question; it expires after 5 minutes", async () => {
    const db = freshDb();
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES ('flag', 'amex', ?, 9900, 'Target')", [NOW - 3600]);
    db.run("INSERT INTO attributions(txn_id, owner, rule, confidence, needs_prompt) VALUES ('flag', 'me', 7, 0.4, 1)");
    await maybePrompt(db, NOW, async () => {});
    await say(db, "remember a");
    await say(db, "forget everything");
    expect(await say(db, "1")).toBe("Done, I've forgotten everything (1 memory).");
    expect((db.query("SELECT answered FROM prompts").get() as any).answered).toBeNull(); // the who-paid question is untouched
    await say(db, "remember b");
    await say(db, "forget everything");
    expect(await say(db, "1", NOW + 6 * 60)).toBe("Got it: yours."); // expired → the 1 answers the who-paid question
    expect(listMemories(db)).toHaveLength(1);
  });
});

describe('"<merchant> is always mine|hers|split"', () => {
  const setup = () => {
    const db = freshDb();
    const shared = [txn(db, "Sephora", 4000), txn(db, "Sephora", 2500), txn(db, "Sephora", 6100), txn(db, "Sephora", 1800)];
    const labelled = txn(db, "Sephora", 3000);
    db.run("UPDATE attributions SET owner = 'me', rule = 1, labelled_by_user = 1 WHERE txn_id = ?", [labelled]);
    const personal = txn(db, "Sephora", 2200, "chk");
    const refund = txn(db, "Sephora", -4000);
    const before = Object.fromEntries([...shared, labelled, personal, refund].map((id) => [id, attr(db, id)]));
    return { db, shared, labelled, personal, refund, before };
  };

  test("relabels the shared-card charges, reports the count, leaves labels, personal cards and refunds alone", async () => {
    const { db, shared, labelled, personal, refund, before } = setup();
    expect(await say(db, "Sephora is always hers")).toBe("Got it, Sephora is always hers. 4 charges moved to her side.");
    for (const id of shared) expect(attr(db, id)).toMatchObject({ owner: "her", rule: PREF_RULE, labelled_by_user: 0, needs_prompt: 0 });
    for (const id of [labelled, personal, refund]) expect(attr(db, id)).toEqual(before[id]);
    expect(listMemories(db)[0]).toMatchObject({ kind: "owner_pref", merchant: "Sephora", owner: "her", text: "Sephora is always hers" });
  });
  test("forget reverts exactly those charges to the engine's rules", async () => {
    const { db, shared, labelled, before } = setup();
    await say(db, "Sephora is always hers");
    expect(await say(db, "forget 1")).toBe("Forgot: Sephora is always hers. 4 charges back on the usual rules.");
    for (const id of [...shared, labelled]) expect(attr(db, id)).toEqual(before[id]);
  });
  test("a charge relabelled by hand after the preference keeps its label through forget", async () => {
    const { db, shared } = setup();
    await say(db, "Sephora is always hers");
    db.run("UPDATE attributions SET owner = 'me', rule = 1, labelled_by_user = 1 WHERE txn_id = ?", [shared[0]]);
    expect(await say(db, "forget 1")).toBe("Forgot: Sephora is always hers. 3 charges back on the usual rules.");
    expect(attr(db, shared[0])).toMatchObject({ owner: "me", rule: 1, labelled_by_user: 1 });
  });
  test("forget everything reverts preferences too", async () => {
    const { db, shared, before } = setup();
    await say(db, "Sephora is always hers");
    await say(db, "forget everything");
    expect(await say(db, "1")).toBe("Done, I've forgotten everything (1 memory). 4 charges back on the usual rules.");
    for (const id of shared) expect(attr(db, id)).toEqual(before[id]);
  });
  test("a full engine re-run (ingest) keeps rule 8, including new charges", async () => {
    const { db, shared } = setup();
    await say(db, "Sephora is always hers");
    const late = txn(db, "Sephora", 999);
    attributeAll(db);
    for (const id of [...shared, late]) expect(attr(db, id)).toMatchObject({ owner: "her", rule: PREF_RULE });
    expect(await say(db, "forget 1")).toBe("Forgot: Sephora is always hers. 5 charges back on the usual rules.");
  });
  test("her-only stays respected: a merchant moved fully to her side reads as hers", async () => {
    const db = freshDb();
    for (const c of [1200, 3400]) txn(db, "Glossier", c);
    await say(db, "glossier is always hers");
    expect(merchantLookup(db, "what is Glossier?")).toBe("Glossier is on her side of the card, so I keep it out of your numbers.");
  });
  test("wordings: split, mine, remember-prefixed, unknown merchant, already there", async () => {
    const db = freshDb();
    txn(db, "Uber", 4200); txn(db, "Uber", 1900);
    expect(await say(db, "always split Uber")).toBe("Got it, Uber is always split. 2 charges now split 50/50.");
    expect(await say(db, "remember that uber's always mine")).toBe("Got it, Uber is always mine. 2 charges moved to your side.");
    expect(await say(db, "Uber is always mine")).toBe("Got it, Uber is always mine. Its charges were already yours.");
    expect(await say(db, "Zara is always hers")).toBe("Got it, Zara is always hers. No charges there yet; I'll keep it in mind.");
    expect(parseMemoryCommand("what is an Uber?")).toBeNull();
    expect(parseMemoryCommand("that was hers")).toBeNull();
  });
  test("with a who-paid question pending, a preference is still a preference (not a re-ask)", async () => {
    const { db } = setup();
    db.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES ('flag', 'amex', ?, 9900, 'Target')", [NOW - 3600]);
    db.run("INSERT INTO attributions(txn_id, owner, rule, confidence, needs_prompt) VALUES ('flag', 'me', 7, 0.4, 1)");
    await maybePrompt(db, NOW, async () => {});
    expect(await say(db, "Sephora is always hers")).toStartWith("Got it, Sephora is always hers.");
  });
});

describe("privacy and rules mention memory", () => {
  test("privacy shows Cloud memory: off by default", async () => {
    const prev = process.env.CLOUD_MEMORY;
    delete process.env.CLOUD_MEMORY;
    try {
      expect(await say(freshDb(), "privacy")).toContain('Cloud memory: off. Your memories never leave this Mac. Text "memories" to see what I remember.');
    } finally { if (prev !== undefined) process.env.CLOUD_MEMORY = prev; }
  });
  test("rules lists the standing preference as rule 8", async () => {
    expect(await say(freshDb(), "rules")).toContain('8. your standing preference ("Sephora is always hers"); never overrides 1');
  });
});
