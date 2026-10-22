// Real receipts straight from Gmail over IMAP (app passwords), on this Mac. Only ride/food receipt senders are
// searched and downloaded; nothing else in the mailbox is read. Saved as .eml under data/real-mail (gitignored).
import { ImapFlow } from "imapflow";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RECEIPT_SENDERS = ["uber.com", "ubereats.com", "lyftmail.com", "lyft.com", "doordash.com"];

export type Account = { user: string; pass: string };

/** GMAIL_IMAP_ACCOUNTS="a@gmail.com:apppassword,b@gmail.com:apppassword" (spaces in app passwords are ignored). */
export function accountsFromEnv(v = process.env.GMAIL_IMAP_ACCOUNTS ?? ""): Account[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(":");
    return { user: s.slice(0, i).trim(), pass: s.slice(i + 1).replace(/\s+/g, "") };
  }).filter((a) => a.user.includes("@") && a.pass.length >= 16);
}

/** Gmail search for receipt senders since `since` (YYYY/MM/DD). */
export const receiptQuery = (since: string) => `from:(${RECEIPT_SENDERS.join(" OR ")}) after:${since}`;

export type FetchResult = { user: string; found: number; saved: number; bySender: Record<string, number>; error?: string };

export async function fetchReceipts(acct: Account, outDir: string, since = "2026/07/01"): Promise<FetchResult> {
  const res: FetchResult = { user: acct.user, found: 0, saved: 0, bySender: {} };
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: acct.user, pass: acct.pass }, logger: false });
  try {
    await client.connect();
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
    const lock = await client.getMailboxLock(all);
    try {
      const uids = (await client.search({ gmraw: receiptQuery(since) }, { uid: true })) || [];
      res.found = uids.length;
      if (uids.length) {
        const dir = join(outDir, acct.user.replace(/[^a-z0-9.@_-]/gi, "_"));
        mkdirSync(dir, { recursive: true });
        for await (const msg of client.fetch(uids, { source: true, envelope: true }, { uid: true })) {
          const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
          const sender = RECEIPT_SENDERS.find((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`)) ?? "other";
          if (sender === "other" || !msg.source) continue; // belt and braces: Gmail's from: is a substring match
          writeFileSync(join(dir, `${msg.uid}.eml`), msg.source);
          res.bySender[sender] = (res.bySender[sender] ?? 0) + 1;
          res.saved++;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    // Never echo credentials: report the IMAP error text only.
    res.error = String((e as any)?.responseText ?? (e as Error).message ?? e).split(acct.pass).join("[app password]").slice(0, 200);
    try { await client.logout(); } catch {}
  }
  return res;
}
