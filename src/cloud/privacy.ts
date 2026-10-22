// What went to the cloud today, as symbol names only (never the real values behind them). Read from the ledger,
// i.e. from exactly the bytes egress sent. For the `ledger` command and the panel.
import type { Database } from "bun:sqlite";
import { startOfDay } from "../imessage/clock.ts";

const SYMBOL = /\b(?:MERCHANT|ACCOUNT|PERSON|ADDR)_\d+\b|\bQ_(?:AMT|NUM)_\d+\b|\b(?:HOME|WORK)\b/g;

export type SentToday = { calls: number; symbols: string[]; byKind: Record<string, number>; exact: number; partial: number; blocked: number; fake: number };

/** Symbols in the user/assistant turns of today's cloud payloads. The static system prompt is skipped (top-level or a system message). */
export function symbolsSentToday(db: Database, now: number): SentToday {
  const rows = db.query("SELECT payload_json, exact_disclosed, partial_count, canary_hits FROM ledger WHERE tier = 'cloud' AND ts >= ? AND ts <= ?")
    .all(startOfDay(now), now) as { payload_json: string | null; exact_disclosed: number; partial_count: number; canary_hits: number | null }[];
  const seen = new Set<string>();
  let calls = 0, exact = 0, partial = 0, blocked = 0, fake = 0;
  for (const r of rows) {
    exact += r.exact_disclosed ?? 0;
    partial += r.partial_count ?? 0;
    if ((r.canary_hits ?? 0) > 0) blocked++;
    if (!r.payload_json) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(r.payload_json); } catch { continue; }
    for (const body of Array.isArray(parsed) ? parsed : [parsed]) {
      // The fake planner's bodies never left the Mac: count them apart, and their symbols were never "sent".
      if ((body as { provider?: string })?.provider === "fake") { fake++; continue; }
      calls++;
      for (const m of (body as { messages?: { role?: string; content?: unknown }[] })?.messages ?? []) {
        // Chat Completions carries the static system prompt as a message; its "HOME, WORK" and "{Q_AMT_1}" are docs, not data sent.
        if (m.role === "system") continue;
        // Messages and Chat Completions shapes: content is a string. Bedrock Converse: content is [{text}].
        const c = m.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string })?.text ?? "").join("\n") : "";
        for (const s of text.match(SYMBOL) ?? []) seen.add(s);
      }
    }
  }
  const symbols = [...seen].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const byKind: Record<string, number> = {};
  for (const s of symbols) { const k = s.replace(/_\d+$/, ""); byKind[k] = (byKind[k] ?? 0) + 1; }
  return { calls, symbols, byKind, exact, partial, blocked, fake };
}

/** One iMessage-sized line: "Cloud today: 2 calls. Sent as symbols only: MERCHANT_4, Q_AMT_1, WORK. 0 exact values, 1 partial." */
export function privacyLine(db: Database, now: number): string {
  const s = symbolsSentToday(db, now);
  const fakeNote = s.fake ? ` ${s.fake} answered by the fake planner (demo mode: canned plans, nothing sent).` : "";
  if (!s.calls && !s.blocked) return `Cloud today: nothing left your Mac.${fakeNote}`;
  const list = s.symbols.length ? `Sent as symbols only: ${s.symbols.slice(0, 12).join(", ")}${s.symbols.length > 12 ? ` (+${s.symbols.length - 12} more)` : ""}.` : "No symbols sent, just the question shape.";
  const blocked = s.blocked ? ` ${s.blocked} blocked by the leak check.` : "";
  return `Cloud today: ${s.calls} call${s.calls === 1 ? "" : "s"}. ${list} ${s.exact} exact value${s.exact === 1 ? "" : "s"}, ${s.partial} partial.${blocked}${fakeNote}`;
}
