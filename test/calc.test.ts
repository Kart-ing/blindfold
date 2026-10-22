// src/calc: the equation evaluator and the reply template (tasks/equations.md). Synthetic values only.
import { describe, expect, test } from "bun:test";
import { addMonths, evalExpr, monthsBetween, ptMidnight, ptParts } from "../src/calc/expr";
import { evaluate } from "../src/calc/expr";
import { checkTemplate, render } from "../src/calc/render";
import type { Vars } from "../src/calc/types";

const D = (s: string) => { const [y, m, d] = s.split("-").map(Number); return ptMidnight(y, m, d); };
const usd = (dollars: number) => ({ unit: "usd" as const, value: dollars * 100 });
const usdMo = (dollars: number) => ({ unit: "usd_mo" as const, value: dollars * 100 });
const V: Vars = { TODAY: { unit: "date", value: D("2026-10-22") + 12 * 3600 }, SAVINGS: usd(12_000), SPEND_MO: usdMo(3_000), NET_MO: usdMo(1_800) };
const val = (expr: string, vars: Vars = V) => evalExpr(expr, vars);
const err = (expr: string, vars: Vars = V) => { const r = evaluate([{ name: "x", expr }], vars); return r.ok ? null : r.error; };

describe("units", () => {
  test("usd / usd_mo = months; usd_mo * months = usd; usd / usd = number; usd / months = usd_mo", () => {
    expect(val("SAVINGS / SPEND_MO")).toEqual({ unit: "months", value: 12_000 / 3_000 });
    expect(val("SPEND_MO * (SAVINGS / SPEND_MO)").unit).toBe("usd");
    expect(val("SAVINGS / SAVINGS")).toEqual({ unit: "number", value: 1 });
    expect(val("SAVINGS / (SAVINGS / SPEND_MO)").unit).toBe("usd_mo");
    expect(val("SAVINGS * 2")).toEqual(usd(24_000));
    expect(val("SAVINGS > SAVINGS / 2")).toEqual({ unit: "bool", value: 1 });
  });
  test("mismatches are rejected", () => {
    for (const e of ["SAVINGS + SPEND_MO", "SAVINGS + 100", "SAVINGS * SAVINGS", "TODAY + 3", "TODAY - TODAY", "SAVINGS > SPEND_MO",
      "SAVINGS && SAVINGS", "!SAVINGS", "-TODAY", "add_months(TODAY, SAVINGS)", "months_between(TODAY, SAVINGS)", "min(SAVINGS, SPEND_MO)"])
      expect(err(e)).not.toBeNull();
  });
});

