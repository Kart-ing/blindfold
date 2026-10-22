// Balances the user tells us about by text ("I have ~10k in Robinhood"): manual_assets + a linked memory, so
// "memories" shows it and forget removes it. Money already had isn't progress: the active goal's starting point
// moves with it. Telling us again about the same account replaces the amount (no double counting).
import type { Database } from "bun:sqlite";
import { friendlyUsd } from "../handlers/afford.ts";
import { saveMemory } from "./store.ts";

export function addAsset(db: Database, name: string, cents: number, now: number): { replaced: boolean } {
  let replaced = false;
  db.transaction(() => {
    const old = db.query("SELECT id, amount_cents, memory_id FROM manual_assets WHERE LOWER(name) = LOWER(?) ORDER BY id DESC LIMIT 1").get(name) as
      { id: number; amount_cents: number; memory_id: number | null } | null;
    const text = `${name}: about ${friendlyUsd(cents)}`;
    if (old) {
      replaced = true;
      db.run("UPDATE manual_assets SET amount_cents = ?, created_ts = ? WHERE id = ?", [cents, now, old.id]);
      if (old.memory_id) db.run("UPDATE memories SET text = ?, created_ts = ? WHERE id = ?", [text, now, old.memory_id]);
      db.run("UPDATE goals SET savings_at_creation_cents = savings_at_creation_cents + ? WHERE active = 1", [cents - old.amount_cents]);
    } else {
      const memoryId = saveMemory(db, { text, now, kind: "asset" });
      db.run("INSERT INTO manual_assets(name, amount_cents, created_ts, memory_id) VALUES (?, ?, ?, ?)", [name, cents, now, memoryId]);
      db.run("UPDATE goals SET savings_at_creation_cents = savings_at_creation_cents + ? WHERE active = 1", [cents]);
    }
  })();
  return { replaced };
}
