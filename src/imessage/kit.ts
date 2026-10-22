// iMessage transport via @photon-ai/imessage-kit v3: local only (reads ~/Library/Messages/chat.db, sends via AppleScript).
// Accepts direct messages from OWNER_HANDLE and nobody else; always sends to OWNER_HANDLE.
import { getDefaultDatabasePath, IMessageSDK } from "@photon-ai/imessage-kit";
import { Database } from "bun:sqlite";
import type { Transport } from "./transport.ts";

/** Phones compare on their last 10 digits; emails case-insensitively. */
export function normalizeHandle(h: string | null | undefined): string {
  const s = (h ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

type InboundMsg = { id: string; participant: string | null; text: string | null; isFromMe: boolean; chatKind?: string };

/** Pure filter, exported for tests. */
export function acceptFromOwner(msg: InboundMsg, owner: string): boolean {
  const o = normalizeHandle(owner);
  return !!o && !msg.isFromMe && msg.chatKind !== "group" && normalizeHandle(msg.participant) === o && !!msg.text?.trim();
}

type Sdk = Pick<IMessageSDK, "startWatching" | "stopWatching" | "send" | "close"> & Partial<Pick<IMessageSDK, "getMessages">>;

/** "+1 (555) 123-4567" → "•••4567"; "kart@example.com" → "k•••@example.com". */
export function maskHandle(h: string): string {
  const s = h.trim();
  if (!s) return "(not set)";
  if (s.includes("@")) { const [u, d] = s.split("@"); return `${u.slice(0, 1)}•••@${d}`; }
  return `•••${s.replace(/\D/g, "").slice(-4)}`;
}

/** One-command readiness check for live iMessage: owner handle set, chat.db readable (Full Disk Access). */
export function selfCheck(owner = process.env.OWNER_HANDLE ?? ""): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const hasOwner = !!normalizeHandle(owner);
  lines.push(`OWNER_HANDLE: ${hasOwner ? maskHandle(owner) : "MISSING (set it in .env)"}`);
  let readable = false;
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(getDefaultDatabasePath(), { readonly: true });
    db.query("SELECT 1 FROM message LIMIT 1").get();
    db.close();
    readable = true;
    lines.push("chat.db: readable");
  } catch (e) {
    lines.push(`chat.db: NOT readable (${(e as Error).message}). Grant Full Disk Access to this terminal and restart it.`);
  }
  return { ok: hasOwner && readable, lines };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** MAX(message.ROWID) of the local chat.db, read-only; null when it can't be read (e.g. no Full Disk Access). */
export function readMaxRowId(path = getDefaultDatabasePath()): number | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("SELECT MAX(ROWID) AS m FROM message").get() as { m: number | null }).m ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

type KitOpts = {
  dry?: boolean; retryMs?: number; pollMs?: number;
  /** Poll cursor at start; defaults to chat.db's MAX(ROWID) (0 with an injected test sdk). null = read it on the first poll. */
  startRowId?: () => number | null;
  /** How long the poll waits for a half-written row (no participant yet) before moving past it. */
  incompleteGraceMs?: number;
};

export class KitTransport implements Transport {
  private seen = new Set<string>();
  private dropped = 0;
  private sdk: Sdk;
  private stopped = false;
  private poller?: ReturnType<typeof setInterval>;

  private startRowId: () => number | null;

  constructor(private owner = process.env.OWNER_HANDLE ?? "", sdk?: Sdk, private opts: KitOpts = {}) {
    if (!normalizeHandle(owner)) throw new Error("OWNER_HANDLE is not set in .env; refusing to start the iMessage transport");
    this.sdk = sdk ?? new IMessageSDK();
    this.startRowId = opts.startRowId ?? (sdk ? () => 0 : () => readMaxRowId());
  }

