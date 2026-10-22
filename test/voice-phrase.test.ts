import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Fm } from "../src/imessage/fm.ts";
import { fill, phrase, relineate, validateTemplate } from "../src/voice/phrase.ts";

// .env may pin VOICE=plain for the live agent; these tests set the mode they mean explicitly.
let prevVoice: string | undefined;
beforeAll(() => { prevVoice = process.env.VOICE; process.env.VOICE = "device"; });
afterAll(() => { if (prevVoice === undefined) delete process.env.VOICE; else process.env.VOICE = prevVoice; });

const FACTS = { PRICE: "$375", GAP: "$155.75", MONTH: "Jul 2027" };
const REQ = ["PRICE", "GAP"];
const FALLBACK = "Tight. You're {GAP} behind pace. Buying it ({PRICE}) moves the goal to {MONTH}.";
const ok = (t: string) => validateTemplate(t, FACTS, REQ);
const reason = (t: unknown) => { const v = validateTemplate(t, FACTS, REQ); return v.ok ? null : v.reason; };

describe("validateTemplate", () => {
  test("accepts a placeholder-only template with bullets and one emoji", () => {
    const t = "Tight, but doable. 👀\n• {GAP} behind pace\n• Buying it ({PRICE}) pushes the goal to {MONTH}\nText goal for the plan.";
    expect(ok(t)).toEqual({ ok: true, template: t });
  });
  test("the exact 'Sure! Here's…' leak is rejected", () => {
    expect(reason("Sure! Here's the text message you requested:\n\n{PRICE} jacket, {GAP} behind pace.")).toBe("preamble or filler");
  });
  test.each([
    ["Tight. {GAP} behind on 10k.", "digit"],
    ["Tight. You'd be ${GAP} short of {PRICE}.", "dollar sign"],
    ["Tight. {GAP} behind; {PRICE} buys it; {TOTAL} total.", "unknown placeholder {TOTAL}"],
    ["Tight. You're behind pace. Buying it moves the goal to {MONTH}.", "missing placeholder {PRICE}"],
    ["Tight. {GAP} behind, {PRICE} {oops}.", "stray brace"],
    ["Here is the deal: {GAP} behind, {PRICE}.", "preamble or filler"],
    ["As an AI I think {GAP} behind, {PRICE}.", "preamble or filler"],
    ["Certainly. {GAP} behind, {PRICE}.", "preamble or filler"],
    ["Great question! {GAP} behind, {PRICE}.", "preamble or filler"],
    ["{GAP} behind, {PRICE}. I hope this helps", "preamble or filler"],
    ["{GAP} behind, {PRICE}. See https://example.com", "url"],
    ["**Tight.** {GAP} behind, {PRICE}.", "markdown"],
    ["# Tight\n{GAP} behind, {PRICE}.", "markdown"],
    ["Tight. `{GAP}` behind, {PRICE}.", "markdown"],
    ["Tight 😬🙈 {GAP} behind, {PRICE}.", "more than one emoji"],
    ["", "empty"],
    [42, "not a string"],
  ])("rejects %p → %s", (t, why) => {
    expect(reason(t)).toBe(why);
  });
  test("over 480 chars or 8 lines (after filling) is rejected", () => {
    expect(reason(`{GAP} behind, {PRICE}. ${"so ".repeat(160)}`)).toBe("over 480 chars");
    expect(reason(`{GAP} behind\n{PRICE}\na\nb\nc\nd\ne\nf\ng`)).toBe("over 8 lines");
  });
  test("a template wrapped in quotes is unwrapped", () => {
    expect(ok("“Tight. {GAP} behind, {PRICE}.”")).toEqual({ ok: true, template: "Tight. {GAP} behind, {PRICE}." });
  });
  test("relineate puts sentences and bullets on their own lines, and leaves multi-line templates alone", () => {
    expect(relineate("Tight, but doable. You're {GAP} behind pace. • Keep it under {PRICE} • Or skip dinners. Text goal for the plan."))
      .toBe("Tight, but doable.\nYou're {GAP} behind pace.\n• Keep it under {PRICE}\n• Or skip dinners.\nText goal for the plan.");
    expect(relineate("e.g. tight, then {GAP} behind")).toBe("e.g. tight, then {GAP} behind");
    expect(relineate("Line one.\nLine two. Still two.")).toBe("Line one.\nLine two. Still two.");
  });
  test("fill leaves unknown names alone", () => {
    expect(fill("{PRICE} and {NOPE}", FACTS)).toBe("$375 and {NOPE}");
  });
});

