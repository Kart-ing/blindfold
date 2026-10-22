// The ONLY code path from this app to an LLM over the network. Scan, block on any hit, else send exactly the scanned bytes.
// Egress never writes ledger rows: it returns the canary result and the caller puts it in Reply.ledger.
// Callers build one payload shape ({max_tokens, system, messages:[{role, content: string}]}); the selected backend
// encodes it for the wire (OpenAI Chat Completions, or Responses with web search for research.ts; Bedrock Converse or
// Anthropic Messages), and the canary scans that encoded body.
import type { Database } from "bun:sqlite";
import { scan, sensitiveValues } from "./canary.ts";
import { fakePlanFor } from "./fake.ts";
import { activeGate, gateText } from "./gate.ts";

export const MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 20_000;

/** Sends exact wire bytes; returns the response normalized to {content: [{type: "text", text}]}. Tests inject fakes. */
export type Provider = (body: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
/** model/json/reasoning: per-call overrides for the OpenAI wire (Luna); other encodings ignore them. web_search: research.ts. */
export type Payload = { max_tokens?: number; system?: string; messages: { role: "user" | "assistant"; content: string }[];
  model?: string; json?: boolean; reasoning?: string; max_completion?: number; web_search?: boolean;
  /** A strict JSON schema for the reply (reason.ts); OpenAI wire only. */ json_schema?: object; [k: string]: unknown };
export type Backend = { name: "openai" | "bedrock" | "anthropic" | "fake"; model: string; encode: (p: Payload) => string; send: Provider };

/** Env keys each backend needs before anything is sent (scripts read this, so provider names stay in this file). */
export const REQUIRED_ENV: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"], bedrock: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "BEDROCK_MODEL_ID"], anthropic: ["ANTHROPIC_API_KEY"], fake: [],
};

const normalized = (text: string) => ({ content: [{ type: "text", text }] });
/** Thrown before anything goes on the wire (no key, the bun-test guard): the caller knows nothing left the Mac. */
export class NotSent extends Error {}

// ---- OpenAI Chat Completions API (GPT-6.1 Sol by default) ----
export const openaiModel = () => process.env.OPENAI_MODEL || "gpt-6.1-sol";
/** The conversational calls (converse.ts): the configured model unless OPENAI_CONVERSE_MODEL names another (gpt-6-luna). */
export const converseModel = () => process.env.OPENAI_CONVERSE_MODEL || openaiModel();
/** reason.ts: the configured model (Sol) unless OPENAI_REASON_MODEL names a faster one. */
export const reasonModel = () => process.env.OPENAI_REASON_MODEL || openaiModel();
/** Web research (research.ts): the configured model unless OPENAI_RESEARCH_MODEL names another. */
export const researchModel = () => process.env.OPENAI_RESEARCH_MODEL || openaiModel();
const OPENAI_TIMEOUT_MS = 45_000; // a reasoning model; low effort answers the planner prompt in a few seconds
const CHAT_URL = "https://api.openai.com/v1/chat/completions", RESPONSES_URL = "https://api.openai.com/v1/responses";
// The Responses API with its built-in web search, for research.ts only: instructions plus the turns we wrote, nothing
// else (no user id, no location: the search runs without one), and store: false so nothing stays on OpenAI's side.
const responsesEncode = (p: Payload) => JSON.stringify({
  model: p.model || researchModel(),
  ...(p.system ? { instructions: p.system } : {}),
  input: p.messages.map((m) => ({ role: m.role, content: m.content })),
  tools: [{ type: "web_search" }],
  reasoning: { effort: p.reasoning || process.env.OPENAI_REASONING_EFFORT || "low" },
  max_output_tokens: p.max_completion ?? 4000,
  store: false,
});
/** A Responses API result → {content: [{type: "text", text}], sources: [cited urls]} (the answer text, then what it cites). */
export function normalizeResponses(out: unknown): { content: { type: "text"; text: string }[]; sources: string[] } {
  type Part = { type?: string; text?: string; annotations?: { type?: string; url?: string }[] };
  const items = ((out as { output?: { type?: string; content?: Part[] }[] })?.output ?? []).filter((o) => o?.type === "message");
  const parts = items.flatMap((o) => (Array.isArray(o.content) ? o.content : [])).filter((c) => c?.type === "output_text" && typeof c.text === "string");
  const sources = parts.flatMap((c) => (c.annotations ?? []).filter((a) => a?.type === "url_citation" && typeof a.url === "string").map((a) => a.url!));
  return { content: [{ type: "text", text: parts.map((c) => c.text).join("") }], sources };
}
export const openaiEncode = (p: Payload) => p.web_search ? responsesEncode(p) : JSON.stringify({
  model: p.model || openaiModel(),
  messages: [...(p.system ? [{ role: "system", content: p.system }] : []), ...p.messages.map((m) => ({ role: m.role, content: m.content }))],
  max_completion_tokens: p.max_completion ?? 4000, // includes reasoning tokens
  reasoning_effort: p.reasoning || process.env.OPENAI_REASONING_EFFORT || "low",
  ...(p.json_schema ? { response_format: { type: "json_schema", json_schema: { name: "plan", strict: true, schema: p.json_schema } } }
    : p.json ? { response_format: { type: "json_object" } } : {}),
});
export const openaiProvider: Provider = async (body, opts) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new NotSent("OPENAI_API_KEY is not set");
  const web = (JSON.parse(body) as { input?: unknown }).input !== undefined; // responsesEncode's shape
  const res = await fetch(web ? RESPONSES_URL : CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(providerError(res.status, await res.text(), key));
  if (web) return normalizeResponses(await res.json());
  const out = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  return normalized(out.choices?.[0]?.message?.content ?? "");
};

