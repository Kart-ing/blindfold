// Local symbol table + question symbolization (T2 prep). The symbols table never leaves the Mac;
// the cloud only ever sees MERCHANT_n / ACCOUNT_n / PERSON_n / HOME / WORK / ADDR_n / Q_AMT_n / Q_NUM_n.
import type { Database } from "bun:sqlite";
import { knownPeople } from "../ingest/receipts.ts";
import { COMMON, EVERYDAY, GENERIC, addressVariants, canon, distinctive, numberWords, findKey, key, normToken, tokens } from "./normalize.ts";

const STOP = new Set(["the", "a", "an", "of", "to", "from", "and", "for", "at", "in", "on", "&", "payment", "transfer"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const stripStoreNo = (s: string) => s.replace(/\s+#?\d+\s*$/, "").replace(/\s+/g, " ").trim(); // "BLUE BOTTLE COFFEE #123" → "BLUE BOTTLE COFFEE"

/** The forms of a merchant name a person might type: full, without store number, and 2+ word prefixes. */
export function merchantForms(merchant: string): string[] {
  const forms = new Set([merchant.trim(), stripStoreNo(merchant)]);
  // Punctuation-only "words" ("-", "*", "#") never start or end a sub-form: "LATE FEE - AUG" has no "FEE -".
  const words = stripStoreNo(merchant).split(" ").filter((w) => /[A-Za-z0-9]/.test(w));
  for (let k = 2; k < words.length; k++) if (!STOP.has(words[k - 1].toLowerCase())) forms.add(words.slice(0, k).join(" "));
  // Any other contiguous run of 2+ words ("Bottle Coffee"), if it has a distinctive word and doesn't start or end on a filler.
  for (let i = 1; i < words.length; i++) for (let j = i + 2; j <= words.length; j++) {
    const run = words.slice(i, j);
    const edge = (w: string) => STOP.has(w.toLowerCase());
    if (!edge(run[0]) && !edge(run.at(-1)!) && run.some((w) => !COMMON.has(normToken(w)) && !STOP.has(w.toLowerCase()))) forms.add(run.join(" "));
  }
  // A distinctive first word alone ("IKEA", "Harbor", "Sonic"), never a common one ("Whole", "Blue", "Mission").
  const first = normToken(words[0]);
  if (words.length > 1 && first.length >= 4 && !/\d/.test(first) && !COMMON.has(first) && !STOP.has(words[0].toLowerCase())) forms.add(words[0]);
  // Real statement text is messy ("Debit Card Purchase - …", "Monthly Interest Paid"): a partial form must have a
  // distinctive word, or it would match ordinary questions. The full name always counts, verbatim.
  const full = new Set([merchant.trim(), stripStoreNo(merchant)]);
  return [...forms].filter((f) => f.length >= 3 && (full.has(f) || distinctive(f)));
}

/** A person's full name and each distinctive part ("Priya Shah" → "Priya", "Shah"). */
export const personForms = (name: string) => [name, ...name.split(/\s+/).filter((w) => w.length >= 3 && !EVERYDAY.has(normToken(w)))].filter(distinctive);

/** Address forms: full, street line, "1550 mission" (any or no suffix), "mission street". */
export const addressForms = addressVariants;

function upsert(db: Database, kind: string, prefix: string, reals: string[]) {
  const have = new Set((db.query("SELECT real FROM symbols WHERE kind = ?").all(kind) as { real: string }[]).map((r) => r.real));
  let n = (db.query("SELECT COUNT(*) AS c FROM symbols WHERE kind = ?").get(kind) as { c: number }).c;
  for (const real of reals) {
    if (!real || have.has(real)) continue;
    // Skip symbol numbers already taken (stable: existing symbols are never renumbered).
    while (db.query("SELECT 1 FROM symbols WHERE symbol = ?").get(`${prefix}_${++n}`));
    db.run("INSERT INTO symbols(symbol, real, kind) VALUES (?, ?, ?)", [`${prefix}_${n}`, real, kind]);
    have.add(real);
  }
}

/** Fills the symbols table. Idempotent; a real value keeps its symbol forever. */
export function buildSymbols(db: Database): void {
  db.transaction(() => {
    const merchants = (db.query("SELECT DISTINCT merchant FROM transactions WHERE merchant IS NOT NULL AND merchant != '' ORDER BY merchant").all() as { merchant: string }[]).map((r) => r.merchant);
    upsert(db, "merchant", "MERCHANT", merchants);
    const masks = (db.query("SELECT DISTINCT mask FROM accounts WHERE mask IS NOT NULL AND mask != '' ORDER BY id").all() as { mask: string }[]).map((r) => r.mask);
    upsert(db, "account", "ACCOUNT", masks);
    upsert(db, "person", "PERSON", knownPeople(db));
    for (const p of db.query("SELECT label, address FROM places WHERE label IN ('HOME', 'WORK') AND address IS NOT NULL").all() as { label: string; address: string }[]) {
      db.run("INSERT INTO symbols(symbol, real, kind) VALUES (?, ?, 'place') ON CONFLICT(symbol) DO UPDATE SET real = excluded.real", [p.label, p.address]);
    }
  })();
}

export const symbolFor = (db: Database, kind: string, real: string) =>
  (db.query("SELECT symbol FROM symbols WHERE kind = ? AND real = ?").get(kind, real) as { symbol: string } | null)?.symbol ?? null;
/** Merchants that appear only on her rows. Out of scope everywhere: never sent, not even as symbols. */
export function herOnlyMerchants(db: Database): string[] {
  return (db.query(`SELECT t.merchant AS m FROM transactions t LEFT JOIN attributions a ON a.txn_id = t.id
      WHERE t.merchant IS NOT NULL GROUP BY t.merchant HAVING SUM(COALESCE(a.owner, '') != 'her') = 0`).all() as { m: string }[]).map((r) => r.m);
}

export const realFor = (db: Database, symbol: string) =>
  (db.query("SELECT real FROM symbols WHERE symbol = ?").get(symbol) as { real: string } | null)?.real ?? null;

// Money: "$43.12", "$1,500", "$1.5k", "400 dollars", "43.12". Bare integers without $ / dollars / decimals are left to the Q_NUM rule.
// Money: "$43.12", "$1.5k", "400 dollars", "43.12", "1700$", "10k", and a bare number after a money word ("save 40000").
const MONEY_WORD = "save|saving|saved|savings|goal|budget|have|has|had|got|balance|worth|rent|pay|paying|paid|cost|costs|spend|spent|around|about|approx|approximately|roughly|over|under";
const AMOUNT = new RegExp(["\\$\\s*\\d[\\d,]*(?:\\.\\d{1,2})?(?:\\s?k\\b)?", "\\b\\d[\\d,]*(?:\\.\\d{1,2})?(?:\\s?k)?\\s*(?:dollars|bucks|usd)\\b",
  "\\b\\d[\\d,]*\\.\\d{2}\\b", "\\b\\d[\\d,]*(?:\\.\\d{1,2})?\\s?\\$", "\\b\\d[\\d,]*(?:\\.\\d+)?\\s?k\\b",
  `(?<=\\b(?:${MONEY_WORD})\\s+(?:(?:of|is|was|around|about|like|roughly)\\s+)?)\\d[\\d,]*(?:\\.\\d{1,2})?\\b`].join("|"), "gi");
const LONG_NUM = /\d{4,}/g;
// The name must not run into "_" or a digit: an already-placed symbol (PERSON_5, MERCHANT_2) is never a new name.
const REL_CUE = /\b((?:my\s+)?(?:friend|girlfriend|gf|boyfriend|bf|roommate|flatmate|wife|husband|partner|mom|mum|dad|mother|father|brother|sister|cousin|boss|landlord|landlady|colleague|coworker)\s+)([A-Za-z][a-z'’]+)(?![\w'’])/gi;
const PAY_CUE = /\b((?:send|sent|sending|pay|paid|paying|zelle|zelled|venmo|venmoed|owe|owes|owed|lend|lent|lending|borrow|borrowed|split|splitting)\s+(?:it\s+with\s+|with\s+)?)([A-Za-z][a-z'’]+)(?![\w'’])/gi;
// "to"/"from" are weak cues: one capitalized word NOT followed by another, so "to Willie Mays Plaza" stays whole (canary).
const WEAK_CUE = /\b((?:[Tt]o|[Ff]rom|[Ww]ith|[Ff]or)\s+)([A-Z][a-z'’]+)(?![\w'’])(?!\s+[A-Z])/g;
// Research only: a capitalized word right before a person's verb ("Maya recommended it") is a name.
const PERSON_VERB = /\b([A-Z][a-z'’]+)(\s+(?:recommended|suggested|mentioned|told me|swears by|lent me|gave me|showed me|got me|bought me))\b/g;
// Common English words that get capitalized mid-sentence (pronouns, emphasis, greetings, titles); never names.
const COMMON_EN = new Set(`i im ive ill id me my mine we us our you your he she it they them their this that these those what which who whom
whose when where why how yes no not ok okay alright hi hello hey thanks thank please sorry wow cool great good bad nice sure yeah yep nope
also just only really very so too then than but and or if because cause since though although however anyway btw lol omg
can could would should will shall may might must do does did done have has had am is are was were be been being get got go going
gonna wanna gotta let lets make made take took want need like love hate know think see look tell ask say said use used try
new old big small little more most less least many much some any all every each other another same different first last next
dear mr mrs ms dr sir madam team guys folks everyone everybody somebody someone anyone nothing something everything
monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday tonight morning evening night weekend
christmas thanksgiving easter halloween new year eve holiday holidays summer winter spring fall autumn
bank card cash savings checking credit debit visa mastercard amex account accounts budget goal goals plan rent bills bill
dollar dollars usd k grand total income salary paycheck job work startup company business roth ira opt
compare show list remind track cancel give find help check explain break sum calculate add remove delete forget remember set save spend
pay send buy sell move transfer split lend borrow owe count estimate project predict forecast summarize summarise review update change
stop start keep put call text email open close book order quick now here there well actually basically honestly maybe perhaps oh ah
um hmm nah sounds wait cool awesome perfect exactly true right wrong done finally please also off up down back
money taxes tax fees fee interest loan loans debt tuition insurance utilities groceries grocery dinner lunch breakfast drinks coffee
rent bills it him her them everyone people bucks half everything stuff things deposit subscription subscriptions netflix`.split(/\s+/).filter(Boolean));
// Never names, even capitalized after a cue: pronouns and words a sentence often puts there.
const NOT_NAMES = new Set(["her", "him", "them", "us", "everyone", "someone", "somebody", "nobody", "people", "family", "landlord", "rent",
  "cash", "venmo", "zelle", "paypal", "apple", "google", "amazon", "japan", "india", "china", "europe", "mexico", "canada"].map(normToken));
export const BILL_WORDS_RAW = ["bill", "charge", "payment", "subscription", "membership", "order", "statement", "plan", "fee"];
export const BILL_WORDS = new Set(BILL_WORDS_RAW.map(normToken));
const MONTHS_RE = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const MONTH_WORD = new RegExp(`^\\s*(months?|mo|weeks?|days?|years?|(${MONTHS_RE})\\b)`);
const MONTH_WORD_BEFORE = new RegExp(`\\b(${MONTHS_RE}|last|past|top)\\s*$`);
const STREET_ADDR = /\b\d{1,5}[a-z]?\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:st|street|ave|avenue|av|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|way|ter|terrace|hwy|highway|pkwy|parkway|plaza|plz|sq|square|cir|circle|aly|alley|ctr|center|expy|fwy)\b\.?/gi;

export function amountCents(s: string): number | null {
  const m = s.match(/(\d[\d,]*)(\.\d{1,2})?\s*(k)?/i);
  if (!m) return null;
  const v = (Number(m[1].replace(/,/g, "")) + (m[2] ? Number(m[2]) : 0)) * (m[3] ? 1000 : 1);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

/**
 * Replaces real values in the user's question with symbols. qsyms maps Q_AMT_n → cents (as a string) and
 * Q_NUM_n → the original digits; it stays local and is used to fill the reply.
 */
/**
 * research: a web lookup (research.ts), where product and brand names are the query. Capitalized words stay (no
 * name-shape guess, no to/from/for cue) and so do numbers up to four digits ("iPhone 17", "RTX 5090"); people the data
 * knows, names after a person cue ("my friend Maya", "Maya recommended"), merchants, accounts, addresses and amounts are
 * still symbols, and the canary still scans the bytes. Person symbols an earlier message guessed aren't applied there.
 * originals: what the user typed for each merchant symbol.
 */
export function symbolizeText(db: Database, raw: string, opts: { research?: boolean } = {}):
  { text: string; qsyms: Record<string, string>; hers: string[]; originals: Record<string, string> } {
  buildSymbols(db);
  const research = !!opts.research;
  const known = research ? new Set(knownPeople(db).map((p) => p.toLowerCase())) : null;
  const text = numberWords(canon(raw));
  const qsyms: Record<string, string> = {};
  // 1. Entities, matched on normalized token windows (case, apostrophes, hyphens, spacing and street suffixes
  //    don't matter), longest form first so "Uber Eats" wins over "Uber" and full addresses over street names.
  const rows = db.query("SELECT symbol, real, kind FROM symbols").all() as { symbol: string; real: string; kind: string }[];
  const forms: { k: string; symbol: string }[] = [];
  for (const r of rows) {
    if (known && r.kind === "person" && !known.has(r.real.toLowerCase())) continue;
    const fs = r.kind === "merchant" ? merchantForms(r.real) : r.kind === "place" ? addressForms(r.real) : r.kind === "person" ? personForms(r.real) : [];
    for (const f of fs) { const k = key(f); if (k.length >= 3) forms.push({ k, symbol: r.symbol }); }
  }
  forms.sort((a, b) => b.k.length - a.k.length);
  const toks = tokens(text);
  const taken = new Array(toks.length).fill(false);
  const spans: { start: number; end: number; symbol: string }[] = [];
  for (const f of forms) {
    for (const [i, j] of findKey(toks, f.k)) {
      if (taken.slice(i, j).some(Boolean)) continue;
      for (let x = i; x < j; x++) taken[x] = true;
      spans.push({ start: toks[i].start, end: toks[j - 1].end, symbol: f.symbol });
    }
  }
  // A stoplisted first word still counts when a billing word follows: "the mint bill" → "the MERCHANT_12 bill".
  for (const r of rows.filter((r) => r.kind === "merchant")) {
    const words = stripStoreNo(r.real).split(" ");
    if (words.length < 2 || !COMMON.has(normToken(words[0])) || GENERIC.has(normToken(words[0]))) continue; // not "the plan"
    for (let i = 0; i + 1 < toks.length; i++) {
      if (!taken[i] && toks[i].n === normToken(words[0]) && BILL_WORDS.has(toks[i + 1].n)) {
        taken[i] = true;
        spans.push({ start: toks[i].start, end: toks[i].end, symbol: r.symbol });
      }
    }
  }
  let out = text;
  const originals: Record<string, string> = {};
  for (const sp of spans.sort((a, b) => b.start - a.start)) { originals[sp.symbol] ??= text.slice(sp.start, sp.end); out = out.slice(0, sp.start) + sp.symbol + out.slice(sp.end); }
  const herSyms = new Set(herOnlyMerchants(db).map((m) => symbolFor(db, "merchant", m)));
  const hers = [...new Set(spans.map((sp) => sp.symbol).filter((x) => herSyms.has(x)))];
  // An unknown street address ("12 Oak Ave") still never leaves: → ADDR_n.
  let ad = 0;
  out = out.replace(STREET_ADDR, (m) => { const sym = `ADDR_${++ad}`; qsyms[sym] = m; return sym; }); // original kept locally for the reply
  // People the DB doesn't know ("my friend Priya", "I send Priya the rent"): a name after a relationship word (any case)
  // or a payment/direction word (capitalized) becomes PERSON_n and is saved as a person symbol. Fails toward symbolizing.
  const asPerson = (cue: string, name: string, m: string) => {
    const n = normToken(name);
    if (n.length < 3 || GENERIC.has(n) || EVERYDAY.has(n) || COMMON.has(n) || NOT_NAMES.has(n)) return m;
    const real = name[0].toUpperCase() + name.slice(1).toLowerCase();
    const have = db.query("SELECT symbol FROM symbols WHERE kind = 'person' AND lower(real) = lower(?)").get(real) as { symbol: string } | null;
    if (!have) upsert(db, "person", "PERSON", [real]);
    return `${cue}${have?.symbol ?? symbolFor(db, "person", real)}`;
  };
  // First, any Capitalized word, or run of them ("Maya Chen" stays one person), that isn't a
  // common English word, a month or weekday, an acronym, or a word of a known merchant: a name → PERSON_n. Fails toward
  // symbolizing (with no local model, this is the privacy net for names the DB has never seen).
  const merchantWords = new Set(rows.filter((r) => r.kind === "merchant").flatMap((r) => tokens(r.real).map((t) => t.n)));
  const plainWord = (w: string) => { const n = normToken(w); const l = w.toLowerCase().replace(/['’]/g, "");
    return COMMON_EN.has(l) || GENERIC.has(n) || EVERYDAY.has(n) || COMMON.has(n) || NOT_NAMES.has(n) || merchantWords.has(n); };
  if (!research) out = out.replace(/\b[A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+)*\b(?![\w'’])/g, (run: string, at: number, whole: string) => {
    const words = run.split(/\s+/);
    const keep = words.map((w) => !plainWord(w)); // a sentence opener counts too unless it's a common word ("Zorya covered dinner")
    if (!keep.some(Boolean)) return run;
    // Symbolize each maximal stretch of name-like words; leave the others as written.
    const parts: string[] = [];
    for (let i = 0; i < words.length;) {
      if (!keep[i]) { parts.push(words[i++]); continue; }
      let j = i; while (j < words.length && keep[j]) j++;
      parts.push(asPerson("", words.slice(i, j).join(" "), words.slice(i, j).join(" ")));
      i = j;
    }
    return parts.join(" ");
  });
  out = out.replace(REL_CUE, (m, cue: string, name: string) => asPerson(cue, name, m));
  // After a payment word, a lowercase name counts too ("I sent zorya the rent"), unless it's a common word.
  out = out.replace(PAY_CUE, (m, cue: string, name: string) => (plainWord(name) ? m : asPerson(cue, name, m)));
  if (!research) out = out.replace(WEAK_CUE, (m, cue: string, name: string) => asPerson(cue, name, m));
  else out = out.replace(PERSON_VERB, (m, name: string, verb: string) => (plainWord(name) ? m : `${asPerson("", name, name)}${verb}`));
  // A payment app is a merchant symbol by now ("I MERCHANT_30 Maya"): the capitalized word after it is a person.
  const apps = rows.filter((r) => r.kind === "merchant" && /^(zelle|venmo|paypal|cash ?app)\b/i.test(r.real)).map((r) => r.symbol);
  if (apps.length) out = out.replace(new RegExp(`\\b((?:${apps.join("|")})\\s+(?:to\\s+|from\\s+)?)([A-Z][a-z'’]+)(?![\\w'’])`, "g"), (m, cue: string, name: string) => asPerson(cue, name, m));
  // 2. Masks typed in a sentence ("card ending 0421") → ACCOUNT_n.
  for (const r of rows.filter((r) => r.kind === "account")) {
    out = out.replace(new RegExp(`(?<!\\d)${escapeRe(r.real)}(?!\\d)`, "g"), r.symbol);
  }
  // 3. Money → Q_AMT_n, then any remaining run of 4+ digits → Q_NUM_n.
  let a = 0, n = 0;
  out = out.replace(AMOUNT, (m) => {
    // A bare number counts as money only after a money word, from 100 up, and never as a year ("save 40000", not "about 3").
    if (/^[\d,]+(\.\d+)?$/.test(m.trim()) && (/^20\d\d$/.test(m.trim()) || Number(m.replace(/,/g, "")) < 100)) return m;
    const sym = `Q_AMT_${++a}`;
    qsyms[sym] = String(amountCents(m) ?? 0);
    return sym;
  });
  out = out.replace(research ? /\d{5,}/g : LONG_NUM, (m) => {
    if (/^20\d\d$/.test(m)) return m; // a year
    const sym = `Q_NUM_${++n}`;
    qsyms[sym] = m;
    return sym;
  });
  // Every other number too, except small counts next to a month word or "top", and years: "86,40", "28 each" → Q_.
  out = out.replace(/\b\d+(?:[.,]\d+)?\b/g, (m, at: number, s: string) => {
    const v = Number(m.replace(",", "."));
    const before = s.slice(Math.max(0, at - 12), at).toLowerCase(), after = s.slice(at + m.length, at + m.length + 12).toLowerCase();
    if (/^\d+$/.test(m) && v >= 1 && v <= 12 && (MONTH_WORD.test(after) || MONTH_WORD_BEFORE.test(before) || /\btop\s*$/.test(before))) return m;
    if (/^20\d\d$/.test(m)) return m;
    if (/^\d{1,3},\d{2}$/.test(m)) { const sym = `Q_AMT_${++a}`; qsyms[sym] = String(Math.round(v * 100)); return sym; }
    if (research) return m; // a model number; the canary still blocks one that matches the user's data
    const sym = `Q_NUM_${++n}`;
    qsyms[sym] = m;
    return sym;
  });
  return { text: out, qsyms, hers, originals };
}
