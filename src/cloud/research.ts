// Research: "look at its reviews and tell me if it's worth it". One web-search call on the configured model, through
// egress like every other call. Only the question goes out, symbolized in research mode (symbolize.ts): no account data,
// history, memories or earlier turns. A store from the user's history goes out only with their consent; the user's own
// amounts go as a word range; the canary scans the exact bytes. The answer is cleaned on the Mac: links become source
// names, symbols become plain words, and a sentence quoting a number from the user's data that they didn't type is dropped.
import type { Database } from "bun:sqlite";
import type { Handler, LedgerMeta, Reply } from "../handlers/types.ts";
import { scan, sensitiveValues } from "./canary.ts";
import { activeBackend, egress, webSearchAvailable } from "./egress.ts";
import { HERS, bucket, desymbolize, lazyConsent, plainText, type CloudDeps } from "./plan.ts";
import { merchantForms, realFor, symbolizeText } from "./symbolize.ts";

export const RESEARCH_TIMEOUT_MS = 30_000;
const researchTimeout = () => Number(process.env.RESEARCH_MS) || RESEARCH_TIMEOUT_MS;
export const NOT_RESEARCH = "NOT_RESEARCH";
export const RESEARCH_FAKE_LABEL = "[fake research]";
export const NO_WEB = "I can't search the web from this setup.";
export const KEPT = "I kept that one on your Mac: the search would have carried something from your data.";
export const DECLINED = "Okay, I won't look that one up.";
export const UNREACHABLE = "The web search didn't answer, so I couldn't look that up.";
export const NOT_FOUND = "I couldn't find enough reviews to say. Try the exact product name.";
export const OFF_TOPIC = "I can look up reviews of something you're thinking of buying, like 'is the jacket I'm eyeing worth it?'";
const CONSENT_Q = "🔒 To look this up, the web search needs the name of a store from your history. Nothing else would be shared.";
const MAX_SENTENCES = 4, MAX_CHARS = 600, MAX_SOURCES = 3;

export const RESEARCH_PROMPT = `You help someone decide whether a product or service is worth buying. Search the web for recent reviews of what the message asks about, then reply in plain text with two or three short sentences: what reviewers like and dislike, how long it tends to last, and whether it's good value. No lists, no markdown, no links, no questions back. Quote a price only if it's the product's public price. The message may contain symbols such as PERSON_1, MERCHANT_1, ACCOUNT_1 or ADDR_1: they stand for private details you never see; ignore them and never guess them. A price range in parentheses is roughly what the user would pay. If the message isn't about a product, service or purchase, reply exactly: ${NOT_RESEARCH}`;

const host = (u: string): string | null => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
const DOMAIN = /^\(?(?:[a-z0-9-]+\.)+[a-z]{2,}\)?$/i;

/**
 * The model's answer → what the phone shows: sentences (no links, no symbols, plain text) and up to three source names.
 * userText: the user's message (numbers they typed may be quoted back). null: nothing usable.
 */
export function cleanVerdict(db: Database, userText: string, raw: string, qsyms: Record<string, string>, cited: string[] = []): string | null {
  let t = raw.trim();
  if (!t || t.includes(NOT_RESEARCH)) return null;
  const sources: string[] = [];
  const add = (u: string) => { const h = host(u); if (h && !sources.includes(h)) sources.push(h); };
  cited.forEach(add);
  // "([site.com](https://…))" citations → the sources line; "[words](url)" → words; bare urls → gone, site kept as a source.
  t = t.replace(/\(\s*\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)\s*\)/g, (_m, _l: string, url: string) => { add(url); return ""; });
  t = t.replace(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => { add(url); return DOMAIN.test(label.trim()) ? "" : label; });
  t = t.replace(/\(?\bhttps?:\/\/[^\s)]+?([.,;:!?]?)\)?(?=\s|$)/g, (u, end: string) => { add(u.replace(/^\(|[.,;:!?]?\)?$/g, "")); return end; });
  // Symbols it echoed: the user's amounts become words (no price quoted back); the rest are restored locally.
  t = t.replace(/\bQ_AMT_\d+\b/g, "that price").replace(/\bQ_NUM_\d+\b/g, "that number");
  t = desymbolize(db, t, qsyms);
  t = plainText(t).replace(/^•\s*/gm, "").replace(/\s*\n+\s*/g, " ").replace(/\(\s*\)/g, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // No number from the user's data unless they typed it: a sentence quoting one is dropped.
  const typed = new Set((userText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, ""))));
  const numeric = sensitiveValues(db).filter((v) => /\d/.test(v));
  const fromData = (sentence: string) => scan(sentence, numeric).hits.some((h) => !typed.has(Number(h.replace(/[^\d.]/g, ""))));
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])/).filter((s) => s.trim() && !fromData(s));
  let body = "";
  for (const s of sentences.slice(0, MAX_SENTENCES)) { if ((body + " " + s).length > MAX_CHARS) break; body = body ? `${body} ${s}` : s; }
  if (!body || !/[a-z]/i.test(body)) return null;
  return sources.length ? `${body}\nSources: ${sources.slice(0, MAX_SOURCES).join(", ")}.` : body;
}

