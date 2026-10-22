// "No local models" covers the importer too (synthetic inputs only). Unless LOCAL_MODELS=on, categorizeAll and
// classifyMailbox never spawn bin/fm, even when asked to (useFm: true): rules, regexes and earlier cached answers still
// apply. A positive control shows the marker would catch a spawn.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { categorizeAll } from "../src/ingest/categorize";
import { classifyMailbox } from "../src/ingest/real";

const dir = mkdtempSync(join(tmpdir(), "ingest-nolocal-"));
const marker = join(dir, "spawned");
const fake = join(dir, "fm");
writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
chmodSync(fake, 0o755);
const env = { FM_BIN: process.env.FM_BIN, LOCAL_MODELS: process.env.LOCAL_MODELS };
process.env.FM_BIN = fake;
delete process.env.LOCAL_MODELS;
afterAll(() => { for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v); });

/** A mailbox with one email that neither the subject pass nor the regexes can place. */
const mailbox = () => {
  const root = mkdtempSync(join(dir, "mail-"));
  mkdirSync(join(root, "acct"));
  writeFileSync(join(root, "acct", "1.eml"), "From: A Friend <friend@example.com>\r\nSubject: Hello there\r\nDate: Thu, 15 Oct 2026 16:20:00 +0000\r\n"
    + "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nJust saying hi.");
  return root;
};

test("the importer never spawns bin/fm unless LOCAL_MODELS=on: rules, regexes and the cache only", async () => {
  const cache = join(dir, "cats.json");
  writeFileSync(cache, JSON.stringify({ "SAMPLE CACHED SHOP": "ENTERTAINMENT" }));
  const lines = [{ desc: "ZZZ UNKNOWN THING", outflow: true, hint: null }, { desc: "SAMPLE CACHED SHOP", outflow: true, hint: null }];
  for (const opts of [{}, { useFm: true }]) {
    const [a, b] = await categorizeAll(lines, cache, opts);
    expect([a.category, a.via, b.category, b.via]).toEqual([null, "none", "ENTERTAINMENT", "fm"]);
    const root = mailbox();
    const r = await classifyMailbox(root, opts);
    expect([r.errors, r.mails.map((m) => [m.kind, m.via])]).toEqual([0, [["other", "unclassified"]]]);
    expect(existsSync(join(root, ".classified.json"))).toBe(false); // a run without the model doesn't freeze its guesses
  }
  expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({ "SAMPLE CACHED SHOP": "ENTERTAINMENT" });
  expect(existsSync(marker)).toBe(false);
});

test("positive control: with LOCAL_MODELS=on the importer does spawn it", async () => {
  process.env.LOCAL_MODELS = "on";
  try {
    await categorizeAll([{ desc: "ZZZ OTHER UNKNOWN", outflow: true, hint: null }], join(dir, "cats2.json"));
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    await classifyMailbox(mailbox());
    expect(existsSync(marker)).toBe(true);
  } finally { delete process.env.LOCAL_MODELS; }
});
