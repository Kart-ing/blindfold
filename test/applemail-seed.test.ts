// MAIL_SOURCE=applemail through eng1's seed CLI: the switch picks Apple Mail, matching + attribution run, access errors fail soft.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, "fixtures", "mail");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { chmodSync(join(d, "Library", "Mail"), 0o700); } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

function fakeHome(withMail = true) {
  const home = mkdtempSync(join(tmpdir(), "fin-home-"));
  dirs.push(home);
  const msgs = join(home, "Library", "Mail", "V10", "ACCT", "INBOX.mbox", "S", "Data", "Messages");
  mkdirSync(msgs, { recursive: true });
  if (withMail)
    readdirSync(FIXTURES).filter((f) => f.endsWith(".eml")).sort().forEach((f, i) => {
      const body = readFileSync(join(FIXTURES, f));
      writeFileSync(join(msgs, `${i + 1}.emlx`), Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from("<plist/>\n")]));
    });
  return home;
}

function seed(dbPath: string, env: Record<string, string>) {
  const p = Bun.spawnSync([process.execPath, "run", "src/ingest/seed.ts", "--db", dbPath], {
    cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const owners = (path: string) => {
  const db = new Database(path, { readonly: true });
  const rows = db.query("SELECT txn_id, owner, rule FROM attributions ORDER BY txn_id").all();
  const receipts = db.query("SELECT id FROM receipts").all() as { id: string }[];
  const matched = (db.query("SELECT COUNT(*) AS n FROM attributions WHERE receipt_id IS NOT NULL").get() as { n: number }).n;
  db.close();
  return { rows, receipts, matched };
};

test("MAIL_SOURCE=applemail ingests Apple Mail, then matches and attributes like the fixture path", () => {
  const home = fakeHome();
  const base = seed(join(home, "fixture.db"), { MAIL_SOURCE: "fixture", HOME: home });
  expect(base.code).toBe(0);
  const am = seed(join(home, "am.db"), { MAIL_SOURCE: "applemail", HOME: home, MAIL_SINCE: "1700000000", MAIL_CACHE_DIR: join(home, "cache") });
  expect(am.code).toBe(0);
  const a = owners(join(home, "fixture.db")), b = owners(join(home, "am.db"));
  expect(b.receipts.length).toBe(a.receipts.length);
  expect(b.receipts.every((r) => r.id.startsWith("receipt-am-"))).toBe(true);
  expect(b.matched).toBe(a.matched);
  expect(b.matched).toBeGreaterThan(0);
  expect(b.rows).toEqual(a.rows);
}, 60_000);

test("MAIL_SOURCE=applemail without Full Disk Access logs and continues with no receipts", () => {
  if (process.getuid?.() === 0) return;
  const home = fakeHome();
  chmodSync(join(home, "Library", "Mail"), 0o000);
  const r = seed(join(home, "am.db"), { MAIL_SOURCE: "applemail", HOME: home, MAIL_CACHE_DIR: join(home, "cache") });
  chmodSync(join(home, "Library", "Mail"), 0o700);
  expect(r.code).toBe(0);
  expect(r.err).toContain("Full Disk Access");
  expect(owners(join(home, "am.db")).receipts.length).toBe(0);
  expect(JSON.parse(r.out).receipts).toBe(0);
}, 60_000);
