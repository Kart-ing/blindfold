// Sol reasons, the Mac computes (tasks/equations.md): one reason() call per message → a Plan; here it runs locally.
// Actions (set_goal / add_asset / remember) and facts are evaluated on the real values, equations are solved by
// eng1's evaluator, the template is filled by eng1's renderer, and symbols become names only on this Mac.
import type { Database } from "bun:sqlite";
import type { Ctx, Intent, LedgerMeta, Reply } from "../handlers/types.ts";
import type { Plan, Vars } from "./types.ts";
import { evalExpr, evaluate } from "./expr.ts";
import { checkTemplate, render } from "./render.ts";
import { varDefs } from "./vars.ts";
import { friendlyUsd } from "../handlers/afford.ts";
import { savingsCents } from "../handlers/finance.ts";
import { deadlineFor } from "../handlers/goal_set.ts";
import { addAsset } from "../memory/assets.ts";
import { forgetFact, storeFact } from "../memory/facts.ts";
import { saveMemory } from "../memory/store.ts";
import { assetDisplayName } from "../imessage/assets.ts";
import { FIRST_GOAL_TAIL, lunaHistory, pushTurn } from "../imessage/luna.ts";
import { realFor, symbolizeText } from "../cloud/symbolize.ts";
import type { Turn } from "../cloud/converse.ts";

type ReasonFn = (db: Database, text: string, history: Turn[], defs: ReturnType<typeof varDefs>["defs"], ctx: { now: number },
  deps?: { checkTemplate?: typeof checkTemplate }) => Promise<{ plan: Plan; ledger: LedgerMeta; qsyms: Record<string, string>; symbolized: string }
    | { failed: true; ledger: LedgerMeta } | null>;

let override: ReasonFn | null | undefined;
/** Tests: inject reason() (null = unavailable). */
export const setReason = (f: ReasonFn | null | undefined) => { override = f; };
async function loadReason(): Promise<ReasonFn | null> {
  if (override !== undefined) return override;
  try { return (await import("../cloud/reason.ts")).reason as ReasonFn; } catch { return null; }
}

/** The reason path is the primary brain when Luna/Sol conversation is on (VOICE=cloud); BRAIN=luna keeps the old one. */
export const reasonEnabled = () => process.env.VOICE === "cloud" && process.env.BRAIN !== "luna";

const log = (m: string) => { if (process.env.NODE_ENV !== "test" || process.env.DEBUG_REASON) console.log(`[reason] ${m}`); };

/** Q_AMT_n → its real amount, then the symbols table; null = unknown. */
const symbolsFor = (db: Database, qsyms: Record<string, string>) => (s: string): string | null => {
  if (/^Q_AMT_\d+$/.test(s) && /^\d+$/.test(qsyms[s] ?? "")) return friendlyUsd(Number(qsyms[s]));
  if (/^Q_NUM_\d+$/.test(s) && qsyms[s] !== undefined) return qsyms[s];
  return realFor(db, s);
};

/** usd-valued expression → cents, or null (wrong unit, bad expr, not positive). */
function usdOf(expr: string, vars: Vars): number | null {
  try { const v = evalExpr(expr, vars); return v.unit === "usd" && v.value > 0 ? Math.round(v.value) : null; } catch { return null; }
}

export type ReasonOutcome = { reply: Reply; intent: Intent } | { egress: LedgerMeta } | null;

/**
 * null: reason() was unavailable or returned nothing → the local fallback (no ledger egress known).
 * { egress }: a Plan came back but couldn't run (bad equation, render error) → fallback, recording what was sent.
 */
