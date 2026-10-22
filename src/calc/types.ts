// Contracts for "Sol writes the equation, the Mac solves it" (tasks/equations.md). Everyone codes against these.
// Sol only ever sees VarDefs (names, units, descriptions). Values live in Vars, on the Mac.

export type Unit = "usd" | "usd_mo" | "months" | "date" | "number" | "bool";
export const UNITS: readonly Unit[] = ["usd", "usd_mo", "months", "date", "number", "bool"];

/** Sent to Sol: no values, ever. */
export type VarDef = { name: string; unit: Unit; desc: string };
/** Local only. usd / usd_mo in cents, date = unix seconds (PT), months fractional, bool 0|1. */
export type Vars = Record<string, { unit: Unit; value: number }>;

/** name: [a-z][a-z0-9_]{0,31}; may use VARS and earlier equations. */
export type Equation = { name: string; expr: string };
/** A user-stated fact to persist. name: U_[A-Z0-9_]{1,30}; value = expr evaluated locally at store time. */
export type Fact = { name: string; unit: Unit; expr: string; desc: string };

/** The existing action whitelist; amounts are expressions over the variables. */
export type Action =
  | { type: "set_goal"; amount: string; by: string | null }
  | { type: "add_asset"; name: string; amount: string }
  | { type: "remember"; text: string };

export type Plan = {
  actions: Action[];
  facts: Fact[];
  forget_facts: string[];
  equations: Equation[]; // in order
  reply: string; // template
};

export type EvalResult = { ok: true; values: Vars } | { ok: false; error: string };
export type RenderResult = { ok: true; text: string } | { ok: false; error: string };

export const VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
export const EQ_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const FACT_NAME = /^U_[A-Z0-9_]{1,30}$/;
export const LIMITS = { equations: 24, exprChars: 400, depth: 32, template: 900 } as const;

// Implementations (eng1): evaluate in ./expr.ts, render / checkTemplate in ./render.ts.
export type Evaluate = (eqs: Equation[], vars: Vars) => EvalResult;
export type Render = (template: string, values: Vars, symbols: (s: string) => string | null) => RenderResult;
/** null = valid; otherwise the reason. */
export type CheckTemplate = (template: string, names: Set<string>) => string | null;