/** The fake provider's answer to a research call (no network): a canned verdict with one cited link. */
export function fakeResearch(system: string, content: string): { text: string; sources: string[] } | null {
  if (system !== RESEARCH_PROMPT) return null;
  if (!/\b(?:reviews?|worth|good|buy|recommend)\b/i.test(content)) return { text: NOT_RESEARCH, sources: [] };
  return {
    text: "Reviewers like how it holds up in rain and wind and say it lasts for years with care; the usual complaint is a slim fit. Good value if you'll wear it often. ([gearreviews.example](https://www.gearreviews.example/jacket?utm_source=test))",
    sources: ["https://trailtests.example/review"],
  };
}

export function makeResearch(deps: CloudDeps = {}): Handler {
  const ask = deps.askConsent ?? lazyConsent;
  return async (db, text, ctx): Promise<Reply> => {
    if (!webSearchAvailable()) return { text: NO_WEB, tier: "local" };
    const s = symbolizeText(db, text, { research: true });
    if (s.hers.length) return { text: HERS, tier: "local" };
    let query = s.text;
    const allow: string[] = [], consents: string[] = [];
    // A store from the user's history may be the very thing to look up: its name goes out only if they say yes.
    for (const sym of [...new Set(query.match(/\bMERCHANT_\d+\b/g) ?? [])]) {
      const real = realFor(db, sym), typed = s.originals[sym];
      if (!real || !typed) continue;
      const g = await ask(db, `research:${sym}`, CONSENT_Q, ctx);
      consents.push(`research:${sym}:${g}`);
      if (g === "deny") return { text: DECLINED, tier: "local" };
      query = query.split(sym).join(typed);
      allow.push(typed, ...merchantForms(real));
    }
    // The user's own amounts never go out: a word range says roughly what it costs.
    query = query.replace(/\bQ_AMT_\d+\b/g, (q) => (s.qsyms[q] ? `(${bucket(Number(s.qsyms[q]))})` : ""));
    const res = await egress(db, { system: RESEARCH_PROMPT, messages: [{ role: "user", content: `Look this up: ${query}` }], web_search: true, max_completion: 3000 },
      { allow, timeoutMs: researchTimeout() });
    const ledger: LedgerMeta = { question_sym: s.text, canary_checked: res.canary.checked, canary_hits: res.canary.hits.length,
      exact_disclosed: consents.filter((c) => !c.endsWith(":deny")).length, consent: consents.length ? consents.join(", ") : undefined,
      ...(res.error === "blocked" ? {} : { payload_json: res.body }) };
    if (res.error === "blocked") return { text: KEPT, tier: "cloud", ledger }; // like the planner's BLOCKED: the row records the hits, no bytes
    if (!res.sent) return { text: UNREACHABLE, tier: "local", ledger };
    if (!res.ok) return { text: UNREACHABLE, tier: "cloud", ledger };
    const r = res.response as { content?: { type: string; text?: string }[]; sources?: unknown };
    const raw = (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const cited = Array.isArray(r?.sources) ? r.sources.filter((u): u is string => typeof u === "string") : [];
    const out = raw.includes(NOT_RESEARCH) ? OFF_TOPIC : cleanVerdict(db, text, raw, s.qsyms, cited) ?? NOT_FOUND;
    return { text: activeBackend().name === "fake" ? `${RESEARCH_FAKE_LABEL} ${out}` : out, tier: "cloud", ledger };
  };
}

export const research: Handler = makeResearch();