/** "planner HTTP <status>: <provider message>", never containing the key. */
export function providerError(status: number, text: string, key = ""): string {
  let msg = text;
  try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? text; } catch { /* not JSON */ }
  msg = String(msg).replace(/\s+/g, " ").slice(0, 200);
  if (key) msg = msg.split(key).join("[token]");
  return `planner HTTP ${status}: ${msg}`;
}

// ---- Anthropic Messages API ----
export const anthropicEncode = (p: Payload) => {
  const { model: _m, json: _j, reasoning: _r, max_completion: _c, web_search: _w, json_schema: _s, ...rest } = p; // OpenAI-only overrides aren't Messages API fields
  return JSON.stringify({ ...rest, model: MODEL });
};
export const anthropicProvider: Provider = async (body) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new NotSent("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`planner HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 200).split(key).join("[token]")}`);
  return res.json(); // already {content: [{type: "text", text}]}
};

// ---- AWS Bedrock Converse API (GLM via a Bedrock API key) ----
export const bedrockEncode = (p: Payload) => JSON.stringify({
  ...(p.system ? { system: [{ text: p.system }] } : {}),
  messages: p.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
  inferenceConfig: { maxTokens: 1500, temperature: 0 },
});
export const bedrockProvider: Provider = async (body) => {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK, region = process.env.AWS_REGION, model = process.env.BEDROCK_MODEL_ID;
  if (!token || !region || !model) throw new NotSent("AWS_BEARER_TOKEN_BEDROCK, AWS_REGION and BEDROCK_MODEL_ID must be set");
  const res = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(bedrockError(res.status, await res.text(), token));
  const out = (await res.json()) as { output?: { message?: { content?: { text?: string }[] } } };
  return normalized((out.output?.message?.content ?? []).map((c) => c.text ?? "").join(""));
};

export const BEDROCK_ACCESS_HINT = "Bedrock refused this model for this key; run `bun run scripts/bedrock-models.ts` to see why. authorization NOT_AUTHORIZED: the IAM user/role that created the key needs bedrock:InvokeModel on the model and its inference profile (e.g. attach AmazonBedrockLimitedAccess), then make a new key. agreement/entitlement not AVAILABLE: enable the model in the Bedrock console's Model catalog.";

/** "HTTP <status>: <provider message>" (+ a hint for known cases). Never contains the token. */
export function bedrockError(status: number, text: string, token = ""): string {
  let msg = text;
  try { const j = JSON.parse(text); msg = j.message ?? j.Message ?? j.error?.message ?? text; } catch { /* not JSON */ }
  msg = String(msg).replace(/\s+/g, " ").slice(0, 200);
  if (token) msg = msg.split(token).join("[token]");
  const hint = status === 400 && /operation not allowed/i.test(msg) ? ` (${BEDROCK_ACCESS_HINT})`
    : status === 403 ? " (check AWS_REGION matches the region the key was issued in, and that the key hasn't expired)" : "";
  return `planner HTTP ${status}: ${msg}${hint}`;
}

