import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Place, Receipt } from "./types";
import { realAddressesFor } from "./real";

export type Location = { address: string; lat: number; lng: number };
export type ReceiptOptions = { locations?: Location[]; radiusMeters?: number };
const defaultLocations = JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/locations.json"), "utf8")) as Location[];
const normalizeAddress = (address: string) => address.toLowerCase().replace(/\bstreet\b/g, "st").replace(/\bcalifornia\b/g, "ca").replace(/[^a-z0-9]/g, "");

/** Local address -> lat/lng lookup (no network geocoding). */
export function lookupLocation(address: string, locations: Location[] = defaultLocations): Location | null {
  return locations.find(l => normalizeAddress(l.address) === normalizeAddress(address)) ?? null;
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (x: number) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function geofence(address: string, places: Place[], options: ReceiptOptions = {}): string {
  const point = [...places, ...(options.locations ?? defaultLocations)].find(p => normalizeAddress(p.address) === normalizeAddress(address));
  if (!point) return "OTHER";
  const nearest = places.filter(p => p.label === "HOME" || p.label === "WORK")
    .map(p => ({ label: p.label, distance: distanceMeters(point, p) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= (options.radiusMeters ?? 250) ? nearest.label : "OTHER";
}

function headers(raw: string): Record<string, string> {
  const block = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  return Object.fromEntries(block.split(/\r?\n/).map(line => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
}

/** Decoded body as text. HTML: one line per row/paragraph, table cells separated by tabs. */
function decodePart(raw: string): string {
  const h = headers(raw);
  const boundary = /boundary="?([^";\r\n]+)/i.exec(h["content-type"] ?? "")?.[1];
  if (boundary) {
    const parts = raw.split(`--${boundary}`).slice(1).filter(part => !part.startsWith("--"));
    const plain = parts.find(part => /content-type:\s*text\/plain/i.test(part));
    return decodePart((plain ?? parts.find(part => /content-type:\s*text\/html/i.test(part)) ?? "").trimStart());
  }
  const separator = /\r?\n\r?\n/.exec(raw);
  let body = separator ? raw.slice(separator.index + separator[0].length) : raw;
  if (/base64/i.test(h["content-transfer-encoding"] ?? "")) body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  if (/quoted-printable/i.test(h["content-transfer-encoding"] ?? "")) {
    body = body.replace(/=\r?\n/g, "");
    body = Buffer.from(body.replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary").toString("utf8");
  }
  body = body.replace(/\r/g, "");
  if (!/<html|<table|<p>/i.test(body)) return body;
  return body.replace(/\n/g, " ").replace(/<\/t[dh]>/gi, "\t").replace(/<(?:br\s*\/?|\/p|\/div|\/tr|\/h\d|\/li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&middot;/gi, "·").replace(/&bull;/gi, "•").replace(/&#36;/g, "$").replace(/&amp;/gi, "&")
    .split("\n").map(l => l.replace(/[ ]+/g, " ").trim()).filter(Boolean).join("\n");
}

function money(value: string | undefined): number | null {
  if (value == null) return null;
  const result = Math.round(Number(value.replace(/,/g, "")) * 100);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

const AMT = String.raw`\$\s*([\d,]+\.\d{2})`;
const first = (re: RegExp, text: string) => re.exec(text)?.[1]?.trim();
/** The line right after a heading line, e.g. "Pickup  10:30 PM" -> next line is the address. */
const lineAfter = (heading: RegExp, text: string) => {
  const lines = text.split("\n"), i = lines.findIndex(l => heading.test(l));
  return i >= 0 ? lines[i + 1]?.trim() || undefined : undefined;
};
// Drinks, sides, sauces and desserts are not entree-class items (PRD §4 rule 4).
const NOT_ENTREE = /\b(water|soda|coke|sprite|drink|juice|tea|coffee|latte|lemonade|beer|chips|salsa|fries|side|sauce|dressing|bread|cookie|brownie|dessert|guac(amole)?)\b/i;

type Extracted = { total?: string; subtotal?: string; pickup?: string; dropoff?: string; items?: [number, string][] };

/** One regex extractor per sender template. Each returns raw strings; nothing here is stored. */
const EXTRACTORS: Record<string, (text: string) => Extracted> = {
  uber: text => {
    const stops = [...text.matchAll(/^\d{1,2}:\d{2}\s*[AP]M\s*\|\s*(.+)$/gim)].map(m => m[1].trim());
    return { total: first(new RegExp(String.raw`^Total\s+${AMT}`, "im"), text), pickup: stops[0], dropoff: stops[1] };
  },
  lyft: text => ({
    total: first(new RegExp(String.raw`^Total charged[^\n$]*${AMT}`, "im"), text),
    pickup: lineAfter(/^Pickup\b/i, text), dropoff: lineAfter(/^Drop-?off\b/i, text),
  }),
  uber_eats: text => ({
    total: first(new RegExp(String.raw`^Total\s+${AMT}`, "im"), text),
    subtotal: first(new RegExp(String.raw`^Subtotal\s+${AMT}`, "im"), text),
    dropoff: first(/^Delivered to\s+(.+)$/im, text),
    items: [...text.matchAll(/^(\d+)\t\s*([^\t\n]+)\t\s*\$[\d,]+\.\d{2}/gm)].map(m => [Number(m[1]), m[2].trim()]),
  }),
  doordash: text => ({
    total: first(new RegExp(String.raw`^Total\s+${AMT}`, "im"), text),
    subtotal: first(new RegExp(String.raw`^Subtotal\s+${AMT}`, "im"), text),
    dropoff: lineAfter(/^Delivering to:/i, text),
    items: [...text.matchAll(/^(\d+)\s*x\s+(.+?)\s+\$[\d,]+\.\d{2}\s*$/gim)].map(m => [Number(m[1]), m[2].trim()]),
  }),
};

function sourceOf(h: Record<string, string>): string | null {
  const from = h.from ?? "";
  const domain = /@([a-z0-9.-]+)/i.exec(from)?.[1].toLowerCase() ?? "";
  const is = (d: string) => domain === d || domain.endsWith(`.${d}`);
  if (is("doordash.com")) return "doordash";
  if (is("lyft.com") || is("lyftmail.com")) return "lyft";
  if (is("uber.com")) return /uber\s*eats/i.test(`${from} ${h.subject ?? ""}`) ? "uber_eats" : "uber";
  return null;
}

/** Deterministic extraction. Addresses are geofenced to HOME/WORK/OTHER here and then discarded. */
export function parseReceipt(raw: string, rawPath: string, places: Place[], options: ReceiptOptions = {}): Receipt {
  const h = headers(raw), text = decodePart(raw), source = sourceOf(h);
  if (!source) throw new Error(`Unsupported receipt sender: ${basename(rawPath)}`);
  const x = EXTRACTORS[source](text);
  const total = money(x.total), ts = Math.floor(Date.parse(h.date ?? "") / 1000);
  if (total == null || !Number.isSafeInteger(ts)) throw new Error(`Missing receipt total or date: ${basename(rawPath)}`);
  const food = source === "uber_eats" || source === "doordash";
  return { id: `receipt-${basename(rawPath, ".eml")}`, source, email_id: (h["message-id"] ?? basename(rawPath)).replace(/^<|>$/g, ""), ts, amount_cents: total,
    pickup_label: x.pickup ? geofence(x.pickup, places, options) : null,
    dropoff_label: x.dropoff ? geofence(x.dropoff, places, options) : null,
    items: food ? (x.items ?? []).filter(([, name]) => !NOT_ENTREE.test(name)).reduce((n, [q]) => n + q, 0) : null,
    subtotal_cents: money(x.subtotal), raw_path: rawPath };
}

/** Raw address strings in one receipt (for the canary). */
export function addressesIn(raw: string): string[] {
  const source = sourceOf(headers(raw));
  if (!source) return [];
  const x = EXTRACTORS[source](decodePart(raw));
  return [x.pickup, x.dropoff].filter((a): a is string => !!a);
}

export function ingestReceipts(db: Database, directory = join(import.meta.dir, "../../fixtures/mail"), options: ReceiptOptions = {}): number {
  const places = db.query<Place, []>("SELECT * FROM places").all();
  const put = db.query(`INSERT INTO receipts (id, source, email_id, ts, amount_cents, pickup_label, dropoff_label, items, subtotal_cents, raw_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,
    email_id=excluded.email_id, ts=excluded.ts, amount_cents=excluded.amount_cents,
    pickup_label=excluded.pickup_label, dropoff_label=excluded.dropoff_label, items=excluded.items,
    subtotal_cents=excluded.subtotal_cents, raw_path=excluded.raw_path`);
  const files = readdirSync(directory).filter(f => f.endsWith(".eml")).sort();
  db.transaction(() => {
    for (const file of files) {
      const rawPath = resolve(directory, file);
      const r = parseReceipt(readFileSync(rawPath, "utf8"), rawPath, places, options);
      put.run(r.id, r.source, r.email_id, r.ts, r.amount_cents, r.pickup_label, r.dropoff_label, r.items, r.subtotal_cents, r.raw_path);
    }
  })();
  return files.length;
}

/** Raw addresses read back from the raw_path files. Only the leak canary may call this. */
export function receiptAddresses(db: Database): string[] {
  const out = new Set<string>();
  for (const { raw_path } of db.query<{ raw_path: string }, []>("SELECT raw_path FROM receipts WHERE raw_path IS NOT NULL").all()) {
    try { for (const a of addressesIn(readFileSync(raw_path, "utf8"))) out.add(a); } catch { /* file moved: nothing to scan */ }
    for (const a of realAddressesFor(raw_path)) out.add(a); // real mail: addresses cached next to the .eml (src/ingest/real.ts)
  }
  return [...out].sort();
}

/** Person names from Venmo/Zelle memos: "Venmo – Priya – concert tix" -> Priya, "Zelle to Jane Q Doe" (statements) -> Jane Q Doe. */
export function knownPeople(db: Database): string[] {
  const out = new Set<string>();
  for (const { memo } of db.query<{ memo: string }, []>("SELECT memo FROM transactions WHERE memo IS NOT NULL").all()) {
    const m = /^\s*(?:[Vv]enmo|VENMO|[Zz]elle|ZELLE)(?:\s*[–—-]|\s+(?:to|from))\s*([A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'.-]*){0,4})\s*(?:[–—-]|$)/u.exec(memo);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/** Re-geofences stored receipts after HOME/WORK changes. */
export function relabelReceipts(db: Database): void {
  const places = db.query<Place, []>("SELECT * FROM places").all();
  const put = db.query("UPDATE receipts SET pickup_label = ?, dropoff_label = ? WHERE id = ?");
  db.transaction(() => {
    for (const { id, raw_path } of db.query<{ id: string; raw_path: string }, []>("SELECT id, raw_path FROM receipts").all()) {
      const r = parseReceipt(readFileSync(raw_path, "utf8"), raw_path, places);
      put.run(r.pickup_label, r.dropoff_label, id);
    }
  })();
}
