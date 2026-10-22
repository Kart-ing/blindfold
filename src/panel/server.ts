// "What the cloud saw" demo panel. Local only: binds 127.0.0.1, reads the DB, never calls out.
import { openDb } from "../db";
import { MY_SHARE, goalStatus, isSpend, manualAssetsCents, ptMonthStart, totalsBetween } from "../handlers/finance";
import { symbolsSentToday } from "../cloud/privacy";

const PORT = Number(process.env.PANEL_PORT ?? 4545);
const db = openDb();

// Bare 1/2/3 answers and re-prompts are logged as intent 'command'; like the `ledger` reply, the panel counts only real questions.
// eng1 owns rule names; fall back to numbers until src/attribution/engine.ts lands.
let RULES: Record<number, string> = {};
try { RULES = (await import("../attribution/engine")).RULES ?? {}; } catch {}

function feed() {
  const ledger = db.query(`SELECT id, ts, tier, intent, question_sym, payload_json, exact_disclosed, partial_count,
      canary_checked, canary_hits, consent FROM ledger WHERE COALESCE(intent, '') <> 'command' ORDER BY id DESC LIMIT 40`).all();
  // A fake-planner answer (demo fallback) never left the Mac, so it doesn't count as cloud.
  const totals = db.query(`SELECT COUNT(*) AS answers,
      COALESCE(SUM(tier = 'cloud' AND instr(COALESCE(payload_json, ''), '"provider":"fake"') = 0), 0) AS cloud, COALESCE(SUM(exact_disclosed), 0) AS exact,
      COALESCE(SUM(partial_count), 0) AS partial, COALESCE(SUM(canary_hits > 0), 0) AS blocked FROM ledger WHERE COALESCE(intent, '') <> 'command'`).get();
  const attributions = db.query(`SELECT t.id, t.ts, t.amount_cents, t.merchant, t.wallet, acc.name AS account,
      a.owner, a.rule, a.confidence, a.labelled_by_user, a.needs_prompt, r.pickup_label, r.dropoff_label, r.items
      FROM transactions t JOIN accounts acc ON acc.id = t.account_id
      LEFT JOIN attributions a ON a.txn_id = t.id LEFT JOIN receipts r ON r.id = a.receipt_id
      WHERE acc.shared = 1 ORDER BY t.ts DESC LIMIT 25`).all()
    .map((r: any) => ({ ...r, reason: r.labelled_by_user ? "you said so" : RULES[r.rule] ?? (r.rule ? `rule ${r.rule}` : "unattributed") }));
  const share = db.query(`SELECT COALESCE(a.owner, 'me') AS owner, COUNT(*) AS n,
      COALESCE(SUM(t.amount_cents), 0) AS cents FROM transactions t JOIN accounts acc ON acc.id = t.account_id
      LEFT JOIN attributions a ON a.txn_id = t.id WHERE acc.shared = 1 GROUP BY 1`).all();
  const nudges = db.query("SELECT kind, ts, text FROM nudges ORDER BY ts DESC LIMIT 5").all();
  // Memory v1: everything the agent remembers, as the user sees it with "memories" (owner_pref rows change attribution).
  const memories = db.query("SELECT id, text, kind, merchant, owner, created_ts FROM memories ORDER BY created_ts DESC, id DESC LIMIT 10").all();
  // Panel reads the wall clock; the agent's demo clock only affects what the agent does.
  const sentToday = symbolsSentToday(db, Math.floor(Date.now() / 1000));
  return { ledger, totals, attributions, share, nudges, memories, sentToday, mySharePolicy: MY_SHARE };
}

// The live ledger: the money side of whatever DB the agent runs on (fixture or real). Read-only, local only.
function ledgerFeed() {
  const now = Math.floor(Date.now() / 1000);
  const ptNow = new Date(new Date(now * 1000).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const months = [3, 2, 1, 0].map((back) => {
    const y = ptNow.getFullYear(), m = ptNow.getMonth() - back;
    const start = ptMonthStart(y, m), end = Math.min(ptMonthStart(y, m + 1), now + 1);
    const label = new Date((start + 86_400) * 1000).toLocaleDateString("en-US", { month: "short", timeZone: "America/Los_Angeles" });
    return { label, partial: back === 0, ...totalsBetween(db, start, end) };
  }).filter((m) => m.income || m.spend); // a month with no imported data isn't a $0 month
  // Category breakdown for the last complete month, my share, same exclusions as the spend math.
  const lastStart = ptMonthStart(ptNow.getFullYear(), ptNow.getMonth() - 1), lastEnd = ptMonthStart(ptNow.getFullYear(), ptNow.getMonth());
  const rows = db.query(`SELECT t.amount_cents c, t.category cat, t.merchant m, acc.type acct, ${MY_SHARE} share FROM transactions t
      JOIN accounts acc ON acc.id = t.account_id LEFT JOIN attributions a ON a.txn_id = t.id WHERE t.ts >= ? AND t.ts < ?`)
    .all(lastStart, lastEnd) as { c: number; cat: string | null; m: string | null; acct: string; share: number }[];
  const byCat = new Map<string, number>();
  for (const r of rows) if (r.c > 0 && isSpend(r.cat, r.m, r.acct)) byCat.set(r.cat ?? "OTHER", (byCat.get(r.cat ?? "OTHER") ?? 0) + r.c * r.share);
  const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const categories = [...sorted.slice(0, 7), ...(sorted.length > 7 ? [["OTHER", sorted.slice(7).reduce((x, [, v]) => x + v, 0)] as [string, number]] : [])]
    .map(([cat, cents]) => ({ cat, cents: Math.round(cents) }));
  const lastLabel = new Date((lastStart + 86_400) * 1000).toLocaleDateString("en-US", { month: "long", timeZone: "America/Los_Angeles" });
  const accounts = db.query("SELECT name, mask, type, subtype, balance_cents FROM accounts ORDER BY type, name").all();
  let statements: unknown[] = [];
  try {
    statements = db.query(`SELECT l.source, COALESCE(a.name, l.account_id) account, a.mask, l.period_start, l.period_end, l.rows, l.recon_ok
        FROM ingest_log l LEFT JOIN accounts a ON a.id = l.account_id ORDER BY l.period_end DESC LIMIT 12`).all();
  } catch {}
  const recent = db.query(`SELECT t.ts, t.merchant, t.category, t.amount_cents, acc.name account, acc.mask FROM transactions t
      JOIN accounts acc ON acc.id = t.account_id WHERE t.ts <= ? ORDER BY t.ts DESC LIMIT 12`).all(now);
  let assets: unknown[] = [];
  try { assets = db.query("SELECT name, amount_cents FROM manual_assets ORDER BY created_ts").all(); } catch {}
  const g = goalStatus(db, now);
  const goal = g && { target: g.goal.target_cents, deadline: g.goal.deadline, saved: g.savings, projected: g.projected, needMo: g.requiredMonthly, netMo: g.netMonthly };
  return { months, categories, lastLabel, accounts, statements, recent, assets, manual: manualAssetsCents(db), goal, db: process.env.FIN_DB ?? "data/fin.db" };
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/feed") return Response.json(feed());
    if (pathname === "/api/ledger") return Response.json(ledgerFeed());
    if (pathname === "/ledger") return new Response(Bun.file(new URL("./ledger.html", import.meta.url)));
    if (pathname === "/") return new Response(Bun.file(new URL("./index.html", import.meta.url)));
    return new Response("not found", { status: 404 });
  },
});
console.log(`panel: http://127.0.0.1:${PORT}`);
