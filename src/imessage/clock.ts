// Local wall-clock helpers. All timestamps are unix seconds; "local" means FIN_TZ.
export const TZ = process.env.FIN_TZ ?? "America/Los_Angeles";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number };

export function localParts(now: number): LocalParts {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(new Date(now * 1000))) if (type !== "literal") p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, ss: p.second };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (now: number) => { const p = localParts(now); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
export const monthKey = (now: number) => { const p = localParts(now); return `${p.y}-${pad(p.m)}`; };
export const minuteOfDay = (now: number) => { const p = localParts(now); return p.hh * 60 + p.mm; };

/** Quiet hours: 22:00 to 08:00 local. */
export const isQuiet = (now: number) => { const t = minuteOfDay(now); return t >= 22 * 60 || t < 8 * 60; };

/** Unix seconds for a local wall-clock time, found by correcting the UTC guess by the observed offset. */
export function fromLocal(y: number, m: number, d: number, hh = 0, mm = 0): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / 1000 - Date.UTC(y, m - 1, d, hh, mm) / 1000;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export const startOfDay = (now: number) => { const p = localParts(now); return fromLocal(p.y, p.m, p.d); };
export const startOfMonth = (now: number) => { const p = localParts(now); return fromLocal(p.y, p.m, 1); };
export const daysInMonth = (now: number) => { const p = localParts(now); return new Date(Date.UTC(p.y, p.m, 0)).getUTCDate(); };

/** Today (local) at "HH:MM"; null if the string is not a valid time. */
export function atLocal(now: number, hhmm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  const p = localParts(now);
  return fromLocal(p.y, p.m, p.d, Number(m[1]), Number(m[2]));
}

/** "$12" for whole dollars, "$12.34" otherwise. */
export const money = (cents: number) => {
  const c = Math.round(Math.abs(cents));
  return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
};
/** Rounded to whole dollars, for nudges. */
export const dollars = (cents: number) => `$${Math.round(Math.abs(cents) / 100)}`;
