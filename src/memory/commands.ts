// Text commands for Memory v1: remember …, memories, forget <n>, forget everything (1/2 confirm), and the
// "<merchant> is always mine|hers|split" preference. Replies follow the persona: answer first, one next step.
import { listFacts } from "./facts.ts";
import { friendlyUsd } from "../handlers/afford.ts";
import { desymbolize } from "../cloud/plan.ts";
import { TZ } from "../imessage/clock.ts";
import { applyRentPreference, revertRentPreference } from "./rent.ts";
import type { Database } from "bun:sqlite";
import { resolveMerchant } from "../imessage/lookup.ts";
import { applyPreference, parsePreference, revertPreference, type Owner } from "./prefs.ts";
import { deleteMemory, listMemories, saveMemory, type Memory } from "./store.ts";

export type MemoryCmd =
  | { kind: "remember"; text: string } | { kind: "memories" } | { kind: "forget"; n: number } | { kind: "forgetAll" }
  | { kind: "pref"; merchant: string; owner: Owner };

const SHOWN = 10;
const CONFIRM_WINDOW = 5 * 60;
const WORD: Record<Owner, string> = { me: "mine", her: "hers", shared: "split" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function parseMemoryCommand(raw: string): MemoryCmd | null {
  const t = raw.trim();
  const low = t.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (/^(memories|my memories|what do you remember|what do you remember about me|what do you know about me)$/.test(low)) return { kind: "memories" };
  if (/^forget (everything|all|all memories|all of it)$/.test(low)) return { kind: "forgetAll" };
  const f = /^forget #?(\d{1,3})$/.exec(low);
  if (f) return { kind: "forget", n: Number(f[1]) };
  const pref = parsePreference(t);
  if (pref) return { kind: "pref", ...pref };
  const r = /^remember\s+(?:that\s+)?(.+)$/is.exec(t);
  if (r && r[1].trim()) return { kind: "remember", text: r[1].trim().replace(/\s+/g, " ") };
  return null;
}

const confirmPending = (db: Database, now: number) => {
  const v = (db.query("SELECT value FROM settings WHERE key = 'forget_all_pending'").get() as { value: string } | null)?.value;
  return !!v && now - Number(v) <= CONFIRM_WINDOW;
};
const setConfirm = (db: Database, v: string | null) => v === null
  ? db.run("DELETE FROM settings WHERE key = 'forget_all_pending'")
  : db.run("INSERT INTO settings(key, value) VALUES ('forget_all_pending', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [v]);

/** Is a "forget everything?" question waiting for its 1/2? (It takes bare 1/2 before a who-paid question does.) */
export const forgetAllPending = confirmPending;

function revert(db: Database, m: Memory): number {
  if (m.kind === "note") return revertRentPreference(db, m.txn_ids);
  if (m.kind !== "owner_pref" || !m.txn_ids) return 0;
  return revertPreference(db, JSON.parse(m.txn_ids) as string[]);
}

export function answerForgetAll(db: Database, choice: number, now: number): string {
  setConfirm(db, null);
  if (choice !== 1) return "OK, keeping them.";
  const all = listMemories(db);
  let back = 0;
  db.transaction(() => {
    for (const m of all) { back += revert(db, m); deleteMemory(db, m.id); }
    db.run("DELETE FROM settings WHERE key = 'runway_scenario'"); // the runway what-if is something they told us too
  })();
  return `Done, I've forgotten everything (${all.length} ${all.length === 1 ? "memory" : "memories"}).` +
    (back ? ` ${plural(back, "charge")} back on the usual rules.` : "");
}

/** A stored fact's memory reads as its description with names and its value filled in locally. */
function factLine(db: Database, m: Memory): string | null {
  if (!m.merchant?.startsWith("fact:")) return null;
  const f = listFacts(db).find((x) => x.name === m.merchant!.slice(5));
  if (!f) return null;
  const v = f.unit === "usd" ? friendlyUsd(f.value) : f.unit === "usd_mo" ? `${friendlyUsd(f.value)}/mo`
    : f.unit === "date" ? new Date(f.value * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ })
    : f.unit === "bool" ? (f.value ? "yes" : "no") : f.unit === "months" ? `${Math.round(f.value * 10) / 10} months` : String(f.value);
  return `${desymbolize(db, f.desc, {})}: ${v}`;
}

export function runMemory(db: Database, cmd: MemoryCmd, now: number): string {
  switch (cmd.kind) {
    case "remember": {
      const id = saveMemory(db, { text: cmd.text, now });
      return applyRentPreference(db, cmd.text, now, id) ?? 'Saved. Text "memories" to see everything I remember.';
    }
    case "pref": {
      const merchant = resolveMerchant(db, cmd.merchant) ?? cmd.merchant;
      const { changed, touched } = applyPreference(db, merchant, cmd.owner);
      const text = `${merchant} is always ${WORD[cmd.owner]}`;
      saveMemory(db, { text, now, kind: "owner_pref", merchant, owner: cmd.owner, txnIds: touched });
      if (!touched.length) return `Got it, ${text}. No charges there yet; I'll keep it in mind.`;
      if (!changed.length) return `Got it, ${text}. Its charges were already ${cmd.owner === "shared" ? "split" : cmd.owner === "her" ? "on her side" : "yours"}.`;
      const where = cmd.owner === "her" ? "moved to her side" : cmd.owner === "me" ? "moved to your side" : "now split 50/50";
      return `Got it, ${text}. ${plural(changed.length, "charge")} ${where}.`;
    }
    case "memories": {
      const all = listMemories(db);
      if (!all.length) return "Nothing yet. Text 'remember …' to teach me.";
      const lines = all.slice(0, SHOWN).map((m, i) => `${i + 1}. ${factLine(db, m) ?? m.text}`);
      if (all.length > SHOWN) lines.push(`+${all.length - SHOWN} more`);
      return `What I remember:\n${lines.join("\n")}\n\nText "forget ${Math.min(2, all.length)}" to delete one.`;
    }
    case "forget": {
      const m = listMemories(db)[cmd.n - 1];
      if (!m) return `There's no memory #${cmd.n}. Text "memories" to see the list.`;
      const back = revert(db, m);
      deleteMemory(db, m.id);
      return `Forgot: ${m.text}.` + (back ? ` ${plural(back, "charge")} back on the usual rules.` : "");
    }
    case "forgetAll": {
      const n = listMemories(db).length;
      if (!n) return "Nothing to forget.";
      setConfirm(db, String(now));
      return `Forget all ${n === 1 ? "1 thing" : `${n} things`} I remember? 1 yes · 2 no`;
    }
  }
}
