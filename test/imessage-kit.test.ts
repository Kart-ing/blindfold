import { describe, expect, test } from "bun:test";
import { KitTransport, maskHandle, selfCheck } from "../src/imessage/kit.ts";

const OWNER = "+1 (555) 123-4567";

function fakeSdk() {
  const sdk = {
    sends: [] as { to: string; text?: string }[],
    events: null as any,
    async startWatching(ev: any) { sdk.events = ev; },
    async stopWatching() {},
    async send(req: { to: string; text?: string }) { sdk.sends.push(req); },
    async close() {},
  };
  return sdk;
}

const msg = (over: Record<string, unknown>) =>
  ({ id: crypto.randomUUID(), participant: "5551234567", text: "ledger", isFromMe: false, chatKind: "dm", ...over });

describe("KitTransport", () => {
  test("refuses to start without OWNER_HANDLE", () => {
    expect(() => new KitTransport("", fakeSdk() as any)).toThrow(/OWNER_HANDLE/);
    expect(() => new KitTransport("   ", fakeSdk() as any)).toThrow(/OWNER_HANDLE/);
  });

  test("delivers only the owner's direct messages, once each", async () => {
    const sdk = fakeSdk();
    const t = new KitTransport(OWNER, sdk as any);
    const got: string[] = [];
    await t.start(async (text) => { got.push(text); });
    const ownerMsg = msg({ text: "hi" });
    sdk.events.onIncomingMessage(ownerMsg);
    sdk.events.onIncomingMessage(ownerMsg); // duplicate id
    sdk.events.onIncomingMessage(msg({ participant: "+15559999999", text: "stranger" }));
    sdk.events.onIncomingMessage(msg({ isFromMe: true, text: "echo" }));
    sdk.events.onIncomingMessage(msg({ chatKind: "group", text: "group" }));
    sdk.events.onIncomingMessage(msg({ participant: "+1 555 123 4567", text: "formatted" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["hi", "formatted"]);
  });

  test("always sends to the owner", async () => {
    const sdk = fakeSdk();
    const t = new KitTransport(OWNER, sdk as any);
    await t.send("one");
    await t.send("two");
    expect(sdk.sends).toEqual([{ to: OWNER, text: "one" }, { to: OWNER, text: "two" }]);
  });

  test("a failing handler doesn't stop later messages", async () => {
    const sdk = fakeSdk();
    const t = new KitTransport(OWNER, sdk as any);
    const got: string[] = [];
    await t.start(async (text) => { if (text === "boom") throw new Error("x"); got.push(text); });
    sdk.events.onIncomingMessage(msg({ text: "boom" }));
    sdk.events.onIncomingMessage(msg({ text: "after" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["after"]);
  });

  test("retries a failed send once, then gives up", async () => {
    const sdk = fakeSdk();
    let fails = 1;
    sdk.send = async (req: any) => { if (fails-- > 0) throw new Error("osascript"); sdk.sends.push(req); };
    const t = new KitTransport(OWNER, sdk as any, { retryMs: 1 });
    await t.send("hi");
    expect(sdk.sends).toEqual([{ to: OWNER, text: "hi" }]);
    fails = 2;
    await expect(t.send("again")).rejects.toThrow("osascript");
  });

  test("dry run prints instead of sending", async () => {
    const sdk = fakeSdk();
    const t = new KitTransport(OWNER, sdk as any, { dry: true });
    await t.send("would go out");
    expect(sdk.sends).toEqual([]);
  });

  test("keeps retrying when chat.db can't be watched, without throwing", async () => {
    const sdk = fakeSdk();
    let fails = 2;
    const real = sdk.startWatching;
    sdk.startWatching = async (ev: any) => { if (fails-- > 0) throw new Error("authorization denied"); return real(ev); };
    const t = new KitTransport(OWNER, sdk as any, { retryMs: 1 });
    await t.start(async () => {});
    expect(sdk.events).not.toBeNull();
  });

  test("stop() ends the retry loop", async () => {
    const sdk = fakeSdk();
    sdk.startWatching = async () => { throw new Error("authorization denied"); };
    const t = new KitTransport(OWNER, sdk as any, { retryMs: 5 });
    const started = t.start(async () => {});
    await t.stop();
    await started; // resolves instead of looping forever
  });
});

test("maskHandle and selfCheck never print the full handle", () => {
  expect(maskHandle("+1 (555) 123-4567")).toBe("•••4567");
  expect(maskHandle("kart@example.com")).toBe("k•••@example.com");
  expect(maskHandle("")).toBe("(not set)");
  const c = selfCheck("+15551234567");
  expect(c.lines.join("\n")).not.toContain("5551234567");
  expect(c.lines[0]).toBe("OWNER_HANDLE: •••4567");
  expect(selfCheck("").ok).toBe(false);
});

test("a handler waiting for the NEXT message (consent) doesn't deadlock the transport", async () => {
  const sdk = fakeSdk();
  const t = new KitTransport(OWNER, sdk as any);
  let answer!: (v: string) => void;
  const answered = new Promise<string>((r) => { answer = r; });
  const done: string[] = [];
  await t.start(async (text) => {
    if (text === "runway?") done.push(`question got ${await answered}`); // blocks until the next message arrives
    else { answer(text); done.push(`answer ${text}`); }
  });
  sdk.events.onIncomingMessage(msg({ text: "runway?" }));
  sdk.events.onIncomingMessage(msg({ text: "1" }));
  await new Promise((r) => setTimeout(r, 30));
  expect(done).toEqual(["answer 1", "question got 1"]);
});
