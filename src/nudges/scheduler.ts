// Nudge scheduler (PRD §6). Guardrails: nudges on, not quiet hours, ≤1 per tick, ≤2 a day, each trigger once per period (UNIQUE(kind, period_key)).
import type { Database } from "bun:sqlite";
import { isQuiet, startOfDay } from "../imessage/clock.ts";
import { localModelsOn, type Fm } from "../imessage/fm.ts";
import { phrase } from "../voice/phrase.ts";
import { commuteRides, dinnerDelivery, newRecurring, type Candidate } from "./triggers.ts";

export const MAX_NUDGES_PER_DAY = 2;

export type TickResult = { fired: { kind: string; text: string }[]; skipped: string[] };
// fm words nudges through phrase() (placeholder-only templates, strictly validated); without it, the fallback text.
export type SchedulerDeps = { send: (text: string) => Promise<void>; fm?: Fm };

const digitRuns = (s: string) => s.match(/\d+/g) ?? [];

/**
 * Checks a model rephrase against its template. Not used for outbound text: nudges and prompts always go out
 * as the fixed template (a "Sure! Here's the text…" preamble once slipped through a digits-only check).
 * Kept for any future on-device wording, which must pass all of these.
 */
export function acceptRephrase(template: string, candidate: string | null): string {
  if (!candidate) return template;
  const c = candidate.trim();
  if (!c || /[\r\n]/.test(c) || /\bhere\b|here's/i.test(c) || c.length > template.length * 1.3) return template;
  const a = digitRuns(template), b = digitRuns(c);
  return a.length === b.length && a.every((d, i) => d === b[i]) ? c : template;
}

export const nudgesOn = (db: Database) =>
  (db.query("SELECT value FROM settings WHERE key = 'nudges'").get() as { value: string } | null)?.value !== "off";

export async function runScheduler(db: Database, now: number, deps: SchedulerDeps): Promise<TickResult> {
  const res: TickResult = { fired: [], skipped: [] };
  if (!nudgesOn(db)) return { ...res, skipped: ["nudges off"] };
  if (isQuiet(now)) return { ...res, skipped: ["quiet hours"] };

  const candidates: Candidate[] = [];
  for (const f of [dinnerDelivery, commuteRides]) {
    const c = f(db, now);
    if (c) candidates.push(c);
  }
  candidates.push(...newRecurring(db, now));
  if (!candidates.length) res.skipped.push("no trigger");

  // At most one nudge per tick, by priority (dinner > commute > new_recurring); the rest wait for a later tick.
  for (const c of candidates) {
    if (res.fired.length) { res.skipped.push(`${c.kind}: waits for a later tick`); continue; }
    const today = (db.query("SELECT COUNT(*) AS n FROM nudges WHERE ts >= ? AND ts <= ?").get(startOfDay(now), now) as { n: number }).n;
    if (today >= MAX_NUDGES_PER_DAY) { res.skipped.push(`${c.kind}: daily limit`); continue; }
    if (db.query("SELECT 1 FROM nudges WHERE kind = ? AND period_key = ?").get(c.kind, c.periodKey)) {
      res.skipped.push(`${c.kind}: already sent for ${c.periodKey}`);
      continue;
    }
    // Worded on the device when VOICE=device and the template passes validation; otherwise the fallback (c.text).
    const text = (await phrase(c.kind, c.situation, c.facts, c.fallback, { fm: localModelsOn() ? deps.fm : null })).text;
    // Claim the (kind, period) slot before sending; release it if the send fails so a later tick retries.
    const ins = db.run("INSERT OR IGNORE INTO nudges(kind, period_key, ts, text, txn_ids) VALUES (?, ?, ?, ?, ?)",
      [c.kind, c.periodKey, now, text, JSON.stringify(c.txnIds)]);
    if (!ins.changes) { res.skipped.push(`${c.kind}: already sent for ${c.periodKey}`); continue; }
    try {
      await deps.send(text);
      res.fired.push({ kind: c.kind, text });
    } catch (e) {
      db.run("DELETE FROM nudges WHERE id = ?", [ins.lastInsertRowid]);
      res.skipped.push(`${c.kind}: send failed`);
    }
  }
  return res;
}
