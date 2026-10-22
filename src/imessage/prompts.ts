// Low-confidence "who paid?" prompts (PRD §4). One pending at a time, at most 3 a day, answers are rule-1 labels.
import type { Database } from "bun:sqlite";
import { isQuiet, money, startOfDay } from "./clock.ts";
import { setOwner } from "./data.ts";

export const MAX_PROMPTS_PER_DAY = 3;
const OWNERS = { 1: "me", 2: "her", 3: "shared" } as const;

type Pending = { id: number; ref: string; text: string };

export function pendingPrompt(db: Database): Pending | null {
  return db.query("SELECT id, ref, text FROM prompts WHERE kind = 'who_paid' AND answered IS NULL ORDER BY id DESC LIMIT 1").get() as Pending | null;
}

/** The question, in the one soft style used everywhere: "was that $159 Nordstrom yours? 1 me · 2 her · 3 split". */
const ask = (merchant: string | null, cents: number) => `was that ${money(cents)} ${merchant ?? "charge"} yours? 1 me · 2 her · 3 split`;
export const promptText = (merchant: string | null, cents: number) => `Quick one: ${ask(merchant, cents)}`;

/** Sends the next prompt if allowed. Returns the text sent, or null. */
export async function maybePrompt(db: Database, now: number, send: (t: string) => Promise<void>): Promise<string | null> {
  if (isQuiet(now) || pendingPrompt(db)) return null;
  const today = (db.query("SELECT COUNT(*) AS n FROM prompts WHERE kind = 'who_paid' AND sent_ts >= ? AND sent_ts <= ?")
    .get(startOfDay(now), now) as { n: number }).n;
  if (today >= MAX_PROMPTS_PER_DAY) return null;
  const row = db.query(`SELECT t.id, t.merchant, t.amount_cents FROM attributions a JOIN transactions t ON t.id = a.txn_id
      WHERE a.needs_prompt = 1 AND a.labelled_by_user = 0 AND t.ts <= ?
        AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.kind = 'who_paid' AND p.ref = t.id)
      ORDER BY t.ts DESC LIMIT 1`).get(now) as { id: string; merchant: string | null; amount_cents: number } | null;
  if (!row) return null;
  const text = promptText(row.merchant, row.amount_cents);
  // Claim the pending slot first; if the send fails, release it so the next tick retries.
  const id = db.run("INSERT INTO prompts(kind, ref, text, sent_ts) VALUES ('who_paid', ?, ?, ?)", [row.id, text, now]).lastInsertRowid;
  try {
    await send(text);
  } catch (e) {
    db.run("DELETE FROM prompts WHERE id = ?", [id]);
    throw e;
  }
  return text;
}

export function answerPrompt(db: Database, choice: 1 | 2 | 3, now: number): string {
  const p = pendingPrompt(db);
  if (!p) return "Nothing to answer right now.";
  const owner = OWNERS[choice];
  db.transaction(() => {
    setOwner(db, p.ref, owner);
    db.run("UPDATE prompts SET answered = ?, answered_ts = ? WHERE id = ?", [String(choice), now, p.id]);
  })();
  return owner === "me" ? "Got it: yours." : owner === "her" ? "Got it: hers. It won't count toward your spending." : "Got it: split 50/50.";
}

/** "that was hers/mine": relabels the most recently prompted transaction, else the newest flagged one. */
export function relabelLast(db: Database, owner: "me" | "her" | "shared", now: number): string {
  const p = db.query("SELECT id, ref FROM prompts WHERE kind = 'who_paid' ORDER BY id DESC LIMIT 1").get() as { id: number; ref: string } | null;
  const ref = p?.ref ?? (db.query(`SELECT t.id FROM attributions a JOIN transactions t ON t.id = a.txn_id
      WHERE a.needs_prompt = 1 ORDER BY t.ts DESC LIMIT 1`).get() as { id: string } | null)?.id;
  if (!ref) return "Nothing flagged to relabel.";
  const t = db.query("SELECT merchant, amount_cents FROM transactions WHERE id = ?").get(ref) as { merchant: string | null; amount_cents: number } | null;
  db.transaction(() => {
    setOwner(db, ref, owner);
    if (p) db.run("UPDATE prompts SET answered = COALESCE(answered, ?), answered_ts = COALESCE(answered_ts, ?) WHERE id = ?",
      [owner === "me" ? "1" : owner === "her" ? "2" : "3", now, p.id]);
  })();
  const who = owner === "me" ? "yours" : owner === "her" ? "hers" : "split";
  return `Relabelled ${t?.merchant ?? "that charge"} ${t ? money(t.amount_cents) : ""} as ${who}.`.replace(/ {2,}/g, " ");
}

// ---- Replies to a pending who-paid question that aren't a bare 1/2/3 (tasks/voice.md) ----

/** "me"/"mine" → 1, "her"/"hers" → 2, "split"/"both"/"shared"/"half" → 3, as the whole reply. */
export function answerWord(raw: string): 1 | 2 | 3 | null {
  const t = raw.trim().toLowerCase().replace(/[.!?]+$/, "");
  return ({ me: 1, mine: 1, her: 2, hers: 2, split: 3, both: 3, shared: 3, half: 3 } as Record<string, 1 | 2 | 3>)[t] ?? null;
}

/** "idk", "not sure", "no idea", "dunno", "don't know", also inside a short reply ("nah fam idk what that is"). */
export const isIdk = (raw: string) =>
  raw.trim().split(/\s+/).length <= 10 && /\b(idk|idek|dunno|no idea|not sure|unsure|no clue|don'?t know|dont know|do not know)\b/i.test(raw);

export const KEEP_AS_MINE = "No problem, I'll keep it as yours for now. Text 'that was hers' if it turns out to be hers.";

/** "idk": close the question and keep the charge as mine (an unlabelled default, not a rule-1 label). */
export function keepAsMine(db: Database, now: number): string {
  const p = pendingPrompt(db);
  if (!p) return "Nothing to answer right now.";
  db.transaction(() => {
    db.run(`UPDATE attributions SET needs_prompt = 0, owner = CASE WHEN owner IN ('me', 'her', 'shared') THEN owner ELSE 'me' END
      WHERE txn_id = ?`, [p.ref]);
    db.run("UPDATE prompts SET answered = 'idk', answered_ts = ? WHERE id = ?", [now, p.id]);
  })();
  return KEEP_AS_MINE;
}

/** The pending question in a softer voice: "was that $42.75 Uber yours? 1 me · 2 her · 3 split". */
export function softAsk(db: Database, p: { ref: string }): string {
  const t = db.query("SELECT merchant, amount_cents FROM transactions WHERE id = ?").get(p.ref) as { merchant: string | null; amount_cents: number } | null;
  return t ? ask(t.merchant, t.amount_cents) : "was that charge yours? 1 me · 2 her · 3 split";
}

// Re-ask at most once per question: remembered in settings so a restart doesn't nag again.
export const reasked = (db: Database, p: { id: number }) =>
  (db.query("SELECT value FROM settings WHERE key = 'prompt_reasked'").get() as { value: string } | null)?.value === String(p.id);
export const markReasked = (db: Database, p: { id: number }) =>
  db.run("INSERT INTO settings(key, value) VALUES ('prompt_reasked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(p.id)]);
