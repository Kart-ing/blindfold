import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { fromLocal } from "../src/imessage/clock";
import { askConsent, consentPending, resetConsent, setConsentSender, takeConsentAnswer } from "../src/imessage/consent";
import type { Transport } from "../src/imessage/transport";
import { makeAgent } from "../src/main";

const NOW = fromLocal(2026, 10, 22, 14, 0);
const ctx = { now: NOW };
const Q = "Send your goal numbers to the cloud planner?";
const ASK = `${Q} 1=once 2=always 3=no`;

const paths: string[] = [];
let seq = 0;
function freshDb(): Database {
  const p = join(tmpdir(), `fin-consent-${process.pid}-${Date.now()}-${seq++}.db`);
  paths.push(p);
  return openDb(p);
}
const savedTimeout = process.env.CONSENT_TIMEOUT_MS;
afterEach(() => {
  resetConsent();
  if (savedTimeout === undefined) delete process.env.CONSENT_TIMEOUT_MS; else process.env.CONSENT_TIMEOUT_MS = savedTimeout;
  for (const p of paths.splice(0)) for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
});

function fakeSender() {
  const sent: string[] = [];
  const send = async (t: string) => { sent.push(t); };
  setConsentSender(send);
  return sent;
}
const consents = (db: Database) => db.query("SELECT scope, grant_kind FROM consents").all() as any[];
const consentPrompts = (db: Database) => db.query("SELECT * FROM prompts WHERE kind = 'consent' ORDER BY id").all() as any[];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("askConsent", () => {
  test("stored 'always' returns without sending", async () => {
    const db = freshDb();
    db.run("INSERT INTO consents(scope, grant_kind, ts) VALUES ('cloud_plan', 'always', 1)");
    const sent = fakeSender();
    expect(await askConsent(db, "cloud_plan", Q, ctx)).toBe("always");
    expect(sent).toEqual([]);
    expect(consentPending()).toBe(false);
    expect(consentPrompts(db)).toEqual([]);
  });

  test("sends the question; 2 → always and stores consent", async () => {
    const db = freshDb();
    const sent = fakeSender();
    const p = askConsent(db, "cloud_plan", Q, ctx);
    await tick();
    expect(sent).toEqual([ASK]);
    expect(consentPending()).toBe(true);
    expect(consentPrompts(db)[0]).toMatchObject({ ref: "cloud_plan", text: ASK, sent_ts: NOW, answered: null });
    expect(takeConsentAnswer("2")).toBe('OK. cloud_plan is allowed from now on. Text "revoke cloud_plan" to undo.');
    expect(await p).toBe("always");
    expect(consentPending()).toBe(false);
    expect(consents(db)).toEqual([{ scope: "cloud_plan", grant_kind: "always" }]);
    expect(consentPrompts(db)[0]).toMatchObject({ answered: "always", answered_ts: NOW });
    // Next ask is silent.
    expect(await askConsent(db, "cloud_plan", Q, ctx)).toBe("always");
    expect(sent).toHaveLength(1);
  });

  test("1 → once, no consents row", async () => {
    const db = freshDb();
    fakeSender();
    const p = askConsent(db, "cloud_plan", Q, ctx);
    expect(takeConsentAnswer("1.")).toBe("OK, just this once.");
    expect(await p).toBe("once");
    expect(consents(db)).toEqual([]);
    expect(consentPrompts(db)[0].answered).toBe("once");
  });

  test("3 → deny", async () => {
    const db = freshDb();
    fakeSender();
    const p = askConsent(db, "cloud_plan", Q, ctx);
    expect(takeConsentAnswer(" 3 ")).toBe("OK, not sending that.");
    expect(await p).toBe("deny");
    expect(consents(db)).toEqual([]);
    expect(consentPrompts(db)[0].answered).toBe("deny");
  });

  test("answer-like text re-asks and stays pending; unrelated text → null", async () => {
    const db = freshDb();
    fakeSender();
    const p = askConsent(db, "cloud_plan", Q, ctx);
    expect(takeConsentAnswer("me")).toBe(`No stress. ${ASK}`);
    expect(takeConsentAnswer("4")).toBe(`No stress. ${ASK}`);
    expect(consentPending()).toBe(true);
    expect(takeConsentAnswer("how much did I spend on food?")).toBeNull();
    expect(consentPending()).toBe(true);
    takeConsentAnswer("3");
    expect(await p).toBe("deny");
    expect(takeConsentAnswer("1")).toBeNull(); // nothing pending any more
  });

  test("timeout → deny, prompt answered='timeout'", async () => {
    process.env.CONSENT_TIMEOUT_MS = "50";
    const db = freshDb();
    fakeSender();
    const t0 = Date.now();
    expect(await askConsent(db, "cloud_plan", Q, ctx)).toBe("deny");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(consentPending()).toBe(false);
    expect(consentPrompts(db)[0].answered).toBe("timeout");
    expect(takeConsentAnswer("2")).toBeNull();
    expect(consents(db)).toEqual([]);
  });

  test("no sender → deny, nothing pending", async () => {
    const db = freshDb();
    expect(await askConsent(db, "cloud_plan", Q, ctx)).toBe("deny");
    expect(consentPending()).toBe(false);
    expect(consentPrompts(db)).toEqual([]);
  });

  test("send failure → deny, answered='send_failed'", async () => {
    const db = freshDb();
    setConsentSender(async () => { throw new Error("offline"); });
    expect(await askConsent(db, "cloud_plan", Q, ctx)).toBe("deny");
    expect(consentPending()).toBe(false);
    expect(consentPrompts(db)[0].answered).toBe("send_failed");
  });

  test("second concurrent ask → deny; first still answerable", async () => {
    const db = freshDb();
    const sent = fakeSender();
    const p1 = askConsent(db, "cloud_plan", Q, ctx);
    expect(await askConsent(db, "cloud_search", "Other?", ctx)).toBe("deny");
    expect(sent).toEqual([ASK]);
    expect(consentPrompts(db)).toHaveLength(1);
    takeConsentAnswer("1");
    expect(await p1).toBe("once");
  });
});

