// Exact commands, parsed before any model sees the text. Pure: no DB access here.
export type Command =
  | { kind: "ledger" } | { kind: "privacy" } | { kind: "rules" }
  | { kind: "revoke"; scope: string }
  | { kind: "nudges"; on: boolean }
  | { kind: "place"; label: "HOME" | "WORK"; address: string }
  | { kind: "goal" }
  | { kind: "relabel"; owner: "me" | "her" | "shared" }
  | { kind: "answer"; choice: 1 | 2 | 3 }
  | { kind: "tick"; at: string };

export function parseCommand(raw: string, opts: { cli?: boolean } = {}): Command | null {
  const text = raw.trim().replace(/\s+/g, " ");
  const t = text.toLowerCase().replace(/[.!?]+$/, "");
  if (t === "ledger") return { kind: "ledger" };
  if (t === "privacy") return { kind: "privacy" };
  if (t === "rules") return { kind: "rules" };
  if (t === "stop nudges") return { kind: "nudges", on: false };
  if (t === "nudges on") return { kind: "nudges", on: true };
  if (/^[123]$/.test(t)) return { kind: "answer", choice: Number(t) as 1 | 2 | 3 };
  let m = /^revoke ([a-z0-9_:\-]+)$/.exec(t);
  if (m) return { kind: "revoke", scope: m[1] };
  m = /^(home|work) is (.+)$/i.exec(text);
  if (m) return { kind: "place", label: m[1].toUpperCase() as "HOME" | "WORK", address: m[2].trim() };
  if (/^goal \$?[\d,.]+k? by [a-z]+\.?( \d{4})?$/.test(t)) return { kind: "goal" };
  m = /^that was (hers|mine|shared|split)$/.exec(t);
  if (m) return { kind: "relabel", owner: m[1] === "hers" ? "her" : m[1] === "mine" ? "me" : "shared" };
  m = /^tick (\d{1,2}:\d{2})$/.exec(t);
  if (m && opts.cli) return { kind: "tick", at: m[1] };
  return null;
}

/**
 * A short, non-question reply that, while a 1/2/3 question is pending, is almost surely about it: "idk", "nah fam
 * idk what that is", "not mine". (Live Oct 22: that first one went to the cloud planner and took 18s.)
 * Anything with "?" or that opens like a question ("what changed…", "how much…") is a real question, not this.
 */
export const looksLikePromptReply = (raw: string) => {
  const t = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!t || t.includes("?") || t.length > 60 || t.split(/\s+/).length > 8) return false;
  return !/^(what|what's|whats|how|why|when|where|which|who|can|could|should|would|will|is|are|am|do|does|did|tell|show|list|give)\b/.test(t);
};

/** Short replies that look like an attempt to answer a pending 1/2/3 prompt. */
export const looksLikeAnswer = (raw: string) =>
  /^(\d+|me|mine|her|hers|split|shared|both|yes|no|y|n)$/i.test(raw.trim().replace(/[.!?]+$/, ""));

/** Small talk that deserves a friendly local reply, never a planner call or a "Reply 1, 2 or 3". */
export function greetingKind(raw: string): "hello" | "thanks" | "ack" | null {
  const t = raw.trim().toLowerCase().replace(/[!.,\s]+$/u, "");
  if (/^(hi|hello|hey|heya|hiya|yo|sup|gm|good (morning|afternoon|evening)|what'?s up|whats up|wassup|(hi|hey|hello) there)$/.test(t)) return "hello";
  if (/^(thanks|thank you|thank u|thx|ty|tysm|thanks a lot|🙏)$/u.test(t)) return "thanks";
  if (/^(ok|okay|k|kk|cool|nice|great|got it|sounds good|👍|👌|🙌)$/u.test(t)) return "ack";
  return null;
}