// ---- fake: no network. Canned plans picked from the symbolized question (fake.ts). The body carries provider:"fake",
// so the ledger, the `ledger` reply and the panel never count it as sent; plan.ts labels every reply "[fake planner]".
export const fakeEncode = (p: Payload) => JSON.stringify({ provider: "fake", ...p });
const fakeProvider: Provider = async (body) => {
  const p = JSON.parse(body) as Payload;
  const question = (p.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const conv = (await import("./converse.ts")).fakeConverse(String(p.system ?? ""), String(question)); // Luna's two calls
  if (conv) return normalized(JSON.stringify(conv));
  const verdict = (await import("./research.ts")).fakeResearch(String(p.system ?? ""), String(question));
  if (verdict) return { ...normalized(verdict.text), sources: verdict.sources };
  const { SYSTEM_PROMPT } = await import("./plan.ts");
  const golden = JSON.parse(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.lastIndexOf('{"steps"')));
  return normalized(JSON.stringify(fakePlanFor(String(question), golden)));
};

// Under `bun test` a real provider never sends (.env holds a live key): a test must mock fetch and set FIN_TEST_NETWORK=1.
const testGuardSend: Provider = async () => { throw new NotSent("network disabled under bun test (mock fetch and set FIN_TEST_NETWORK=1)"); };

/** The backend LLM_PROVIDER selects (openai by default, matching .env.example). */
export function selectedBackend(): Backend {
  const name = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (name === "fake") return { name: "fake", model: "fake planner (canned plans, nothing sent)", encode: fakeEncode, send: fakeProvider };
  const b: Backend = name === "anthropic" ? { name: "anthropic", model: MODEL, encode: anthropicEncode, send: anthropicProvider }
    : name === "openai" ? { name: "openai", model: openaiModel(), encode: openaiEncode, send: openaiProvider }
    : { name: "bedrock", model: process.env.BEDROCK_MODEL_ID || "(BEDROCK_MODEL_ID unset)", encode: bedrockEncode, send: bedrockProvider };
  return process.env.NODE_ENV === "test" && !process.env.FIN_TEST_NETWORK ? { ...b, send: testGuardSend } : b;
}

let override: Backend | null = null;
/**
 * Tests/scripts: swap the network for a fake sender. The wire encoding defaults to Anthropic's shape (what the tests
 * read); pass "openai" or "bedrock" to exercise those encodings. Returns the previous provider.
 */
export function setProvider(p: Provider, encoding: "anthropic" | "bedrock" | "openai" | "fake" = "anthropic"): Provider {
  const prev = override?.send ?? selectedBackend().send;
  // Restoring a real sender returns to the configured backend (its own encoding), not a mismatched pair.
  if (p === anthropicProvider || p === bedrockProvider || p === openaiProvider || p === fakeProvider || p === testGuardSend) { override = null; return prev; }
  const encode = encoding === "bedrock" ? bedrockEncode : encoding === "openai" ? openaiEncode : encoding === "fake" ? fakeEncode : anthropicEncode;
  override = { name: encoding, model: `wrapped:${encoding}`, encode, send: p };
  return prev;
}
export function resetProvider() { override = null; }
export const activeBackend = (): Backend => override ?? selectedBackend();
/** Web search exists on the OpenAI wire (and the fake answers canned research); the other backends can't look things up. */
export const webSearchAvailable = () => activeBackend().name === "openai" || activeBackend().name === "fake";

let lastError: string | null = null;
let warnedPrompt = false;
/** The provider error from the most recent egress call (HTTP status + message, never the token), for diagnostics. */
export const lastEgressError = () => lastError;

export type Canary = { checked: number; hits: string[] };
/** sent: the body went to the provider (false when the canary blocked it or a NotSent refusal happened first). */
export type EgressResult = { ok: boolean; response?: unknown; canary: Canary; body: string; error?: string; sent?: boolean;
  /** Where the time went: the local gate, and the provider round trip. */
  timing?: { gate_ms: number; send_ms: number } };

