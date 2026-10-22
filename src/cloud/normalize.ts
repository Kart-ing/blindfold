// One normalizer shared by the symbolizer and the canary, so "BLUEBOTTLE", "uber-eats", "trader joes", "Sephora's"
// and "1 Market St" all line up with the stored "Blue Bottle Coffee", "Uber Eats", "Trader Joe's", "Sephora", "1 Market Street".
// Matching is over token windows compared with spaces removed, aligned to token boundaries.

const SUFFIX: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", boulevard: "blvd", road: "rd", drive: "dr", lane: "ln", place: "pl", court: "ct",
  terrace: "ter", highway: "hwy", parkway: "pkwy",
  // business abbreviations: "mission apts" = "Mission Apartments"
  apartment: "apt", company: "co", incorporated: "inc", corporation: "corp",
  plaza: "plz", square: "sq", circle: "cir", alley: "aly", center: "ctr", centre: "ctr", expressway: "expy", freeway: "fwy",
};
export const STREET_SUFFIX = /^(st|street|ave|avenue|av|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|way|ter|terrace|hwy|highway|pkwy|parkway|plaza|plz|sq|square|cir|circle|aly|alley|ctr|center|expy|fwy)$/i;

const LEET: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" };

export type Tok = { n: string; start: number; end: number };

/** A token's canonical form: lowercase, no apostrophes, street suffixes canonical, a plural/possessive s dropped. */
export function normToken(raw: string): string {
  let t = raw.toLowerCase().replace(/['’]/g, "");
  // Leetspeak inside a word ("Seph0ra", "1yft"); pure numbers are left alone.
  if (/[a-z]/.test(t) && /\d/.test(t)) t = t.replace(/[03457]/g, (d) => LEET[d]);
  t = SUFFIX[t] ?? t;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !/\d/.test(t)) t = t.slice(0, -1);
  t = SUFFIX[t] ?? t;
  // i, l and a leet 1 are one letter for matching ("1KEA", "Pr1ya", "cab1n"). Compare sets via normToken, never raw.
  return /[a-z]/.test(t) ? t.replace(/[il1]/g, "l") : t;
}

// Cyrillic/Greek letters that look Latin ("Sеphora" with a Cyrillic е).
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ո": "n",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "Α": "A", "Β": "B", "Ε": "E", "Ι": "I", "Κ": "K",
  "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y", "Ζ": "Z", "Η": "H",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "g");

/** Before anything else: NFKC (fullwidth digits), lookalike letters, no zero-width chars, straight quotes, "1 0 0 9" → "1009". */
/** Any Unicode decimal digit (Arabic-Indic, Devanagari, ...) → ASCII. Digit blocks are runs of ten starting at 0. */
function asciiDigits(text: string): string {
  return text.replace(/[\u066B\u066C]/g, (c) => (c === "\u066B" ? "." : ",")).replace(/\p{Nd}/gu, (c) => {
    if (c >= "0" && c <= "9") return c;
    const cp = c.codePointAt(0)!;
    let back = 0;
    while (back < 50 && /\p{Nd}/u.test(String.fromCodePoint(cp - back - 1))) back++;
    return String(back % 10);
  });
}

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, grand: 1000, k: 1000 };
const NUMWORD = new RegExp(`\\b(?:${[...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand"].join("|")})(?:(?:[\\s-]+(?:and[\\s-]+)?)(?:${[...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALE)].join("|")})\\b)*\\b`, "gi");

/** One run of number words → digits. Digit-by-digit runs ("zero four two one") concatenate. Unparseable → null. */
function wordsToNumber(run: string): string | null {
  const ws = run.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and");
  if (ws.length >= 2 && ws.every((w) => w in UNITS && UNITS[w] <= 9)) return ws.map((w) => UNITS[w]).join("");
  let total = 0, cur = 0, last: "unit" | "ten" | "scale" | null = null;
  for (const w of ws) {
    if (w in UNITS) { if (last === "unit" || (last === "ten" && UNITS[w] > 9)) return null; cur += UNITS[w]; last = "unit"; }
    else if (w in TENS) { if (last === "unit" || last === "ten") return null; cur += TENS[w]; last = "ten"; }
    else if (w === "hundred") { cur = (cur || 1) * 100; last = "scale"; }
    else if (w in SCALE) { total += (cur || 1) * SCALE[w]; cur = 0; last = "scale"; }
    else return null;
  }
  return String(total + cur);
}

/**
 * Spelled-out numbers → digits, so the number rules (Q_AMT / Q_NUM) apply: "twenty-eight dollars" → "28 dollars",
 * "zero four two one" → "0421". A lone "one" ("which one") stays a word. Fails closed: an unparseable run → "Q_NUM_WORDS".
 */
export function numberWords(text: string): string {
  return asciiDigits(text).replace(NUMWORD, (run) => {
    if (/^one$/i.test(run.trim())) return run;
    return wordsToNumber(run) ?? "Q_NUM_WORDS";
  });
}

