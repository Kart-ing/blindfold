import { expect, test } from "bun:test";
import { StageTransport, stageBlock } from "../src/imessage/stage.ts";
import { MemoryTransport } from "../src/imessage/transport.ts";

test("stage mirrors inbound and outbound, delivery unchanged", async () => {
  const inner = new MemoryTransport();
  const shown: string[] = [];
  const t = new StageTransport(inner, (s) => shown.push(s));
  const got: string[] = [];
  await t.start(async (text) => { got.push(text); await t.send(`re: ${text}`); });
  await inner.receive("Can I buy a $400 jacket?");
  expect(got).toEqual(["Can I buy a $400 jacket?"]);
  expect(inner.sent).toEqual(["re: Can I buy a $400 jacket?"]);
  expect(shown).toHaveLength(2);
  expect(shown[0]).toContain("YOU");
  expect(shown[0]).toContain("Can I buy a $400 jacket?");
  expect(shown[1]).toContain("AGENT");
});

test("long and multi-line messages wrap inside the box", () => {
  const b = stageBlock("AGENT", `${"word ".repeat(40)}\nsecond line`, 40);
  const lines = b.split("\n").filter((l) => l.startsWith("┃"));
  expect(lines.length).toBeGreaterThan(3);
  expect(b).toContain("second line");
  expect(b).toContain("┏");
});