describe("phrase", () => {
  const fmReturning = (template: unknown, seen: string[] = []): Fm => ({
    extract: async (prompt) => { seen.push(prompt); return { template } as Record<string, unknown>; },
    respond: async () => null,
  });
  const plain = fill(FALLBACK, FACTS);

  test("device lines are joined with line breaks; malformed lines are rejected", async () => {
    const lines = (l: unknown): Fm => ({ extract: async () => ({ lines: l }) as Record<string, unknown>, respond: async () => null });
    expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: lines(["Tight, but doable.", "{GAP} behind pace.", "", "• {PRICE} moves it to {MONTH}"]) }))
      .toEqual({ text: "Tight, but doable.\n$155.75 behind pace.\n• $375 moves it to Jul 2027", voiced: true });
    expect((await phrase("afford", "s", FACTS, FALLBACK, { fm: lines([]) })).voiced).toBe(false);
    expect((await phrase("afford", "s", FACTS, FALLBACK, { fm: lines(["{GAP}", 7, "{PRICE} {MONTH}"]) })).voiced).toBe(false);
    expect((await phrase("afford", "s", FACTS, FALLBACK, { fm: lines("{GAP} {PRICE} {MONTH}") })).voiced).toBe(false);
  });
  test("a valid device template is filled locally and marked voiced", async () => {
    const r = await phrase("afford", "verdict tight", FACTS, FALLBACK, { required: REQ, fm: fmReturning("Tight, but doable.\n{GAP} behind pace; {PRICE} pushes it to {MONTH}.") });
    expect(r).toEqual({ text: "Tight, but doable.\n$155.75 behind pace; $375 pushes it to Jul 2027.", voiced: true });
  });
  test("a flattened one-line device template comes back with line breaks", async () => {
    const r = await phrase("afford", "verdict tight", FACTS, FALLBACK, { fm: fmReturning("Tight. You're {GAP} behind pace. • {PRICE} moves it to {MONTH}") });
    expect(r).toEqual({ text: "Tight.\nYou're $155.75 behind pace.\n• $375 moves it to Jul 2027", voiced: true });
  });
  test("multi-line fallbacks with blank lines and bullets are kept as written", async () => {
    const fb = "Tight, but doable.\nYou're {GAP} behind pace.\n\nIf you still want it:\n• Under {PRICE} keeps you on track\n\nText \"goal\" for the full plan.";
    expect(await phrase("afford", "s", FACTS, fb)).toEqual({ text: fill(fb, FACTS), voiced: false });
  });
  test("an invalid template, null, a throw, or a timeout all send the fallback", async () => {
    expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: fmReturning("{GAP} behind on 10k, {PRICE}") })).toEqual({ text: plain, voiced: false });
    expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: { extract: async () => null, respond: async () => null } })).toEqual({ text: plain, voiced: false });
    expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: { extract: async () => { throw new Error("boom"); }, respond: async () => null } })).toEqual({ text: plain, voiced: false });
    const slow: Fm = { extract: () => new Promise((r) => setTimeout(() => r({ template: "{GAP} {PRICE} {MONTH}" }), 500)), respond: async () => null };
    const t0 = Date.now();
    expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: slow, timeoutMs: 30 })).toEqual({ text: plain, voiced: false });
    expect(Date.now() - t0).toBeLessThan(300);
  });
  test("by default every fallback placeholder is required", async () => {
    // Drops {MONTH}, which the fallback carries.
    expect((await phrase("afford", "s", FACTS, FALLBACK, { fm: fmReturning("Tight. {GAP} behind, {PRICE}.") })).voiced).toBe(false);
  });
  test("VOICE=plain forces the fallback even with a model", async () => {
    const prev = process.env.VOICE;
    process.env.VOICE = "plain";
    try {
      const seen: string[] = [];
      expect(await phrase("afford", "s", FACTS, FALLBACK, { fm: fmReturning("Tight. {GAP} {PRICE} {MONTH}", seen) })).toEqual({ text: plain, voiced: false });
      expect(seen).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.VOICE; else process.env.VOICE = prev;
    }
  });
  test("under bun test with no model passed it stays deterministic", async () => {
    expect(await phrase("afford", "s", FACTS, FALLBACK)).toEqual({ text: plain, voiced: false });
  });
  test("the model sees placeholder names and the persona, never a value", async () => {
    const seen: string[] = [];
    await phrase("afford", "verdict tight; behind savings pace", FACTS, FALLBACK, { fm: fmReturning("Tight. {GAP} {PRICE} {MONTH}", seen) });
    const prompt = seen[0];
    expect(prompt).toContain("{PRICE}");
    expect(prompt).toContain("Line 1 is the answer, in 60 chars or fewer");
    for (const v of Object.values(FACTS)) expect(prompt).not.toContain(v);
    expect(prompt).not.toMatch(/\$\d|\d+\.\d\d/); // no amounts (the persona's own "60 chars" is instruction text)
  });
});
