// `bun run ledger:status`: the internal ledger's maintenance view (tasks/statements.md). Masks, dates and counts only,
// never merchants or amounts. Re-parses the statement files (writes nothing) and reads data/real.db read-only if it exists.
// Env: STATEMENTS_DIR (default ../Bank Statments), FIN_REAL_DB (default data/real.db).
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseCapOne360Pdf, parseCapOneCsv, parseCitiPdf, statementFingerprint, type Statement } from "../src/ingest/statements.ts";
import { monthKey } from "../src/imessage/clock.ts";

const ROOT = join(import.meta.dir, "..");
const DIR = process.env.STATEMENTS_DIR ?? join(ROOT, "..", "Bank Statments");
const DB = process.env.FIN_REAL_DB ?? join(ROOT, "data", "real.db");
const day = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : "?");
const masked = (key: string) => key.replace(/-(\d{4}|\?{4})$/, " ••$1");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function walk(dir: string): string[] {
  return readdirSync(dir).filter((f) => !f.startsWith(".")).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  }).sort();
}

function parse(path: string): Statement | string {
  try {
    if (/\.csv$/i.test(path)) return parseCapOneCsv(readFileSync(path, "utf8"));
    if (!/\.pdf$/i.test(path)) return "not a statement file";
    const r = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    if (r.exitCode !== 0) return "pdftotext failed (is poppler installed?)";
    const text = r.stdout.toString();
    if (/Billing Period:|citicards\.com/i.test(text)) return parseCitiPdf(text, { year: new Date(statSync(path).mtimeMs).getFullYear() });
    if (/360 (Checking|Performance Savings|Savings)/.test(text)) return parseCapOne360Pdf(text);
    return "unrecognised layout";
  } catch (e) {
    return (e as Error).message;
  }
}

const out: string[] = [];
if (!existsSync(DIR)) {
  out.push(`No statements folder at ${DIR}.`);
} else {
  const files = walk(DIR);
  const seen = new Set<string>();
  const parsed: { file: string; st: Statement }[] = [];
  let dupes = 0;
  const unreadable: string[] = [];
  for (const f of files) {
    const st = parse(f);
    if (typeof st === "string") { unreadable.push(`${basename(f).replace(/\d{4,}/g, "####")}: ${st}`); continue; }
    // Same statement content (re-downloads differ only in PDF metadata) counts once.
    const fp = statementFingerprint(st);
    if (seen.has(fp)) { dupes++; continue; }
    seen.add(fp);
    parsed.push({ file: f, st });
  }
  out.push(`Statements folder: ${plural(files.length, "file")}, ${parsed.length} unique, ${plural(dupes, "duplicate")} skipped (same statement as another file)${unreadable.length ? `, ${unreadable.length} unreadable` : ""}.`);
  for (const u of unreadable) out.push(`  unreadable: ${u}`);

  // Per account: statement periods (PDFs), export coverage (CSV), recon and gaps.
  type Acc = { periods: [number, number][]; exportRange: [number, number] | null; ok: number; fail: number; rows: number };
  const accts = new Map<string, Acc>();
  const acc = (k: string) => accts.get(k) ?? (accts.set(k, { periods: [], exportRange: null, ok: 0, fail: 0, rows: 0 }), accts.get(k)!);
  for (const { st } of parsed) {
    for (const a of st.accounts) {
      const A = acc(a.key);
      const rows = st.rows.filter((r) => r.account_key === a.key);
      A.rows += rows.length;
      if (st.source === "capone_csv") {
        const ts = rows.map((r) => r.ts);
        if (ts.length) A.exportRange = [Math.min(...ts, A.exportRange?.[0] ?? Infinity), Math.max(...ts, A.exportRange?.[1] ?? -Infinity)];
      } else if (st.period_start && st.period_end) A.periods.push([st.period_start, st.period_end]);
    }
    for (const r of st.recon) r.ok ? acc(r.account_key).ok++ : acc(r.account_key).fail++;
  }
  out.push("", "Accounts:");
  for (const [key, A] of [...accts].sort(([a], [b]) => a.localeCompare(b))) {
    const periods = A.periods.sort((x, y) => x[0] - y[0]);
    const gaps: string[] = [];
    for (let i = 1; i < periods.length; i++) if (periods[i][0] - periods[i - 1][1] > 1.5 * 86_400) gaps.push(`${day(periods[i - 1][1])}→${day(periods[i][0])}`);
    const cover = periods.length ? `${plural(periods.length, "statement")} ${day(periods[0][0])}..${day(periods.at(-1)![1])}` : "";
    const exp = A.exportRange ? `card export ${day(A.exportRange[0])}..${day(A.exportRange[1])}` : "";
    const recon = A.ok + A.fail ? `, recon ${A.ok}/${A.ok + A.fail} OK` : "";
    out.push(`  ${masked(key)}: ${[cover, exp].filter(Boolean).join("; ")}, ${plural(A.rows, "row")}${recon}, gaps: ${gaps.length ? gaps.join(", ") : "none"}`);
  }

  out.push("", "Reconciliation per statement:");
  for (const { st } of parsed.filter(({ st }) => st.recon.length).sort((a, b) => (a.st.period_start ?? 0) - (b.st.period_start ?? 0))) {
    const each = st.recon.map((r) => `${masked(r.account_key)} ${r.ok ? "OK" : "FAIL"}`).join(", ");
    out.push(`  ${st.source} ${day(st.period_start)}..${day(st.period_end)}: ${each}`);
  }

  const months = new Map<string, number>();
  let hinted = 0, total = 0;
  for (const { st } of parsed) for (const r of st.rows) { months.set(monthKey(r.ts), (months.get(monthKey(r.ts)) ?? 0) + 1); total++; if (r.category_hint) hinted++; }
  out.push("", `Parsed rows per month: ${[...months].sort().map(([m, n]) => `${m} ${n}`).join(", ") || "none"} (${total} rows, ${hinted} with a category from the statement text)`);
}

// The integrated ledger (eng1's seed-real), if built.
out.push("");
if (!existsSync(DB)) {
  out.push(`Ledger DB: ${DB.replace(ROOT + "/", "")} not built yet.`);
} else {
  const db = new Database(DB, { readonly: true });
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  out.push(`Ledger DB: ${DB.replace(ROOT + "/", "")}`);
  if (has("ingest_log")) out.push(`  imports: ${n("SELECT COUNT(*) AS n FROM ingest_log")}, recon OK ${n("SELECT COUNT(*) AS n FROM ingest_log WHERE recon_ok = 1")}, failed ${n("SELECT COUNT(*) AS n FROM ingest_log WHERE recon_ok = 0")}`);
  if (has("accounts")) out.push(`  accounts: ${(db.query("SELECT mask FROM accounts ORDER BY id").all() as { mask: string | null }[]).map((a) => `••${a.mask ?? "????"}`).join(", ") || "none"}`);
  if (has("transactions")) {
    const per = new Map<string, number>();
    for (const { ts } of db.query("SELECT ts FROM transactions").all() as { ts: number }[]) per.set(monthKey(ts), (per.get(monthKey(ts)) ?? 0) + 1);
    out.push(`  transactions per month: ${[...per].sort().map(([m, c]) => `${m} ${c}`).join(", ") || "none"}`);
    out.push(`  uncategorised: ${n("SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL OR category = ''")} of ${n("SELECT COUNT(*) AS n FROM transactions")}`);
  }
  db.close();
}
console.log(out.join("\n"));
