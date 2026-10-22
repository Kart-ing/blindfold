// `bun run demo:reset`: reseed the demo DB in place between rehearsals. Clears rows instead of deleting the file,
// so a running panel and agent keep working on the same database.
import { join } from "node:path";
import { openDb } from "../src/db";
import { seed } from "../src/ingest/seed";

export const DEMO_DB = process.env.FIN_DB ?? join(import.meta.dir, "../data/fin.db");

export function reset(path = DEMO_DB) {
  const db = openDb(path);
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(t => t.name);
  db.transaction(() => { for (const t of tables) db.run(`DELETE FROM ${t}`); })();
  const summary = seed(db);
  db.close();
  return summary;
}

if (import.meta.main) console.log("[reset]", JSON.stringify(reset()));
