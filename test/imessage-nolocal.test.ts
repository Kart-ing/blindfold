// "No local models" is literally true: with LOCAL_MODELS unset, nothing in a full route() run or a nudge tick can
// spawn bin/fm, even when the real fm object is passed in. A positive control shows the test would catch a spawn.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { fromLocal } from "../src/imessage/clock.ts";
import { fm } from "../src/imessage/fm.ts";
import { setConverse } from "../src/imessage/luna.ts";
import { route } from "../src/imessage/router.ts";
import { runScheduler } from "../src/nudges/scheduler.ts";
import { phrase } from "../src/voice/phrase.ts";

// These tests drive the Luna path; the reason path (calc/execute.ts) is tested in test/calc-execute.test.ts.
process.env.BRAIN = "luna";

const dir = mkdtempSync(join(tmpdir(), "fin-nofm-"));
const marker = join(dir, "spawned");
const fake = join(dir, "fm");
writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
chmodSync(fake, 0o755);
const env = { FM_BIN: process.env.FM_BIN, LOCAL_MODELS: process.env.LOCAL_MODELS, VOICE: process.env.VOICE };
process.env.FM_BIN = fake;
delete process.env.LOCAL_MODELS;
afterAll(() => {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  setConverse(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const NOW = fromLocal(2026, 10, 22, 17, 30);

test("a full set of messages and a nudge tick never spawn bin/fm, even with the real fm passed in", async () => {
  const db = openDb(join(dir, "fin.db"));
  setConverse(null); // Luna unavailable → the keyword fallback, where fm used to run
  for (const voice of ["cloud", "device", "plain"]) {
    process.env.VOICE = voice;
    for (const t of ["hello", "Can I buy a $400 jacket?", "how much did I spend on food", "What changed since August?", "goal 40000 by december",
      "I have like 10k in savings in Robinhood", "remember my rent is 1800", "hmm what about that coat", "ledger"])
      await route(db, t, { now: NOW }, { fm });
    await runScheduler(db, NOW, { send: async () => {}, fm });
    await phrase("afford", "verdict tight", { PRICE: "$400" }, "Tight. {PRICE}.", { fm });
  }
  expect(existsSync(marker)).toBe(false);
});

test("positive control: with LOCAL_MODELS=on and VOICE=device, phrase does spawn it", async () => {
  process.env.LOCAL_MODELS = "on";
  process.env.VOICE = "device";
  process.env.NODE_ENV = "production"; // phrase stays plain under test unless an fm is passed; pass the real one
  try {
    await phrase("afford", "verdict tight", { PRICE: "$400" }, "Tight. {PRICE}.", { fm });
  } finally {
    process.env.NODE_ENV = "test";
    delete process.env.LOCAL_MODELS;
  }
  expect(existsSync(marker)).toBe(true);
});
