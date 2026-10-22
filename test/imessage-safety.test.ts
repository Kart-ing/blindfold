import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { lunaHistory, resetLuna, setConverse } from "../src/imessage/luna.ts";
import { route } from "../src/imessage/router.ts";
import { mentionsSelfHarm, SAFETY_REPLY } from "../src/imessage/safety.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

const NOW = fromLocal(2026, 10, 22, 14, 50);
const p = join(tmpdir(), `fin-safety-${process.pid}-${Date.now()}.db`);
afterAll(() => { setConverse(undefined); resetLuna(); for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

test.each([
  "wow that’s sad. chat should i kill myself?", "I want to kill myself", "kms", "thinking about suicide", "feeling suicidal",
  "I just want to end it all", "i wanna die", "I might hurt myself", "self-harm", "should I unalive",
  "just kill me", "I want to disappear", "honestly no point living", "there's no point in living", "no reason to live",
])("matches %p", (t) => expect(mentionsSelfHarm(t)).toBe(true));

test.each(["kill the subscription", "this budget is killing me", "these fees are killing me", "make the charge disappear", "the battery died", "can I afford a skill course?", "I'm dying to buy this jacket"])
  ("doesn't match %p", (t) => expect(mentionsSelfHarm(t)).toBe(false));

test("the live message gets the local caring reply: no handler, no Luna, no cloud, no history", async () => {
  const db = openDb(p);
  let calls = 0;
  setConverse({ understand: async () => { calls++; return null; } } as any);
  const prev = process.env.VOICE;
  process.env.VOICE = "cloud";
  try {
    let handlerCalled = false;
    const r = await route(db, "wow that’s sad. chat should i kill myself?", { now: NOW }, { loadHandler: async () => { handlerCalled = true; return null; } });
    expect(r).toEqual({ text: SAFETY_REPLY, tier: "local" });
    expect(r.text).toContain("988");
    expect(calls).toBe(0);
    expect(handlerCalled).toBe(false);
    expect(lunaHistory()).toEqual([]);
    expect(db.query("SELECT tier, intent, payload_json FROM ledger").all()).toEqual([{ tier: "local", intent: "command", payload_json: null }]);
  } finally {
    if (prev === undefined) delete process.env.VOICE; else process.env.VOICE = prev;
  }
});
