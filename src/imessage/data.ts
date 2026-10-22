// Adapter over eng-1's attribution engine (tasks/INTERFACES.md). Falls back to local stubs until those exports land.
import type { Database } from "bun:sqlite";
import * as engine from "../attribution/engine.ts";

type Owner = "me" | "her" | "shared";
const e = engine as unknown as {
  setOwner?: (db: Database, txnId: string, owner: Owner) => void;
  setPlace?: (db: Database, label: "HOME" | "WORK", address: string) => { ok: boolean; reason?: string };
  RULES?: Record<number, string>;
};

export function setOwner(db: Database, txnId: string, owner: Owner) {
  if (e.setOwner) return void e.setOwner(db, txnId, owner);
  db.run(`INSERT INTO attributions(txn_id, owner, rule, confidence, labelled_by_user, needs_prompt) VALUES (?, ?, 1, 1.0, 1, 0)
      ON CONFLICT(txn_id) DO UPDATE SET owner = excluded.owner, rule = 1, confidence = 1.0, labelled_by_user = 1, needs_prompt = 0`,
    [txnId, owner]);
}

export function setPlace(db: Database, label: "HOME" | "WORK", address: string): { ok: boolean; reason?: string } {
  if (e.setPlace) return e.setPlace(db, label, address);
  const old = db.query("SELECT address FROM places WHERE label = ?").get(label) as { address: string | null } | null;
  // A changed address makes the stored coordinates stale.
  if (old?.address === address) return { ok: true };
  db.run(`INSERT INTO places(label, address, lat, lng) VALUES (?, ?, NULL, NULL)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address, lat = NULL, lng = NULL`, [label, address]);
  return { ok: true };
}

const FALLBACK_RULES: Record<number, string> = {
  1: "Your label (prompt answer or \"that was hers/mine\")",
  2: "Apple Pay on the Amex → hers",
  3: "Ride receipt between HOME and WORK → yours",
  4: "Single-person food order → yours",
  5: "Multi-person food order → split 50/50",
  6: "Weekday 9:00–18:00 → yours",
  7: "Otherwise → yours",
};

export const rules = (): Record<number, string> => e.RULES ?? FALLBACK_RULES;
