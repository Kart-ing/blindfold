import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.FIN_DB ?? join(import.meta.dir, "..", "data", "fin.db");

export function openDb(path = DB_PATH): Database {
  const db = new Database(path, { create: true });
  db.exec(readFileSync(join(import.meta.dir, "..", "db", "schema.sql"), "utf8"));
  return db;
}
