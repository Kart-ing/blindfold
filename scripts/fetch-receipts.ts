// `bun run scripts/fetch-receipts.ts [since YYYY/MM/DD]`: pull ride/food receipts from every GMAIL_IMAP_ACCOUNTS account
// into data/real-mail/<account>/<uid>.eml. Prints counts only, never message content.
import { join } from "node:path";
import { accountsFromEnv, fetchReceipts } from "../src/ingest/imap";

const out = join(import.meta.dir, "..", "data", "real-mail");
const since = process.argv[2] ?? "2026/07/01";
const accounts = accountsFromEnv();
if (!accounts.length) { console.error("GMAIL_IMAP_ACCOUNTS is empty or malformed in .env"); process.exit(2); }
let total = 0;
for (const a of accounts) {
  const r = await fetchReceipts(a, out, since);
  total += r.saved;
  console.log(`${a.user}: ${r.error ? `ERROR ${r.error}` : `${r.found} found, ${r.saved} saved ${JSON.stringify(r.bySender)}`}`);
}
console.log(`total receipts saved: ${total} → ${out}`);