describe("consent via makeAgent", () => {
  /** A transport whose first send blocks until released, holding the agent's lane. */
  class GatedTransport implements Transport {
    sent: string[] = [];
    release!: () => void;
    private gate: Promise<void> | null = new Promise((r) => { this.release = r; });
    async start() {}
    async stop() {}
    async send(t: string) {
      this.sent.push(t);
      const g = this.gate;
      this.gate = null;
      if (g) await g;
    }
  }

  test("a consent answer is handled while the lane is busy", async () => {
    const db = freshDb();
    const transport = new GatedTransport();
    const agent = makeAgent(db, transport, { now: () => NOW });
    setConsentSender((t) => transport.send(t));

    let firstDone = false;
    const first = agent.onText("stop nudges").then(() => { firstDone = true; }); // its reply send blocks the lane
    await tick();
    expect(transport.sent).toEqual(['Nudges stopped. Text "nudges on" to restart.']);

    const grant = askConsent(db, "cloud_plan", Q, ctx);
    await tick();
    expect(transport.sent[1]).toBe(ASK);

    await agent.onText("2"); // must not wait behind the blocked lane
    expect(await grant).toBe("always");
    expect(transport.sent[2]).toBe('OK. cloud_plan is allowed from now on. Text "revoke cloud_plan" to undo.');
    expect(firstDone).toBe(false);
    expect(consents(db)).toEqual([{ scope: "cloud_plan", grant_kind: "always" }]);
    const ledger = db.query("SELECT intent, tier, ts FROM ledger ORDER BY id").all() as any[];
    expect(ledger.at(-1)).toEqual({ intent: "command", tier: "local", ts: NOW });

    transport.release();
    await first;
    expect(firstDone).toBe(true);
  });

  test("non-answer text while consent is pending routes normally", async () => {
    const db = freshDb();
    const transport = new GatedTransport();
    transport.release();
    const agent = makeAgent(db, transport, { now: () => NOW });
    setConsentSender((t) => transport.send(t));
    const grant = askConsent(db, "cloud_plan", Q, ctx);
    await tick();
    await agent.onText("stop nudges");
    expect(transport.sent.at(-1)).toBe('Nudges stopped. Text "nudges on" to restart.');
    expect(consentPending()).toBe(true);
    await agent.onText("3");
    expect(await grant).toBe("deny");
  });
});
