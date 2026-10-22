// Real ride/food receipts from the local Apple Mail store (MAIL_SOURCE=applemail). No OAuth, no network.
// Needs Full Disk Access (same grant as chat.db); without it this fails soft and says so.
//
// .emlx = first line is the RFC822 byte count N, then N bytes of RFC822, then an Apple plist.
// The leak canary re-reads receipts.raw_path as plain RFC822, so the extracted message is cached under data/mail-cache/.
// Interface: eng1's seed.ts calls ingestAppleMail() instead of ingestReceipts() when MAIL_SOURCE=applemail,
// then runs matchReceipts → attributeAll once, as for fixtures.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fromLocal } from "../imessage/clock";
import { parseReceipt, type ReceiptOptions } from "./receipts";
import type { Place } from "./types";

export const MAIL_ROOT = join(homedir(), "Library", "Mail");
const CACHE_DIR = process.env.MAIL_CACHE_DIR ?? join(import.meta.dir, "..", "..", "data", "mail-cache");
const RECEIPT_DOMAINS = ["uber.com", "lyft.com", "lyftmail.com", "doordash.com"];
export const DEFAULT_SINCE = fromLocal(2026, 8, 1);
const HEAD_BYTES = 16 * 1024;
const MAX_HEAD_BYTES = 256 * 1024;
const MAX_DEPTH = 12;

export class MailAccessError extends Error {}

/** matched = parsed + failed + duplicates. skipped = header unreadable. Non-receipt mail counts in neither. */
export type AppleMailResult = {
  found: number; skipped: number; matched: number; duplicates: number; parsed: number; failed: number; unreadableDirs: number; error?: string;
};
const EMPTY: AppleMailResult = { found: 0, skipped: 0, matched: 0, duplicates: 0, parsed: 0, failed: 0, unreadableDirs: 0 };
/** Explicit options override env. root: ~/Library/Mail. cacheDir: MAIL_CACHE_DIR or <repo>/data/mail-cache. since: parseSince(MAIL_SINCE). Places come from the DB. */
export type AppleMailOptions = ReceiptOptions & { root?: string; since?: number; cacheDir?: string };

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "";
const isPerm = (e: unknown) => ["EPERM", "EACCES"].includes(code(e));
const accessMessage = (root: string) =>
  `can't read ${root}: grant Full Disk Access to this terminal (System Settings → Privacy & Security), then restart it`;

/** MAIL_SINCE: unix seconds, a date (local midnight in FIN_TZ), or an ISO timestamp with an offset. Invalid → default. */
export function parseSince(v: string | undefined): number {
  if (!v?.trim()) return DEFAULT_SINCE;
  const s = v.trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return fromLocal(Number(d[1]), Number(d[2]), Number(d[3]));
  const t = Date.parse(s);
  if (/[T ]\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s) && Number.isFinite(t)) return Math.floor(t / 1000);
  console.warn(`[applemail] ignoring invalid MAIL_SINCE=${JSON.stringify(s)}; using 2026-08-01`);
  return DEFAULT_SINCE;
}

/**
 * Every .emlx in a Messages directory under V<n>. Missing root → [].
 * No access to the root or a V<n> directory means no Full Disk Access → MailAccessError. Deeper failures skip that directory.
 */
export function findEmlx(root = MAIL_ROOT, stats = { unreadableDirs: 0, rootMissing: false }): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isPerm(e) && depth <= 1) throw new MailAccessError(accessMessage(root));
      if (depth === 0) stats.rootMissing = true;
      else stats.unreadableDirs++; // a mailbox that vanished or is locked mid-walk
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth === 0 && !/^V\d+$/.test(ent.name)) continue;
        if (depth < MAX_DEPTH) walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(".emlx") && basename(dir) === "Messages") out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** RFC822 text of an .emlx, or null if the framing is wrong. N counts bytes, not characters. */
export function parseEmlx(buf: Buffer): string | null {
  return framed(buf)?.toString("utf8") ?? null;
}

/** Unfolded headers of the first block (lower-cased names, first value wins). */
export function headerBlock(text: string): Record<string, string> {
  const end = text.search(/\r?\n\r?\n/);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const h: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c <= 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    // A repeated From is ambiguous: blank it so the sender filter rejects the message.
    if (name === "from" && name in h) h.from = "";
    else h[name] ??= line.slice(c + 1).trim();
  }
  return h;
}