export function canon(text: string): string {
  return asciiDigits(text.normalize("NFKC")).replace(CONFUSABLE_RE, (c) => CONFUSABLE[c]).replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "").replace(/[‘’]/g, "'")
    .replace(/(?<!\d)\d(?:[ .\-]\d(?!\d)){3,}/g, (m) => m.replace(/[ .\-]/g, ""));
}

/** Common words a merchant's first word may share with ordinary questions; these never match alone (normalized). */
export const COMMON = new Set<string>(["whole", "blue", "trader", "market", "mission", "coffee", "food", "best", "american", "express", "pacific",
  "health", "plan", "transfer", "chase", "total", "checking", "saving", "visa", "payment", "mint", "mobile", "fitness", "home", "office",
  "neighborhood", "book", "internet", "the", "my", "new", "general", "city", "bay", "golden", "west", "east", "north", "south", "san"].map(normToken));

export function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g)) {
    const n = normToken(m[0]);
    if (n !== "and") out.push({ n, start: m.index!, end: m.index! + m[0].length }); // "pg and e" = "PG&E"
  }
  return out;
}

/** The comparable key of a phrase: its normalized tokens with no spaces. */
export const key = (s: string) => tokens(s).map((t) => t.n).join("");

/** All token windows [i, j) whose joined normalized text equals k. */
export function findKey(toks: Tok[], k: string): [number, number][] {
  const out: [number, number][] = [];
  if (!k) return out;
  for (let i = 0; i < toks.length; i++) {
    if (!k.startsWith(toks[i].n)) continue;
    let acc = "";
    for (let j = i; j < toks.length && acc.length < k.length; j++) {
      acc += toks[j].n;
      if (acc === k) { out.push([i, j + 1]); break; }
      if (!k.startsWith(acc)) break;
    }
  }
  return out;
}

/** Address variants: full, "1550 mission st", "1550 mission" (any or no suffix), "mission st". */
export function addressVariants(address: string): string[] {
  const street = address.split(",")[0].trim();
  const words = street.split(/\s+/);
  const out = new Set([address.trim(), street]);
  const hasNum = /^\d+[a-z]?$/i.test(words[0]);
  const body = hasNum ? words.slice(1) : words;
  const name = STREET_SUFFIX.test(body.at(-1) ?? "") ? body.slice(0, -1) : body;
  if (name.length) {
    if (hasNum) { out.add([words[0], ...name].join(" ")); out.add(body.join(" ")); } // "24 willie mays", "willie mays plaza"
    if (name.length < body.length) out.add(body.join(" "));
  }
  return [...out].filter((f) => key(f).length >= 4);
}

/**
 * Everyday words: never treated as sensitive on their own (memo words, name parts). Keeps ordinary questions and the
 * static prompt from tripping the canary. Compare via normToken.
 */
export const EVERYDAY = new Set<string>(`a about after again all also am an and any are as at back be because been before being below between both
but by can could did do does doing done down during each even every few for from get got had has have having he her here hers him his how i if in
into is it its just last least less like made make many me month months more most much my need never new next no not now of off on once only or
other our out over own pay paid payment per please previous rather really same see send sent she should since so some still such take than that
the their them then there these they this those through to today too under until up us use used very was we week weeks well were what when where
which while who why will with would year years yes yet you your account accounts amount balance bank bill bills budget buy bought card cash charge
charges cost costs credit day days debit deposit deposits dollar dollars expense expenses fee fees income money number numbers owe owed plan
price refund rent save saved saving savings spend spending spent split total transfer transfers trip text texts message ignore instruction
instructions reply answer question questions note dinner lunch breakfast food coffee drink drinks gift gifts party ride rides order orders home
work house thanks thank share shared half friend friends group game games ticket tickets fun stuff thing things time times`.split(/\s+/).filter(Boolean).map(normToken));

// Words that identify nothing on their own: everyday words, statement boilerplate, months/days, street suffixes.
// (Not the COMMON merchant-first-word list: "Whole Foods Market" is all COMMON words and must stay protected.)
const GENERIC_WORDS = `january february march april may june july august september october november december jan feb mar apr jun jul
aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday card debit credit purchase payment pmt pymt
autopay transfer withdrawal deposit fee charge charged interest monthly paid online mobile digital bank check atm pos ach
recurring subscription cash general one plan time store service svc pay inc llc co corp ltd usa us com www tst dba from to
the a an of and for at in on with by via st ave blvd rd dr ln pl ct way ter hwy pkwy plz sq cir aly ctr spending spend
changed change since month trip subscription budget saving income rent bill`;
export const GENERIC = new Set<string>([...EVERYDAY, ...GENERIC_WORDS.split(/\s+/).filter(Boolean).map(normToken)]);

/** True when s has a word that could identify something: not generic, not a number, three or more letters. */
export function distinctive(s: string): boolean {
  return tokens(s).some((t) => t.n.length >= 3 && /[a-z]/.test(t.n) && !GENERIC.has(t.n));
}

