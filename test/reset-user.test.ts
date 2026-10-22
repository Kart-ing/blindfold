import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { addAsset } from "../src/memory/assets.ts";

const p = join(tmpdir(), `fin-reset-user-${process.pid}-${Date.now()}.db`);
afterAll(() => { for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true }); });

test("reset-user clears balances the user told us (manual_assets) and the runway scenario; imported accounts stay", () => {
  const db = openDb(p);
  db.run("INSERT INTO accounts(id, name, type, subtype, shared, owner, balance_cents) VALUES ('sav', 'Savings', 'depository', 'savings', 0, 'me', 600000)");
  addAsset(db, "Robinhood", 1000000, 1_790_000_000);
  db.run("INSERT INTO settings(key, value) VALUES ('runway_scenario', '{}')");
  db.close();
  const r = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "..", "scripts", "reset-user.ts"), "--db", p]);
  expect(r.exitCode).toBe(0);
  const after = openDb(p);
  const n = (sql: string) => (after.query(sql).get() as { n: number }).n;
  expect(n("SELECT COUNT(*) AS n FROM manual_assets")).toBe(0);
  expect(n("SELECT COUNT(*) AS n FROM memories")).toBe(0);
  expect(n("SELECT COUNT(*) AS n FROM settings")).toBe(0);
  expect(n("SELECT COUNT(*) AS n FROM accounts")).toBe(1);
});