/**
 * The one sender address in a From header: comments stripped, the <addr-spec> if present, never the display name.
 * Null for zero or several mailboxes. (From is unauthenticated; a spoofed receipt can at most sway who-paid on a
 * transaction it also matches by amount and time, locally and correctably.)
 */
export function senderAddress(from: string | undefined): string | null {
  if (!from) return null;
  let s = from;
  for (let i = 0; i < 5 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, " ");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, " "); // quoted display names can contain anything
  const angles = [...s.matchAll(/<([^<>]*)>/g)];
  if (angles.length > 1) return null;
  const addr = (angles.length ? angles[0][1] : s.includes(",") ? "" : s).trim().toLowerCase();
  if (angles.length && s.replace(/<[^<>]*>/, "").includes(",")) return null;
  return /^[^\s@<>,]+@[a-z0-9.-]+$/.test(addr) ? addr : null;
}

export function isReceiptHeader(h: Record<string, string>, since = DEFAULT_SINCE): boolean {
  const domain = senderAddress(h.from)?.split("@")[1] ?? "";
  if (!RECEIPT_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  const ts = Date.parse(h.date ?? "") / 1000;
  return Number.isFinite(ts) && ts >= since;
}

function readPrefix(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** Headers from the start of the file (16 KB, widening to 256 KB); null if the framing or header block is incomplete. */
export function headOf(path: string): Record<string, string> | null {
  for (const bytes of [HEAD_BYTES, MAX_HEAD_BYTES]) {
    const buf = readPrefix(path, bytes);
    const nl = buf.indexOf(0x0a);
    if (nl < 1 || nl > 20 || !/^\d+$/.test(buf.subarray(0, nl).toString("ascii").trim())) return null;
    const n = Number(buf.subarray(0, nl).toString("ascii").trim());
    // Never read past the declared RFC822 length into the trailing plist.
    const text = buf.subarray(nl + 1, Math.min(buf.length, nl + 1 + n)).toString("utf8");
    if (/\r?\n\r?\n/.test(text)) return headerBlock(text);
    if (buf.length < bytes || n <= buf.length - nl - 1) return null; // no header terminator within the message
  }
  return null;
}

export type Scan = { found: number; matches: string[]; skipped: number; unreadableDirs: number; rootMissing: boolean };

/** Receipt-looking messages, by header scan only. Throws MailAccessError without Full Disk Access. */
export function scanReceipts(root = MAIL_ROOT, since = DEFAULT_SINCE): Scan {
  const stats = { unreadableDirs: 0, rootMissing: false };
  const files = findEmlx(root, stats);
  const matches: string[] = [];
  let skipped = 0;
  for (const f of files) {
    let h: Record<string, string> | null = null;
    try { h = headOf(f); } catch { /* vanished or locked file: skipped */ }
    if (!h) { skipped++; continue; }
    if (isReceiptHeader(h, since)) matches.push(f);
  }
  return { found: files.length, matches, skipped, ...stats };
}

/** Stable across moves, copies and reindexing: keyed on Message-ID, else on a SHA-256 of the whole message. */
export function receiptId(rfc822: string): string {
  const h = headerBlock(rfc822);
  const mid = (h["message-id"] ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
  const key = mid ? `mid:${mid}` : `sha:${createHash("sha256").update(rfc822).digest("hex")}`;
  return `receipt-am-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

export type IngestHooks = { beforeCommit?: () => void; writeCache?: (path: string, data: Buffer) => void };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BATCH = 50;

/** RFC822 bytes (not decoded) of an .emlx, or null if the framing is wrong. */
function framed(buf: Buffer): Buffer | null {
  const nl = buf.indexOf(0x0a);
  if (nl < 1 || nl > 20) return null;
  const line = buf.subarray(0, nl).toString("ascii").trim();
  if (!/^\d+$/.test(line)) return null;
  const n = Number(line);
  return nl + 1 + n > buf.length ? null : buf.subarray(nl + 1, nl + 1 + n);
}

function defaultWriteCache(path: string, data: Buffer) {
  if (existsSync(path)) return; // content-addressed: same name, same bytes
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Ingests matching receipts into `receipts`. Never throws for access or per-file problems.
 * Per matched file: read (≤10 MB) → frame → parse → write the immutable cache file `<id>-<sha>.eml` → upsert.
 * Cache files are written before their row commits and never change, so no committed row can point to a missing
 * or different body; a crash leaves at most an orphan file. Upserts run in transactions of 50.
 */
export function ingestAppleMail(db: Database, opts: AppleMailOptions = {}, hooks: IngestHooks = {}): AppleMailResult {
  const root = opts.root ?? MAIL_ROOT;
  let scan: Scan;
  try {
    scan = scanReceipts(root, opts.since ?? parseSince(process.env.MAIL_SINCE));
  } catch (e) {
    if (e instanceof MailAccessError) return { ...EMPTY, error: e.message };
    throw e;
  }
  const res: AppleMailResult = { ...EMPTY, found: scan.found, skipped: scan.skipped, matched: scan.matches.length, unreadableDirs: scan.unreadableDirs };
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const places = db.query("SELECT * FROM places").all() as Place[];
  const put = db.query(`INSERT INTO receipts (id, source, email_id, ts, amount_cents, pickup_label, dropoff_label, items, subtotal_cents, raw_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,
    email_id=excluded.email_id, ts=excluded.ts, amount_cents=excluded.amount_cents,
    pickup_label=excluded.pickup_label, dropoff_label=excluded.dropoff_label, items=excluded.items,
    subtotal_cents=excluded.subtotal_cents, raw_path=excluded.raw_path`);
  const writeCache = hooks.writeCache ?? defaultWriteCache;
  const accepted = new Set<string>(); // an id is "seen" only once a copy of it parsed and cached

  for (let i = 0; i < scan.matches.length; i += BATCH) {
    db.transaction(() => {
      for (const f of scan.matches.slice(i, i + BATCH)) {
        try {
          if (statSync(f).size > MAX_FILE_BYTES) { res.failed++; continue; }
          const bytes = framed(readFileSync(f));
          if (!bytes) { res.failed++; continue; }
          const rfc822 = bytes.toString("utf8");
          const id = receiptId(rfc822);
          if (accepted.has(id)) { res.duplicates++; continue; }
          const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
          const cachePath = join(cacheDir, `${id}-${sha}.eml`);
          const r = parseReceipt(rfc822, cachePath, places, opts);
          writeCache(cachePath, bytes);
          put.run(id, r.source, r.email_id, r.ts, r.amount_cents, r.pickup_label, r.dropoff_label, r.items, r.subtotal_cents, cachePath);
          accepted.add(id);
          res.parsed++;
        } catch {
          res.failed++; // vanished file, a template the parser doesn't know, or a cache write error
        }
      }
      hooks.beforeCommit?.();
    })();
  }
  return res;
}

/** One line for `main.ts --check`. Header scan only; writes nothing. */
export function mailCheck(root = MAIL_ROOT): string {
  try {
    const scan = scanReceipts(root, parseSince(process.env.MAIL_SINCE));
    if (scan.rootMissing) return "Apple Mail receipts readable: no (no Apple Mail data found)";
    return `Apple Mail receipts readable: yes (${scan.matches.length} found` + // N = header-matching receipt messages +
      `${scan.unreadableDirs ? `, ${scan.unreadableDirs} folders unreadable` : ""})`;
  } catch (e) {
    return `Apple Mail receipts readable: no (${e instanceof MailAccessError ? "Full Disk Access needed" : (e as Error).message})`;
  }
}

if (import.meta.main) {
  const { openDb } = await import("../db");
  const { matchReceipts } = await import("./match");
  const { attributeAll } = await import("../attribution/engine");
  const i = process.argv.indexOf("--db");
  const db = openDb(i > 0 ? process.argv[i + 1] : undefined);
  const res = ingestAppleMail(db);
  if (res.error) {
    console.error(`[applemail] ${res.error}`);
    process.exit(1);
  }
  const matched = matchReceipts(db);
  attributeAll(db);
  // Counts only: never print addresses or message contents.
  console.log(`[applemail] ${res.found} messages scanned, ${res.matched} receipts, ${res.parsed} parsed, ` +
    `${res.duplicates} duplicates, ${res.failed} failed, ${res.skipped} unreadable headers, ${matched} matched to transactions`);
}
