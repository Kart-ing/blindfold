// Consent prompts for cloud disclosures (tasks/INTERFACES.md). eng-3's cloud path awaits askConsent().
// The answer arrives as a later inbound message, so main.ts offers each inbound text to takeConsentAnswer()
// before queueing it behind the (blocked) handler that is waiting here.
import type { Database } from "bun:sqlite";
import type { Ctx } from "../handlers/types.ts";
import { looksLikeAnswer } from "./commands.ts";

export type Grant = "once" | "always" | "deny";
const CHOICES: Record<string, Grant> = { "1": "once", "2": "always", "3": "deny" };

let sender: ((text: string) => Promise<void>) | null = null;
/** main.ts wires the transport in; without one, consent is always denied. */
export function setConsentSender(send: ((text: string) => Promise<void>) | null) { sender = send; }

type Waiter = { promptId: number; scope: string; text: string; resolve: (g: Grant) => void; db: Database; cancel: () => void };
let waiter: Waiter | null = null;

export const consentPending = () => waiter !== null;

export async function askConsent(db: Database, scope: string, question: string, ctx: Ctx): Promise<Grant> {
  const stored = db.query("SELECT grant_kind FROM consents WHERE scope = ?").get(scope) as { grant_kind: string } | null;
  if (stored?.grant_kind === "always") return "always";
  if (!sender || waiter) return "deny"; // one consent question at a time
  const text = `${question} 1=once 2=always 3=no`;
  const promptId = Number(db.run("INSERT INTO prompts(kind, ref, text, sent_ts) VALUES ('consent', ?, ?, ?)", [scope, text, ctx.now]).lastInsertRowid);
  const timeoutMs = Number(process.env.CONSENT_TIMEOUT_MS ?? 120_000);
  return new Promise<Grant>((resolve) => {
    const timer = setTimeout(() => finish("deny", "timeout"), timeoutMs);
    const finish = (g: Grant, answered: string) => {
      clearTimeout(timer);
      if (waiter?.promptId !== promptId) return;
      waiter = null;
      db.run("UPDATE prompts SET answered = ?, answered_ts = ? WHERE id = ?", [answered, ctx.now, promptId]);
      if (g === "always") db.run(`INSERT INTO consents(scope, grant_kind, ts) VALUES (?, 'always', ?)
          ON CONFLICT(scope) DO UPDATE SET grant_kind = 'always', ts = excluded.ts`, [scope, ctx.now]);
      resolve(g);
    };
    waiter = { promptId, scope, text, db, resolve: (g) => finish(g, g), cancel: () => finish("deny", "reset") };
    Promise.resolve().then(() => sender!(text)).catch(() => finish("deny", "send_failed"));
  });
}

/**
 * Offers an inbound text to the pending consent question. Returns the reply to send, or null if the text
 * is not for it (route normally). Bare 1/2/3 answers it; other short answer-like texts re-ask.
 */
export function takeConsentAnswer(text: string): string | null {
  if (!waiter) return null;
  const t = text.trim().replace(/[.!?]+$/, "");
  const g = CHOICES[t];
  if (g) {
    const scope = waiter.scope;
    waiter.resolve(g);
    return g === "deny" ? "OK, not sending that." : g === "always" ? `OK. ${scope} is allowed from now on. Text "revoke ${scope}" to undo.` : "OK, just this once.";
  }
  return looksLikeAnswer(t) ? `No stress. ${waiter.text}` : null;
}

/** Tests: drop any waiter. */
export function resetConsent() { waiter?.cancel(); waiter = null; sender = null; }