  async start(onText: (text: string) => Promise<void>) {
    const events = {
      onIncomingMessage: (msg: any) => {
        if (this.seen.has(msg.id)) return;
        // A row caught before its handle is written can't be judged yet; leave it unseen so the poll retries it.
        if (!msg.participant) return;
        this.seen.add(msg.id);
        if (!acceptFromOwner(msg, this.owner)) {
          this.dropped++;
          if (process.env.DEBUG) console.error(`[kit] dropped message not from owner (total ${this.dropped})`);
          return;
        }
        // Hand each message over at once, never behind the previous one: a handler can be waiting (askConsent) for
        // exactly this message. Order is kept by main.ts's FIFO lane. (Serializing here deadlocked consent live.)
        Promise.resolve().then(() => onText(msg.text!)).catch((e) => console.error("[kit] handler error:", e));
      },
      onError: (err: unknown) => console.error("[kit] watcher error (still running):", err),
    };
    // A chat.db read failure (e.g. no Full Disk Access yet) must not kill the demo: log and keep retrying.
    const retryMs = this.opts.retryMs ?? 10_000;
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        // Read the poll cursor before the kit reads its own, so nothing arriving in between falls through both.
        const cursor = this.startRowId();
        await this.sdk.startWatching(events);
        this.startPolling(events.onIncomingMessage, cursor);
        console.log(`[kit] watching iMessage (local chat.db) for ${maskHandle(this.owner)}${this.opts.dry ? " [dry run: nothing is sent]" : ""}`);
        return;
      } catch (e) {
        console.error(`[kit] can't watch chat.db (attempt ${attempt}): ${(e as Error).message}; retrying in ${retryMs / 1000}s`);
        await sleep(retryMs);
      }
    }
  }

  /**
   * Backup for the kit's WAL file watch (fs.watch on chat.db-wal). Seen live on Oct 22: row 22013 (an owner DM)
   * landed at 12:52:29, the WAL mtime moved to 12:52:32, and the kit emitted nothing and logged no error, so the text
   * went unanswered. A passive fs.watch probe started later (12:55) showed Bun does report WAL writes: one inbound
   * plus two sends at 13:08:59–13:09:06 gave 45 "change" events and no "rename". So the 12:52 miss is real but its
   * cause is unconfirmed (it happened before the probe ran); this poll makes delivery independent of the watch.
   *
   * The poll follows a ROWID cursor (`sinceRowId`, ascending), never message.date: dates come from the sender's clock
   * and late deliveries, so date order differs from arrival order (row 22012 carried a 14:06 timestamp but arrived
   * before 12:52). `seen` dedupes against the watcher, so a message is handled once whichever path finds it first.
   */
  private startPolling(handle: (msg: any) => void, startCursor: number | null) {
    const getMessages = this.sdk.getMessages?.bind(this.sdk);
    if (!getMessages || this.opts.pollMs === 0 || this.poller) return;
    let cursor = startCursor;
    const grace = this.opts.incompleteGraceMs ?? 30_000;
    const firstSeenIncomplete = new Map<number, number>();
    let busy = false;
    this.poller = setInterval(async () => {
      if (busy || this.stopped) return;
      busy = true;
      try {
        if (cursor === null) {
          // chat.db wasn't readable at start: take today's max as the baseline, so history is never replayed.
          cursor = this.startRowId();
          if (cursor === null) return;
        }
        const rows = (await getMessages({ isFromMe: false, sinceRowId: cursor, orderByRowIdAsc: true, limit: 100 } as any)) as any[];
        // Defensive: keep only rows past the cursor, in ROWID order, even if the kit ignored the cursor fields.
        const fresh = rows.filter((m) => Number.isInteger(m.rowId) && m.rowId > cursor!).sort((a, b) => a.rowId - b.rowId);
        let held = false; // an earlier row is still half-written: keep the cursor before it
        for (const m of fresh) {
          if (!m.participant) {
            const first = firstSeenIncomplete.get(m.rowId) ?? Date.now();
            firstSeenIncomplete.set(m.rowId, first);
            if (Date.now() - first < grace) { held = true; continue; }
          }
          firstSeenIncomplete.delete(m.rowId);
          handle(m);
          if (!held) cursor = m.rowId;
        }
      } catch (e) {
        console.error(`[kit] poll failed (watcher still running): ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    }, this.opts.pollMs ?? 1500);
  }

  async send(text: string) {
    if (this.opts.dry) return void console.log(`[dry] would send to ${maskHandle(this.owner)}: ${text}`);
    try {
      await this.sdk.send({ to: this.owner, text });
    } catch (e) {
      console.error(`[kit] send failed, retrying once: ${(e as Error).message}`);
      await sleep(this.opts.retryMs ?? 1_000);
      await this.sdk.send({ to: this.owner, text });
    }
  }

  async stop() {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    await this.sdk.stopWatching().catch(() => {});
    await this.sdk.close().catch(() => {});
  }
}
