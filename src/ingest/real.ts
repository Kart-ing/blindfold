// Real ride and food receipts from the owner's mailbox: data/real-mail/<account>/<uid>.eml, fetched over IMAP on this Mac
// (gitignored). Classified and parsed locally: a subject pass first, then the on-device model (bin/fm, LOCAL_MODELS=on only), then regex.
// Nothing here prints or logs message text. Extracted fields are cached next to the raw mail (.classified.json), so reruns
// are instant and the leak canary can learn every real address (see realAddressesFor).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { localModelsOn } from "../imessage/fm";

export type Kind = "ride" | "eats" | "doordash" | "promo" | "other";
export type Via = "subject" | "fm" | "regex" | "unclassified";
export type RealMail = {
  key: string; // path relative to the mail root: <account>/<uid>.eml
  kind: Kind; via: Via; ts: number | null;
  total_cents: number | null; subtotal_cents: number | null;
  restaurant: string | null; pickup: string | null; dropoff: string | null;
};
export const RECEIPT_KINDS: Kind[] = ["ride", "eats", "doordash"];

// ---------- MIME ----------

function headers(raw: string): Record<string, string> {
  const block = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const h: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) { const k = line.slice(0, i).toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim(); }
  }
  return h;
}

/** RFC 2047 encoded words (=?UTF-8?B?…?= / =?UTF-8?Q?…?=). */
export function decodeWords(s: string): string {
  return s.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_m, enc: string, txt: string) => {
    try {
      return (enc.toUpperCase() === "B" ? Buffer.from(txt, "base64")
        : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "binary")).toString("utf8");
    } catch { return ""; }
  });
}

function parts(raw: string): { type: string; text: string }[] {
  const h = headers(raw);
  const ct = h["content-type"] ?? "text/plain";
  const sep = /\r?\n\r?\n/.exec(raw);
  let body = sep ? raw.slice(sep.index + sep[0].length) : "";
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    return body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--")).flatMap((p) => parts(p.replace(/^\r?\n/, "")));
  }
  const te = (h["content-transfer-encoding"] ?? "").toLowerCase();
  if (te.includes("base64")) body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  else if (te.includes("quoted-printable")) {
    body = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, x: string) => String.fromCharCode(parseInt(x, 16))), "binary").toString("utf8");
  }
  return [{ type: ct.split(";")[0].trim().toLowerCase(), text: body }];
}

export function htmlToText(html: string): string {
  return html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<\/t[dh]>/gi, "\t")
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/table)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&#x27;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&#36;/g, "$").replace(/&[a-z]+;|&#\d+;/gi, " ")
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}

export type Parsed = { fromDomain: string; subject: string; ts: number | null; text: string; lines: string[] };
export function parseMail(raw: string): Parsed {
  const h = headers(raw);
  const ps = parts(raw);
  const html = ps.find((p) => p.type === "text/html"), plain = ps.find((p) => p.type === "text/plain");
  const text = html ? htmlToText(html.text) : (plain?.text ?? "").replace(/\r/g, "");
  const t = Date.parse(h.date ?? "");
  return { fromDomain: /@([a-z0-9.-]+)/i.exec(h.from ?? "")?.[1].toLowerCase() ?? "", subject: decodeWords(h.subject ?? ""),
    ts: Number.isFinite(t) ? Math.floor(t / 1000) : null, text, lines: text.split("\n") };
}

// ---------- subject pass + regex ----------

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/;
const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
const MARKETING = /%\s*off|\bpromo|uber one|rate your|dashpass|\boffer\b|\bdeal\b|\bsave\b|free delivery|gift card|\bcode\b/i;
const isUber = (d: string) => d === "uber.com" || d.endsWith(".uber.com");
const isDoorDash = (d: string) => d === "doordash.com" || d.endsWith(".doordash.com");

