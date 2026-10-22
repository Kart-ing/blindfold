// The demo script (PRD §10) end to end on a freshly seeded fixture DB, through the same agent the CLI and iMessage use.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_NOW, rebuild } from "../src/ingest/seed.ts";
import { noFm } from "../src/imessage/fm.ts";
import { MemoryTransport } from "../src/imessage/transport.ts";
import { makeAgent } from "../src/main.ts";

const path = join(tmpdir(), `fin-e2e-${process.pid}-${Date.now()}.db`);
const { db } = rebuild(path);
afterAll(() => {
  db.close();
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
});

test("demo order: afford → tick → who-paid → ledger", async () => {
  const t = new MemoryTransport();
  const agent = makeAgent(db, t, { fm: noFm, now: () => DEMO_NOW });
  await t.start(agent.onText);
  const said = () => t.sent.splice(0);

  // Nothing is sent until the user speaks or a tick fires.
  expect(t.sent).toEqual([]);

  // U1: can I buy this?
  await t.receive("Can I buy a $400 jacket?");
  const [afford, prompt] = said();
  expect(afford).toStartWith("Tight, but doable.");
  expect(afford).toContain("$400");
  // The who-paid question piggybacks on the answer.
  expect(prompt).toMatch(/^Quick one: was that \$[\d.]+ .+ yours\? 1 me · 2 her · 3 split$/);

  // U2: 5:30pm tick fires the dinner nudge against the seeded goal (about $155 behind).
  const tick = (await agent.tick("17:30")) as { fired: { kind: string; text: string }[] };
  expect(tick.fired.map((f) => f.kind)).toContain("dinner_delivery");
  const dinner = said().find((s) => s.startsWith("Skip "))!;
  expect(dinner).toMatch(/^Skip (Uber Eats|DoorDash) tonight\? Goal is \$[\d,]+ behind pace\.\nA delivery dinner runs you about \$\d+\. Cook or grab pickup and it goes toward the goal\.$/);
  expect(Number(dinner.match(/\$(\d+)/)![1])).toBeGreaterThanOrEqual(25);

  // U3: answer the pending who-paid question with 2 (hers); the panel reads attributions.
  const pending = db.query("SELECT ref FROM prompts WHERE kind = 'who_paid' AND answered IS NULL").get() as { ref: string };
  expect(pending).not.toBeNull();
  await t.receive("2");
  expect(said()[0]).toStartWith("Got it: hers");
  expect(db.query("SELECT owner, rule, labelled_by_user, needs_prompt FROM attributions WHERE txn_id = ?").get(pending.ref))
    .toEqual({ owner: "her", rule: 1, labelled_by_user: 1, needs_prompt: 0 });

  // Close: ledger, nothing exact left the Mac.
  await t.receive("ledger");
  const ledger = said()[0];
  expect(ledger).toContain("0 exact values sent");
  expect(ledger).toMatch(/^1 question, 1 never left your Mac/);

  // Exactly one ledger row per answer: jacket, "2", "ledger".
  expect((db.query("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n).toBe(3);
});

test("demo ticks are separate beats: 08:30 commute, 17:30 dinner, 13:00 recurring (one each)", async () => {
  const p2 = join(tmpdir(), `fin-e2e-ticks-${process.pid}-${Date.now()}.db`);
  const { db: d } = rebuild(p2);
  try {
    const t = new MemoryTransport();
    const agent = makeAgent(d, t, { fm: noFm, now: () => DEMO_NOW });
    await t.start(agent.onText);
    const kinds = async (at: string) => ((await agent.tick(at)) as { fired: { kind: string }[] }).fired.map((f) => f.kind);
    expect(await kinds("08:30")).toEqual(["commute_rides"]);
    expect(await kinds("17:30")).toEqual(["dinner_delivery"]);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]).toMatch(/^\$[\d,]+ on office-commute Ubers this month \(\d+ rides?\)\.\nTrain 3 days instead and you'd keep about \$[\d,]+ \(at \$2\.50 a ride\)\.$/);
    expect(t.sent[1]).toMatch(/^Skip .+ tonight\? Goal is \$[\d,]+ behind pace\.\nA delivery dinner runs you about \$\d+\./);
    // Recurring fires on its own midday beat (on a fresh day, since the 2-a-day cap is spent).
    const fresh = rebuild(p2).db;
    const a2 = makeAgent(fresh, t, { fm: noFm, now: () => DEMO_NOW });
    const r = (await a2.tick("13:00")) as { fired: { kind: string }[] };
    expect(r.fired).toEqual([{ kind: "new_recurring", text: "New recurring charge: Headspace $14.99/mo.\nThat's about $180 a year. Keep it?" }]);
    fresh.close();
  } finally {
    d.close();
    for (const f of [p2, `${p2}-wal`, `${p2}-shm`]) rmSync(f, { force: true });
  }
});

test("who-paid questions ride only on real answers: never on greetings, thanks, or another answer", async () => {
  const p3 = join(tmpdir(), `fin-e2e-piggy-${process.pid}-${Date.now()}.db`);
  const { db: d } = rebuild(p3);
  process.env.VOICE = "plain";
  try {
    const t = new MemoryTransport();
    const agent = makeAgent(d, t, { fm: noFm, now: () => DEMO_NOW });
    await t.start(agent.onText);
    const said = () => t.sent.splice(0);
    await t.receive("Hello");
    expect(said()).toHaveLength(1); // the greeting only, no question
    await t.receive("Can I buy a $400 jacket?");
    const [answer, q] = said();
    expect(answer).toStartWith("Tight, but doable.");
    expect(q).toStartWith("Quick one: was that ");
    await t.receive("2");
    expect(said()).toEqual(["Got it: hers. It won't count toward your spending."]); // no chained question
    await t.receive("thanks");
    expect(said()).toEqual(["Anytime 🙌"]);
    await t.receive("what is an Uber?");
    const [lookup, next] = said();
    expect(lookup).toMatch(/^Uber is one you've paid \d+ times? since \w+, ~\$[\d,]+ total \(your share\)\.$/);
    expect(next).toStartWith("Quick one: was that "); // a real answer: the next question may ride along
    await t.receive("1");
    said();
    // A cloud answer ends clean: no question rides along (the canary beat).
    await t.receive("What changed in my spending since August?");
    const cloud = said();
    expect(cloud).toHaveLength(1);
    expect(cloud[0]).not.toContain("Quick one");
  } finally {
    d.close();
    for (const f of [p3, `${p3}-wal`, `${p3}-shm`]) rmSync(f, { force: true });
  }
});
