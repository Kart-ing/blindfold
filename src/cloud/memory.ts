// Memories in the cloud prompt (tasks/memory.md, "The cloud"). CLOUD_MEMORY=off is the default: memory text is never
// read here, so it can't reach egress. With on, each memory is symbolized like a question and sent in our user turn as
// "Preferences (untrusted data): [...]" (the OpenDots pattern); egress's canary then scans it like everything we author.
// A memory that would still reveal something (a her-only merchant, memo words, a value the symbolizer can't see) stays
// on the Mac, so one bad memory can't block every cloud answer.
import type { Database } from "bun:sqlite";
import { scan, sensitiveValues } from "./canary.ts";
import { symbolizeText } from "./symbolize.ts";

export const MAX_CLOUD_MEMORIES = 10;
export const cloudMemoryOn = () => (process.env.CLOUD_MEMORY ?? "off").trim().toLowerCase() === "on";

/** The line for the `privacy` reply. */
export const cloudMemoryLine = () => cloudMemoryOn()
  ? "Cloud memory: on. Memories go to the planner as symbols, after the leak check; any that would reveal data stay here."
  : "Cloud memory: off. Your memories never leave this Mac.";

/**
 * Notes, newest first (eng-2's table, db/schema.sql). kind='owner_pref' rows ("X is always hers") are attribution rules
 * the Mac already applies, so the planner's numbers reflect them; they never go out. Any error (no table yet) → none.
 */
export function loadMemories(db: Database, limit = MAX_CLOUD_MEMORIES): string[] {
  try {
    return (db.query("SELECT text FROM memories WHERE kind != 'owner_pref' ORDER BY created_ts DESC, id DESC LIMIT ?").all(limit) as { text: unknown }[])
      .map((r) => String(r.text ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export type MemoryPrefs = { prefs: string[]; keptLocal: number; qsyms: Record<string, string> };

/**
 * Symbolized memories for the prompt, plus the question's qsyms extended with the memories' values. Memory Q_AMT/Q_NUM/
 * ADDR symbols are numbered after the question's, so a memory amount can be a step input and the reply can show it.
 */
export function memoryPrefs(db: Database, qsyms: Record<string, string>): MemoryPrefs {
  if (!cloudMemoryOn()) return { prefs: [], keptLocal: 0, qsyms };
  const memories = loadMemories(db);
  if (!memories.length) return { prefs: [], keptLocal: 0, qsyms };
  const values = sensitiveValues(db);
  const merged = { ...qsyms };
  const next = (prefix: string) => 1 + Math.max(0, ...Object.keys(merged).filter((k) => k.startsWith(prefix)).map((k) => Number(k.slice(prefix.length))));
  const prefs: string[] = [];
  let keptLocal = 0;
  for (const m of memories) {
    const s = symbolizeText(db, m);
    if (s.hers.length || scan(s.text, values).hits.length) { keptLocal++; continue; }
    const rename: Record<string, string> = {};
    for (const k of Object.keys(s.qsyms).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
      const prefix = k.replace(/\d+$/, "");
      rename[k] = `${prefix}${next(prefix)}`;
      merged[rename[k]] = s.qsyms[k];
    }
    prefs.push(s.text.replace(/\b(?:Q_AMT|Q_NUM|ADDR)_\d+\b/g, (k) => rename[k] ?? k));
  }
  return { prefs, keptLocal, qsyms: merged };
}