/** The amount on a line labelled `label`, or on one of the next two lines ("Total" then "$12.34"). */
function amountAfter(lines: string[], label: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    for (const l of [lines[i], lines[i + 1] ?? "", lines[i + 2] ?? ""]) { const m = MONEY.exec(l); if (m) return cents(m[1]); }
  }
  return null;
}
/** The nearest amount after a label on the same line ("Total $12.34", also inside long flattened lines), else on the next lines. */
const labelled = (p: Parsed, label: string) => {
  const m = new RegExp(String.raw`\b${label}\b[^$\n]{0,60}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})`, "i").exec(p.text);
  return m ? cents(m[1]) : amountAfter(p.lines, new RegExp(String.raw`\b${label}\b`, "i"));
};
const total = (p: Parsed) => labelled(p, "total"); // \b excludes "Subtotal"
const subtotal = (p: Parsed) => labelled(p, "subtotal");
const ADDRESS = /^\d+[\w-]*\s.*,.*\b[A-Z]{2}\s\d{5}\b/; // "123 Main St, City, ST 94103"

/** The first two "8:10 AM" stops whose address (same line or next) looks like a street address. Skips the date header. */
function stops(lines: string[]): [string | null, string | null] {
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 2; i++) {
    const m = /^\d{1,2}:\d{2}\s*[ap]m\b\s*[|•·\-–]?\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const a = [m[1].trim(), (lines[i + 1] ?? "").trim()].find((x) => ADDRESS.test(x));
    if (a) out.push(a);
  }
  return [out[0] ?? null, out[1] ?? null];
}
const restaurantFromSubject = (s: string) => /\border (?:with|from)\s+(.+?)\s*$/i.exec(s)?.[1] ?? /\bfrom\s+(.+?)\s*$/i.exec(s)?.[1] ?? null;

/** Cheap pass on sender + subject (with a money check on the body so a receipt is never skipped as marketing). */
export function subjectKind(p: Parsed): Kind | null {
  const money = total(p) !== null;
  if (isUber(p.fromDomain) && /uber\s*eats/i.test(p.subject) && /\border\b/i.test(p.subject) && money) return "eats";
  if (isUber(p.fromDomain) && /\btrip\b/i.test(p.subject) && money) return "ride";
  if (isDoorDash(p.fromDomain) && /order confirmation|receipt/i.test(p.subject) && money) return "doordash";
  if (MARKETING.test(p.subject) && !money && subtotal(p) === null) return "promo";
  return null;
}

/** Body-only guess, used when the model refuses or times out. */
function regexKind(p: Parsed): Kind | null {
  if (total(p) === null) return null;
  if (isUber(p.fromDomain) && /rode with/i.test(p.text)) return "ride";
  if (isUber(p.fromDomain) && /thanks for (your )?order/i.test(p.text)) return "eats";
  if (isDoorDash(p.fromDomain) && subtotal(p) !== null) return "doordash";
  return null;
}

function regexFields(kind: Kind, p: Parsed): Omit<RealMail, "key" | "kind" | "via"> {
  const [a, b] = kind === "doordash" ? [null, null] : stops(p.lines);
  const t = total(p);
  // Uber Eats receipts show items, tip and total but no subtotal: total minus tip stands in (it still includes fees, so it
  // errs toward "shared" in attribution rules 4/5).
  const sub = kind === "ride" ? null : kind === "eats" ? (t !== null ? t - (labelled(p, "tip") ?? 0) : null) : subtotal(p);
  return { ts: p.ts, total_cents: t, subtotal_cents: sub,
    restaurant: kind === "ride" ? null : restaurantFromSubject(p.subject), pickup: a, dropoff: b };
}

// ---------- on-device model (only with LOCAL_MODELS=on) ----------

const FM_BIN_DEFAULT = join(import.meta.dir, "..", "..", "bin", "fm");
const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["ride", "eats", "doordash", "promo", "other"],
      description: "ride: an Uber or Lyft trip receipt. eats: an Uber Eats order receipt. doordash: a DoorDash order receipt. promo: marketing. other: anything else." },
    total: { type: "number", description: "total charged, in dollars" },
    date: { type: "string", description: "trip or order date, YYYY-MM-DD" },
    restaurant: { type: "string" }, pickup: { type: "string" }, dropoff: { type: "string" },
  },
  required: ["kind"],
};

