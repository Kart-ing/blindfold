// Facts the user states ("I quit Jan 1", "about 6k in my checking"), stored with a value the Mac computed from Sol's
// expression. Sol only ever sees each fact's name, unit and description; the value stays here. Each fact is tied to
// a memories row, so "memories" lists it and "forget N" / "forget everything" / reset-user remove it.
import type { Database } from "bun:sqlite";
import type { Unit } from "../calc/types.ts";
import { ensureMemories } from "./store.ts";

export const FACTS_DDL = `CREATE TABLE IF NOT EXISTS facts(name TEXT PRIMARY KEY, unit TEXT NOT NULL, value REAL NOT NULL, desc TEXT NOT NULL,
  created_ts INTEGER NOT NULL, memory_id INTEGER);`;
const ready = new WeakSet<Database>();
export function ensureFacts(db: Database) {
  if (ready.has(db)) return;
  db.exec(FACTS_DDL);
  ensureMemories(db);
  ready.add(db);
}

export type StoredFact = { name: string; unit: Unit; value: number; desc: string; created_ts: number; memory_id: number | null };

export function listFacts(db: Database): StoredFact[] {
  ensureFacts(db);
  return db.query("SELECT name, unit, value, desc, created_ts, memory_id FROM facts ORDER BY created_ts, name").all() as StoredFact[];
}

/**
 * Stores (or replaces, by name) a fact. Its memories row reads "<desc>" so the user can see and forget it; the
 * text is the description Sol wrote (symbols, no values), the value shown on "memories" is rendered locally.
 */
export function storeFact(db: Database, f: { name: string; unit: Unit; value: number; desc: string }, now: number): void {
  ensureFacts(db);
  db.transaction(() => {
    const old = db.query("SELECT memory_id FROM facts WHERE name = ?").get(f.name) as { memory_id: number | null } | null;
    let memoryId = old?.memory_id ?? null;
    if (memoryId !== null && db.query("SELECT 1 FROM memories WHERE id = ?").get(memoryId))
      db.run("UPDATE memories SET text = ?, created_ts = ? WHERE id = ?", [f.desc, now, memoryId]);
    else memoryId = Number(db.run("INSERT INTO memories(text, created_ts, kind, merchant) VALUES (?, ?, 'note', ?)", [f.desc, now, `fact:${f.name}`]).lastInsertRowid);
    db.run(`INSERT INTO facts(name, unit, value, desc, created_ts, memory_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET unit = excluded.unit, value = excluded.value, desc = excluded.desc, created_ts = excluded.created_ts,
        memory_id = excluded.memory_id`, [f.name, f.unit, f.value, f.desc, now, memoryId]);
  })();
}

/** Forget by name (Sol's forget_facts): the fact and its memories row. */
export function forgetFact(db: Database, name: string): boolean {
  ensureFacts(db);
  const row = db.query("SELECT memory_id FROM facts WHERE name = ?").get(name) as { memory_id: number | null } | null;
  if (!row) return false;
  db.transaction(() => {
    db.run("DELETE FROM facts WHERE name = ?", [name]);
    if (row.memory_id !== null) db.run("DELETE FROM memories WHERE id = ?", [row.memory_id]);
  })();
  return true;
}

/** "forget N" on a memory that is a fact: drop the fact too. */
export function forgetFactsOfMemory(db: Database, memoryId: number): void {
  ensureFacts(db);
  db.run("DELETE FROM facts WHERE memory_id = ?", [memoryId]);
}
