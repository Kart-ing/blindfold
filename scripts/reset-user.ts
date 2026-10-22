// `bun run scripts/reset-user.ts --db <path>`: a first-run user on the same ledger. Clears what the USER told or was told
// (goals, memories and the preferences they set, balances they told us (manual_assets), consents, questions asked, nudges sent, the question ledger, settings),
// keeps what was IMPORTED (accounts, transactions, receipts, places, symbols, ingest_log) and recomputes attribution.
import { openDb } from "../src/db";
import { attributeAll } from "../src/attribution/engine";
import { ensureFacts } from "../src/memory/facts";

const i = process.argv.indexOf("--db");
const path = i > 0 ? process.argv[i + 1] : process.env.FIN_DB;
if (!path) { console.error("usage: bun run scripts/reset-user.ts --db <path>"); process.exit(2); }

const db = openDb(path);
ensureFacts(db);
const USER_STATE = ["goals", "manual_assets", "facts", "memories", "consents", "prompts", "nudges", "ledger", "settings"];
const before = Object.fromEntries(USER_STATE.map((t) => [t, (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
db.transaction(() => {
  for (const t of USER_STATE) db.run(`DELETE FROM ${t}`);
  // Labels and standing preferences came from the user too: drop them, then let the rules decide again.
  db.run("DELETE FROM attributions WHERE labelled_by_user = 1 OR rule IN (1, 8)");
})();
attributeAll(db);
console.log(`[reset-user] ${path}: cleared ${JSON.stringify(before)}; imported data kept; attribution recomputed`);
