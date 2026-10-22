// Memory v1 (tasks/memory.md): what the agent remembers lives in the local DB only, readable and deletable by text.
// The table design follows CopilotKit/OpenDots (MIT; see THIRD_PARTY_NOTICES.md): memories with save, list, delete.
import type { Database } from "bun:sqlite";

/** Same statement the lead adds to db/schema.sql; idempotent, so it's safe before and after that lands. */
export const MEMORY_DDL = `CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note', merchant TEXT, owner TEXT, txn_ids TEXT);`;

const ready = new WeakSet<Database>();
export function ensureMemories(db: Database) {
  if (ready.has(db)) return;
  db.exec(MEMORY_DDL);
  ready.add(db);
}

export type Memory = { id: number; text: string; created_ts: number; kind: "note" | "owner_pref" | "asset"; merchant: string | null; owner: string | null; txn_ids: string | null };

export function saveMemory(db: Database, m: { text: string; now: number; kind?: Memory["kind"]; merchant?: string; owner?: string; txnIds?: string[] }): number {
  ensureMemories(db);
  return Number(db.run("INSERT INTO memories(text, created_ts, kind, merchant, owner, txn_ids) VALUES (?, ?, ?, ?, ?, ?)",
    [m.text, m.now, m.kind ?? "note", m.merchant ?? null, m.owner ?? null, m.txnIds ? JSON.stringify(m.txnIds) : null]).lastInsertRowid);
}

/** Newest first: the order `memories` shows and `forget <n>` counts in. */
export function listMemories(db: Database): Memory[] {
  ensureMemories(db);
  return db.query("SELECT * FROM memories ORDER BY created_ts DESC, id DESC").all() as Memory[];
}

export function deleteMemory(db: Database, id: number) {
  ensureMemories(db);
  // An outside balance ("Robinhood: about $10,000") lives in manual_assets, linked to its memory: forget removes both,
  // and takes it back out of the active goal's starting point (where adding it put it).
  try {
    const a = db.query("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM manual_assets WHERE memory_id = ?").get(id) as { v: number };
    if (a.v) db.run("UPDATE goals SET savings_at_creation_cents = savings_at_creation_cents - ? WHERE active = 1", [a.v]);
    db.run("DELETE FROM manual_assets WHERE memory_id = ?", [id]);
  } catch { /* no manual_assets table yet */ }
  try { db.run("DELETE FROM facts WHERE memory_id = ?", [id]); } catch { /* no facts table yet */ } // a stored fact goes with it
  db.run("DELETE FROM memories WHERE id = ?", [id]);
}