/** The numeric request settings the encoders above write, by path: top-level keys, and Bedrock's inferenceConfig. */
export const PROTOCOL_NUMBERS = new Set(["max_output_tokens", "max_completion_tokens", "max_tokens", "temperature", "top_p", "seed", "n"]);
export const BEDROCK_INFERENCE_NUMBERS = new Set(["maxTokens", "temperature", "topP"]);
/** A copy of an encoded body without the numbers at those exact paths (nothing nested deeper is touched). */
export function withoutProtocolNumbers(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "number" && PROTOCOL_NUMBERS.has(k)) continue;
    if (k === "inferenceConfig" && v && typeof v === "object" && !Array.isArray(v))
      out[k] = Object.fromEntries(Object.entries(v).filter(([ik, iv]) => !(typeof iv === "number" && BEDROCK_INFERENCE_NUMBERS.has(ik))));
    else out[k] = v;
  }
  return out;
}

/** Every string leaf of a value, so escapes can't hide a value from the scan. */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); leaves(x, out); }
  return out;
}

/**
 * payload: {max_tokens, system, messages}. allow: exact value strings the user consented to send for this call;
 * only those exact strings are dropped from the canary set.
 */
export async function egress(db: Database, payload: object, opts: { allow?: string[]; timeoutMs?: number } = {}): Promise<EgressResult> {
  lastError = null;
  const backend = activeBackend();
  const allow = new Set((opts.allow ?? []).map((a) => a.toLowerCase()));
  // The local privacy gate (gate.ts) sees every user turn we author before anything else; it fails closed. Skipped only
  // when nothing would leave anyway (the fake planner).
  const gate = backend.name === "fake" ? null : activeGate();
  const t0 = performance.now();
  if (gate) {
    try {
      const p0 = payload as Payload;
      payload = { ...p0, messages: await Promise.all(p0.messages.map(async (m) => (m.role === "user" ? { ...m, content: await gateText(db, gate, m.content, allow) } : m))) };
    } catch (e) {
      lastError = `gate: ${(e as Error).message ?? e}`;
      console.error(`[gate] ${(e as Error).message ?? e}; nothing sent to the cloud`);
      return { ok: false, canary: { checked: 0, hits: [] }, body: "[]", error: lastError, sent: false, timing: { gate_ms: Math.round(performance.now() - t0), send_ms: 0 } };
    }
  }
  const gate_ms = Math.round(performance.now() - t0);
  const body = backend.encode(payload as Payload);
  const values = sensitiveValues(db).filter((v) => !allow.has(v.toLowerCase()));
  const p = payload as Payload;
  // The static system prompt is code, not user data: it's checked on its own, failing closed (and logging) if it ever
  // matches a DB value, and left out of the per-call scan below.
  if (p.system) {
    const inPrompt = scan(p.system, values).hits;
    if (inPrompt.length) {
      if (!warnedPrompt) { console.error(`egress: the static system prompt matches ${inPrompt.length} DB value(s); failing closed`); warnedPrompt = true; }
      return { ok: false, canary: { checked: values.length, hits: inPrompt }, body, error: "blocked" };
    }
  }
  // Scan what WE author per call: our user turns (question, disclosed results, validator errors). Assistant turns are the
  // provider's own words echoed back (plan.ts only ever puts planner output there); blocking on them would turn the
  // canary into a membership oracle ("Costco {s1}" blocked ⇒ you shop at Costco). Codex #7.
  // Numbers at the protocol paths our encoders write (top-level max_output_tokens: 3000, Bedrock's inferenceConfig.maxTokens)
  // are settings, not data: scanning them blocked a live call because 3000 is also the cents form of a real $30.00 charge.
  // Only those exact paths are dropped; a number anywhere else, at any depth, is scanned.
  const ours = JSON.stringify(withoutProtocolNumbers(JSON.parse(backend.encode({ ...p, system: undefined, messages: (p.messages ?? []).filter((m) => m.role !== "assistant") }))));
  const a = scan(ours, values);
  const b = scan(leaves(JSON.parse(ours)).join("\n"), values);
  const canary = { checked: a.checked, hits: [...new Set([...a.hits, ...b.hits])] };
  if (canary.hits.length) return { ok: false, canary, body, error: "blocked", timing: { gate_ms, send_ms: 0 } };
  const t1 = performance.now();
  try {
    const response = await backend.send(body, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined);
    return { ok: true, response, canary, body, sent: true, timing: { gate_ms, send_ms: Math.round(performance.now() - t1) } };
  } catch (e) {
    lastError = String((e as Error).message ?? e);
    return { ok: false, canary, body, error: lastError, sent: !(e instanceof NotSent), timing: { gate_ms, send_ms: Math.round(performance.now() - t1) } };
  }
}