/** One bin/fm extract call. null unless LOCAL_MODELS=on, and on refusal ("may contain sensitive or unsafe content"), error or timeout. */
async function fmExtract(text: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  if (!localModelsOn()) return null;
  try {
    const proc = Bun.spawn([process.env.FM_BIN ?? FM_BIN_DEFAULT, "extract"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write(JSON.stringify({ prompt: `Classify this email and extract its receipt fields.\n\n${text.slice(0, 3000)}`, schema: SCHEMA }));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    const res = JSON.parse(out);
    return res?.ok && res.json && typeof res.json === "object" ? res.json : null;
  } catch { return null; }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function classify(p: Parsed, key: string, opts: ClassifyOpts): Promise<RealMail> {
  const sk = subjectKind(p);
  if (sk === "promo") return { key, kind: "promo", via: "subject", ts: p.ts, total_cents: null, subtotal_cents: null, restaurant: null, pickup: null, dropoff: null };
  if (sk) {
    const f = regexFields(sk, p);
    // Known receipt: never sent to the model just to look for addresses (it shares one on-device model with the live agent).
    if (f.total_cents !== null) return { key, kind: sk, via: "subject", ...f };
  }
  const j = opts.useFm ? await fmExtract(p.text, opts.timeoutMs) : null;
  const kind = j && ["ride", "eats", "doordash", "promo", "other"].includes(String(j.kind)) ? (j.kind as Kind) : null;
  if (kind && !RECEIPT_KINDS.includes(kind)) return { key, kind, via: "fm", ts: p.ts, total_cents: null, subtotal_cents: null, restaurant: null, pickup: null, dropoff: null };
  if (kind) {
    const f = regexFields(kind, p);
    const t = typeof j!.total === "number" && j!.total > 0 ? Math.round((j!.total as number) * 100) : null;
    return { key, kind, via: "fm", ts: p.ts, total_cents: f.total_cents ?? t, subtotal_cents: f.subtotal_cents,
      restaurant: f.restaurant ?? str(j!.restaurant), pickup: f.pickup ?? str(j!.pickup), dropoff: f.dropoff ?? str(j!.dropoff) };
  }
  const rk = sk ?? regexKind(p);
  if (rk) return { key, kind: rk, via: "regex", ...regexFields(rk, p) };
  return { key, kind: "other", via: "unclassified", ts: p.ts, total_cents: null, subtotal_cents: null, restaurant: null, pickup: null, dropoff: null };
}

// ---------- whole mailbox, cached ----------

export type ClassifyOpts = { useFm: boolean; concurrency: number; timeoutMs: number };
const cachePathFor = (root: string) => join(root, ".classified.json");

/** Every .eml under root, classified (cached by path). Returns the mails sorted by key. */
export async function classifyMailbox(root: string, opts: Partial<ClassifyOpts> = {}): Promise<{ mails: RealMail[]; cached: number; errors: number }> {
  // One worker: the on-device model is a single serialized resource shared with the live agent.
  // No local models unless LOCAL_MODELS=on: then subject, regex and the cache only, and the cache isn't written.
  const o: ClassifyOpts = { concurrency: 1, timeoutMs: 3000, ...opts, useFm: (opts.useFm ?? true) && localModelsOn() };
  const cachePath = cachePathFor(root);
  const cache: Record<string, RealMail> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const keys: string[] = [];
  for (const acct of readdirSync(root).sort()) {
    const dir = join(root, acct);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".eml")).sort()) keys.push(`${acct}/${f}`);
  }
  let errors = 0;
  const todo = keys.filter((k) => !cache[k]);
  const done = await pool(todo, o.concurrency, async (k) => {
    try { return await classify(parseMail(readFileSync(join(root, k), "utf8")), k, o); }
    catch { errors++; return null; } // never log the message: it may carry personal data
  });
  for (const m of done) if (m) cache[m.key] = m;
  if (todo.length && o.useFm) writeFileSync(cachePath, JSON.stringify(cache)); // a --no-fm dry run must not freeze its guesses
  return { mails: keys.map((k) => cache[k]).filter(Boolean), cached: keys.length - todo.length, errors };
}