describe("dates (PT calendar)", () => {
  test("date() is PT midnight; months_between and add_months across a year end", () => {
    expect(ptParts(val('date("2027-01-01")').value)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(val('months_between(date("2026-11-01"), date("2027-01-01"))').value).toBe(2);
    expect(val('months_between(next_month_start(TODAY), date("2027-01-01"))').value).toBe(2);
    expect(ptParts(val('add_months(date("2026-11-30"), 3)').value)).toEqual({ y: 2027, m: 2, d: 28 });
    expect(ptParts(val('add_months(date("2027-01-01"), -1)').value)).toEqual({ y: 2026, m: 12, d: 1 });
    expect(ptParts(val("month_start(TODAY)").value)).toEqual({ y: 2026, m: 10, d: 1 });
    expect(ptParts(val("next_month_start(add_months(TODAY, 2))").value)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(val('days_between(date("2026-12-31"), date("2027-01-01"))')).toEqual({ unit: "number", value: 1 });
    expect(monthsBetween(D("2027-01-01"), addMonths(D("2027-01-01"), 8.6))).toBeCloseTo(8.6, 1);
    expect(ptParts(val('add_months(date("2027-01-31"), 1)').value)).toEqual({ y: 2027, m: 2, d: 28 });
    expect(ptParts(val('add_months(date("2027-01-31"), (SAVINGS / SAVINGS) * 0.9999999)').value)).toEqual({ y: 2027, m: 2, d: 28 });
    expect(ptParts(val('add_months(date("2027-01-31"), 0.5)').value)).toEqual({ y: 2027, m: 2, d: 14 });
    expect(ptParts(val('add_months(date("2027-01-01"), 8.6)').value)).toEqual({ y: 2027, m: 9, d: 19 });
  });
  test("bad dates fail", () => {
    for (const e of ['date("2027-02-30")', 'date("next year")', "date(TODAY)", '"2027-01-01"']) expect(err(e)).not.toBeNull();
  });
});

describe("safety", () => {
  test("division by zero, unknown names and functions, NaN, bombs and limits → ok:false", () => {
    expect(err("SAVINGS / 0")).toMatch(/division by zero/);
    expect(err("SAVINGS / (SAVINGS - SAVINGS)")).toMatch(/division by zero/);
    expect(err("SECRET_VALUE * 2")).toMatch(/unknown name/);
    expect(err("eval(SAVINGS)")).toMatch(/unknown function/);
    expect(err("constructor")).toMatch(/unknown name/);
    expect(err("SAVINGS.toString")).not.toBeNull();
    expect(err("(".repeat(40) + "SAVINGS" + ")".repeat(40))).toMatch(/deeper/);
    expect(err("-".repeat(40) + "SAVINGS")).toMatch(/deeper/);
    expect(err("SAVINGS + ".repeat(60) + "SAVINGS")).toMatch(/longer/);
    expect(err("1e309")).not.toBeNull();
    expect(evaluate(Array.from({ length: 25 }, (_, i) => ({ name: `e${i}`, expr: "1" })), V)).toMatchObject({ ok: false });
    expect(evaluate([{ name: "Bad", expr: "1" }], V)).toMatchObject({ ok: false });
    expect(evaluate([{ name: "a", expr: "1" }, { name: "a", expr: "2" }], V)).toMatchObject({ ok: false });
    expect(evaluate([{ name: "a", expr: "b" }, { name: "b", expr: "1" }], V)).toMatchObject({ ok: false }); // order matters
  });
});

describe("a runway scenario, worked (synthetic numbers)", () => {
  const vars: Vars = { ...V, U_CHECKING_NOW: usd(3_000), U_OCT_INCOME_LEFT: usd(2_400) };
  const eqs = [
    { name: "now", expr: "SAVINGS + U_CHECKING_NOW" },
    { name: "jan1", expr: 'now + U_OCT_INCOME_LEFT + NET_MO * months_between(next_month_start(TODAY), date("2027-01-01"))' },
    { name: "runway", expr: "jan1 / SPEND_MO" },
    { name: "end", expr: 'add_months(date("2027-01-01"), runway)' },
  ];
  test("now $15k, Jan 1 $21k, 7 months, ending early August 2027", () => {
    const r = evaluate(eqs, vars);
    if (!r.ok) throw new Error(r.error);
    expect(r.values.now).toEqual(usd(15_000));
    expect(r.values.jan1).toEqual(usd(21_000));
    expect(r.values.runway.unit).toBe("months");
    expect(r.values.runway.value).toBeCloseTo(7, 6);
    const t = render("You'd have about {jan1} on {QUIT|day}. That lasts {runway} months, until {end|when}.[[if runway < SIX]] Tight.[[else]] Comfortable.[[end]]",
      { ...r.values, QUIT: { unit: "date", value: D("2027-01-01") }, SIX: { unit: "months", value: 6 } }, () => null);
    expect(t).toEqual({ ok: true, text: "You'd have about $21k on Jan 1, 2027. That lasts 7.0 months, until early-August 2027. Comfortable." });
  });
});

describe("reply template", () => {
  const names = new Set(Object.keys(V).concat(["need", "Q_AMT_1"]));
  test("number literals in the text are rejected; placeholders and symbols are fine", () => {
    expect(checkTemplate("Your goal is $40k by June.", names)).toMatch(/digit/);
    expect(checkTemplate("That's 8 months.", names)).toMatch(/digit/);
    expect(checkTemplate("Save {need|usd_mo} for PERSON_2, not Q_AMT_1.", names)).toBeNull();
    expect(checkTemplate("{nope}", names)).toMatch(/unknown placeholder/);
    expect(checkTemplate("{SAVINGS|money}", names)).toMatch(/unknown format/);
    expect(checkTemplate("[[if SAVINGS > X]]a[[end]]", names)).toMatch(/unknown name X/);
    expect(checkTemplate("[[if SAVINGS > SPEND_MO]]a[[if SAVINGS > SAVINGS]]b[[end]][[end]]", names)).toMatch(/one level/);
    expect(checkTemplate("[[if SAVINGS > SAVINGS]]a", names)).toMatch(/without \[\[end\]\]/);
    expect(checkTemplate("[[else]]a[[end]]", names)).toMatch(/misplaced/);
    expect(checkTemplate("x".repeat(901), names)).toMatch(/longer/);
    for (const t of ["About eight months.", "About forty thousand dollars.", "a couple hundred more", "a few grand", "Twelve weeks", "two dozen"])
      expect(checkTemplate(t, names)).toMatch(/number word/);
    expect(checkTemplate("One more month, half of it saved, often enough for the tenant.", names)).toBeNull();
    for (const t of ["You have ${need}", "You have {need}k", "{need}%", "K{need}", "{need}$", "about $ {need}"]) expect(checkTemplate(t, names)).not.toBeNull();
    expect(checkTemplate("You have {need}, okay.", names)).toBeNull();
  });
  test("formats, conditionals, symbols", () => {
    const vals: Vars = { ...V, need: usdMo(1_234), r: { unit: "months", value: 7.04 }, p: { unit: "number", value: 0.25 }, Q_AMT_1: usd(400) };
    const fill = (s: string) => (s === "PERSON_2" ? "Zorya" : s === "Q_AMT_1" ? "$400" : null);
    expect(render("{need} a month for PERSON_2; {r} months; {p|pct}; {TODAY|month}; {Q_AMT_1}.", vals, fill))
      .toEqual({ ok: true, text: "$1,234/mo a month for Zorya; 7.0 months; 25%; October; $400." });
    expect(render("[[if r < SPEND_MO]]x[[end]]", vals, fill)).toMatchObject({ ok: false }); // months vs usd_mo
    expect(render("[[if r > p]]x[[end]]", vals, fill)).toMatchObject({ ok: false });
    expect(render("[[if SAVINGS > SPEND_MO * r]]plenty[[elif SAVINGS > SAVINGS * p]]some[[else]]none[[end]]", vals, fill)).toEqual({ ok: true, text: "some" });
    expect(render("Ask PERSON_9.", vals, fill)).toEqual({ ok: false, error: "unknown symbol PERSON_9" });
    expect(render("{SAVINGS|when}", vals, fill)).toMatchObject({ ok: false });
  });
});