export async function reasonPath(db: Database, text: string, ctx: Ctx): Promise<ReasonOutcome> {
  const reason = await loadReason();
  if (!reason) return null;
  const pre = symbolizeText(db, text);
  if (pre.hers.length) return null; // her side of the card never goes out
  const table = varDefs(db, ctx.now, pre.qsyms);
  const t0 = performance.now();
  let r: Awaited<ReturnType<ReasonFn>> = null;
  try { r = await reason(db, text, lunaHistory(), table.defs, ctx, { checkTemplate }); } catch (e) { log(`failed: ${(e as Error).message}`); }
  if (!r) { log(`no plan → fallback (${((performance.now() - t0) / 1000).toFixed(1)}s)`); return null; }
  // Sent (or canary-blocked) but no valid plan: the fallback answers, and its row records this egress.
  if ("failed" in r) { log(`no valid plan → fallback, egress recorded (${((performance.now() - t0) / 1000).toFixed(1)}s)`); return { egress: r.ledger }; }
  const { plan, ledger, qsyms } = r;
  const withQ = (v: Vars): Vars => {
    const out = { ...v };
    for (const [k, c] of Object.entries(qsyms)) if (/^Q_AMT_\d+$/.test(k) && /^\d+$/.test(c)) out[k] = { unit: "usd", value: Number(c) };
    return out;
  };
  let vars = withQ(table.vars);
  const notes: string[] = [];
  let firstGoal = false, remembered = false, goalSet = false;

  // 1. Actions, on real values.
  for (const a of plan.actions) {
    if (a.type === "set_goal") {
      const target = usdOf(a.amount, vars);
      const current = db.query("SELECT deadline FROM goals WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as { deadline: number } | null;
      let deadline: number | null = current?.deadline ?? null;
      if (a.by && String(a.by).trim()) {
        try { const v = evalExpr(String(a.by), vars); if (v.unit === "date") deadline = v.value; } catch { deadline = deadlineFor(`by ${a.by}`, ctx.now) ?? deadline; }
      }
      if (target === null || deadline === null || deadline <= ctx.now) { log("set_goal skipped (amount or deadline)"); continue; }
      firstGoal ||= !(db.query("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n;
      const savings = savingsCents(db);
      db.transaction(() => {
        db.run("UPDATE goals SET active = 0 WHERE active = 1");
        db.run("INSERT INTO goals(target_cents, deadline, created_ts, savings_at_creation_cents, active) VALUES (?, ?, ?, ?, 1)", [target, deadline, ctx.now, savings]);
      })();
      goalSet = true;
    } else if (a.type === "add_asset") {
      const amount = usdOf(a.amount, vars);
      const name = assetDisplayName(db, String(a.name ?? ""));
      if (!name || amount === null) { log(`add_asset skipped: ${!name ? "name" : "amount"}`); continue; }
      const prev = db.query("SELECT amount_cents AS c FROM manual_assets WHERE LOWER(name) = LOWER(?) ORDER BY id DESC LIMIT 1").get(name) as { c: number } | null;
      if (prev?.c === amount) continue; // already known at this amount
      const { replaced } = addAsset(db, name, amount, ctx.now);
      notes.push(`${replaced ? "Updated" : "Noted"}: about ${friendlyUsd(amount)} in ${name}.`);
    } else if (a.type === "remember" && !remembered) {
      saveMemory(db, { text: text.trim(), now: ctx.now }); // the user's own words, once per message
      remembered = true;
    }
  }
  // Goals and assets may have changed: the values the equations see are re-read (names Sol saw are unchanged or new).
  if (goalSet || notes.length) vars = { ...withQ(varDefs(db, ctx.now, qsyms).vars), ...Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith("U_"))) };

  // 2. Facts: forget first, then store each with its value computed here.
  for (const n of plan.forget_facts) if (forgetFact(db, n)) delete vars[n];
  for (const f of plan.facts) {
    let v;
    try { v = evalExpr(f.expr, vars); } catch (e) { log(`fact ${f.name} skipped: ${(e as Error).message}`); continue; }
    if (v.unit !== f.unit) { log(`fact ${f.name} skipped: unit ${v.unit} ≠ ${f.unit}`); continue; }
    storeFact(db, { name: f.name, unit: f.unit, value: v.value, desc: f.desc }, ctx.now);
    vars[f.name] = v;
  }

  // 3. Equations, then 4. the reply.
  const ev = evaluate(plan.equations, vars);
  if (!ev.ok) { log(`equations failed: ${ev.error} → fallback`); return { egress: ledger }; }
  const out = render(plan.reply, ev.values, symbolsFor(db, qsyms));
  if (!out.ok) { log(`render failed: ${out.error} → fallback`); return { egress: ledger }; }
  let body = out.text.trim();
  if (notes.length) body = `${body}\n${notes.join("\n")}`;
  if (firstGoal) body += FIRST_GOAL_TAIL;
  log(`plan: ${plan.actions.length} actions, ${plan.facts.length} facts, ${plan.equations.length} equations (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

  pushTurn({ role: "user", text: r.symbolized });
  pushTurn({ role: "assistant", text: plan.reply, intent: "other" }); // the template: names and placeholders, no values
  return { reply: { text: body, tier: "cloud", ledger }, intent: goalSet ? "goal_set" : "other" };
}