/**
 * The same receipt seen twice: same kind and total, and either sent within 30 minutes (a resend) or on the same day in another
 * account. Two same-fare commutes on one day are hours apart, so both stay. Keeps the first.
 */
export function dedupe(mails: RealMail[]): RealMail[] {
  const kept: RealMail[] = [];
  const acct = (m: RealMail) => m.key.split("/")[0];
  for (const m of mails) {
    const dup = RECEIPT_KINDS.includes(m.kind) && m.ts !== null && m.total_cents !== null && kept.some((k) =>
      k.kind === m.kind && k.total_cents === m.total_cents && k.ts !== null &&
      (Math.abs(k.ts - m.ts!) <= 30 * 60 || (acct(k) !== acct(m) && localDay(k.ts) === localDay(m.ts!))));
    if (!dup) kept.push(m);
  }
  return kept;
}

const PT = { timeZone: "America/Los_Angeles" } as const;
export const localDay = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-CA", PT);
const localHourDow = (ts: number) => {
  const p = new Intl.DateTimeFormat("en-US", { ...PT, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(ts * 1000));
  return { hour: Number(p.find((x) => x.type === "hour")!.value), dow: p.find((x) => x.type === "weekday")!.value };
};

// ---------- HOME / WORK ----------

/** Street-level key: no house number, unit or country; common suffixes shortened. */
export function addressKey(a: string): string {
  return a.toLowerCase()
    .replace(/,?\s*(usa|us|united states)\s*$/, "")
    .replace(/\b(apt|unit|suite|ste|fl|floor)\b\.?\s*[\w-]+/g, " ").replace(/#\s*[\w-]+/g, " ")
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\bboulevard\b/g, "blvd").replace(/\broad\b/g, "rd").replace(/\bdrive\b/g, "dr")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/^\s*\d+[a-z]?(\s+\d+[a-z]?)?\s+/, "").replace(/\s+/g, " ").trim();
}

export type Place = { key: string; address: string; share: number };
/** HOME = the most common weekday-morning pickup, WORK = the most common weekday-morning dropoff (another place). */
export function inferHomeWork(rides: RealMail[]): { home: Place | null; work: Place | null; morning: number } {
  const morning = rides.filter((r) => r.ts !== null && r.pickup && r.dropoff && (() => {
    const { hour, dow } = localHourDow(r.ts!); return hour >= 5 && hour < 11 && !["Sat", "Sun"].includes(dow);
  })());
  const top = (addrs: string[], exclude?: string): Place | null => {
    const byKey = new Map<string, string[]>();
    for (const a of addrs) { const k = addressKey(a); if (k && k !== exclude) byKey.set(k, [...(byKey.get(k) ?? []), a]); }
    const best = [...byKey].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))[0];
    if (!best) return null;
    const counts = new Map<string, number>();
    for (const a of best[1]) counts.set(a, (counts.get(a) ?? 0) + 1);
    const address = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    return { key: best[0], address, share: best[1].length / addrs.length };
  };
  const home = top(morning.map((r) => r.pickup!));
  const work = top(morning.map((r) => r.dropoff!), home?.key);
  return { home, work, morning: morning.length };
}

export const labelFor = (address: string | null, home: Place | null, work: Place | null): string | null => {
  if (!address) return null;
  const k = addressKey(address);
  return home && k === home.key ? "HOME" : work && k === work.key ? "WORK" : "OTHER";
};

const loaded = new Map<string, { mtime: number; cache: Record<string, RealMail> }>();
/** Raw addresses for one real receipt file, from the cache next to the mail (for the leak canary). */
export function realAddressesFor(rawPath: string): string[] {
  const root = dirname(dirname(rawPath));
  const cachePath = cachePathFor(root);
  if (!existsSync(cachePath)) return [];
  const mtime = statSync(cachePath).mtimeMs;
  let hit = loaded.get(cachePath);
  if (!hit || hit.mtime !== mtime) loaded.set(cachePath, hit = { mtime, cache: JSON.parse(readFileSync(cachePath, "utf8")) });
  const m = hit.cache[relative(root, rawPath)];
  return m ? [m.pickup, m.dropoff].filter((a): a is string => !!a) : [];
}
