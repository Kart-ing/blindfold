// `bun run rehearse`: the pre-stage check. Plays every beat in DEMO.md, in order, on a fresh demo DB through the same
// agent the CLI and iMessage use, and checks each reply against DEMO.md. Prints PASS/FAIL per beat; exits 1 on any FAIL.
//   --live-cloud   use the real cloud provider (egress's default) instead of a canned plan; `expect-dry` lines are skipped
//   --voice-cloud  Luna on (VOICE=cloud, live provider): a reply that isn't the computed template is checked on facts only
//                  (voice: facts + every number of the plain reply, nothing unsupplied, nothing left unfilled), no wording
//   --voice-device opt in to Apple's on-device model (VOICE=device + LOCAL_MODELS=on; bin/fm routes and words): a `voice:`
//                  reply that isn't the computed template is checked on facts
// Otherwise routing is by keywords: the agent runs no local models, and Luna only runs under --voice-cloud.
// DEMO.md is the single source of truth: each ```rehearse block has `type:`, one `expect:` per reply (`*` = any text, `\n` =
// line break), `expect-dry:` (canned-plan runs only), `voice:` and `check:` lines (tier <t> | cloud | not-sent <text> | owner <txn> <owner>).
// The default run forces VOICE=plain (no model wording): every reply is checked exactly. `voice: A | B` lines list the facts
// a reply must keep when it is model-worded (--voice-cloud, --voice-device).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { converseModel, REQUIRED_ENV, selectedBackend, setProvider } from "../src/cloud/egress";
import { BLOCKED, CANNED, SYSTEM_PROMPT, UNREACHABLE } from "../src/cloud/plan";
import { fm, noFm } from "../src/imessage/fm";
import { MemoryTransport } from "../src/imessage/transport";
import { DEMO_NOW, rebuild } from "../src/ingest/seed";
import { makeAgent } from "../src/main";
import { cloudFactProblems, factProblems, matches, parseDemo, RAW_SYMBOL } from "./rehearse-lib";

const root = join(import.meta.dir, "..");
// VOICE: plain = the computed templates, device = on-device wording, cloud = Luna (src/imessage/luna.ts). The app reads it
// from the environment, so the default run forces plain (deterministic, every reply exact) whatever .env says.
const VOICE = process.argv.includes("--voice-cloud") ? "cloud" : process.argv.includes("--voice-device") ? "device" : "plain";
process.env.VOICE = VOICE;
// No local models unless --voice-device (src/imessage/fm.ts: bin/fm only runs with LOCAL_MODELS=on), whatever .env says.
process.env.LOCAL_MODELS = VOICE === "device" ? "on" : "off";
// Luna is a cloud model, so --voice-cloud runs against the live provider.
const LIVE = process.argv.includes("--live-cloud") || VOICE === "cloud";

const beats = parseDemo(readFileSync(join(root, "DEMO.md"), "utf8"));
// Always a fresh throwaway DB, never FIN_DB: rebuild() deletes its target, and data/fin.db may be the live demo's.
const dbPath = join(mkdtempSync(join(tmpdir(), "rehearse-")), "fin.db");
if ([join(root, "data", "fin.db"), process.env.FIN_DB].some((p) => p && resolve(p) === resolve(dbPath))) throw new Error("refusing to rehearse on a live DB");
const { db } = rebuild(dbPath);

const payloads: string[] = [];
if (!LIVE) {
  // A canned plan: the worked example from the system prompt. Egress still symbolizes, scans and blocks exactly as live.
  const plan = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.lastIndexOf('{"steps"'));
  // The configured backend's wire format, as on stage, so the canary scans the same bytes. Only egress.ts names providers.
  // The fake planner has no wire of its own, so it keeps egress's default encoding (and the canned answers stay unlabelled).
  const wire = selectedBackend().name;
  setProvider(async (body) => { payloads.push(body); return { content: [{ type: "text", text: plan } ] }; }, wire === "fake" ? undefined : wire);
}
// No local models: keyword routing, as the agent does without Luna. Only --voice-device opts into the on-device model.
const useFm = VOICE === "device" && (await fm.extract("ping", { type: "object", properties: { ok: { type: "boolean" } } }).catch(() => null)) !== null;
const t = new MemoryTransport();
const agent = makeAgent(db, t, { cli: true, fm: useFm ? fm : noFm, now: () => DEMO_NOW });
await t.start(agent.onText);
console.log(`rehearse: ${beats.length} beats · cloud ${LIVE ? "LIVE" : "canned plan"} · routing ${VOICE === "cloud" ? "Luna (keywords if it fails)" : useFm ? "on-device model" : "keywords"} · voice ${VOICE}\ndb: ${dbPath}\n`);

let failed = 0;
const report = (ok: boolean, title: string, problems: string[], got: string[] = [], info: string[] = []) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${title}`);
  for (const p of problems) console.log(`      ✗ ${p}`);
  for (const i of info) console.log(`      · ${i.replace(/\n/g, "\n        ")}`);
  if (!ok) for (const g of got) console.log(`      < ${g.replace(/\n/g, "\n        ")}`);
  if (!ok) failed++;
};

// Preflight: SUBMISSION.md and DEMO.md name the cloud planner's model; the configured backend's model must be that one
// (compared ignoring case and hyphens, so "gpt-x-y" matches "GPT-x Y"). Fake, or any model the docs don't name, fails here.
const backend = selectedBackend();
const loose = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, " ");
const preflight: string[] = [];
const submission = loose(readFileSync(join(root, "SUBMISSION.md"), "utf8"));
if (!submission.includes(loose(backend.model)))
  preflight.push(`SUBMISSION.md doesn't name the configured planner model "${backend.model}" (LLM_PROVIDER=${backend.name})`);
if (VOICE === "cloud" && !submission.includes(loose(converseModel())))
  preflight.push(`SUBMISSION.md doesn't name the configured conversation model "${converseModel()}"`);
const missing = LIVE ? (REQUIRED_ENV[backend.name] ?? []).filter((k) => !process.env[k]) : [];
if (missing.length) preflight.push(`missing in .env: ${missing.join(", ")}`);
report(!preflight.length, `preflight: cloud planner is ${backend.name} (${backend.model})${VOICE === "cloud" ? `, Luna is ${converseModel()}` : ""}, as SUBMISSION.md claims`, preflight);
// --voice-device rehearses the on-device model; silently falling back to keywords would rehearse something else.
if (VOICE === "device") report(useFm, "preflight: the on-device model answers (--voice-device)", useFm ? [] :
  ["bin/fm did not answer. It is gitignored, so a fresh checkout has none: run fm/build.sh or set FM_BIN."]);

for (const b of beats) {
  const ledgerBefore = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM ledger").get() as { m: number }).m;
  const sentBefore = payloads.length;
  t.sent.splice(0);
  const t0 = performance.now();
  await t.receive(b.type);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const got = t.sent.splice(0);
  const want = [...b.expect, ...(LIVE ? b.dry.map(() => "*") : b.dry)];
  const problems: string[] = [];
  if (got.length !== want.length) problems.push(`expected ${want.length} replies, got ${got.length}`);
  want.forEach((w, i) => {
    if (got[i] === undefined || matches(w, got[i])) return;
    // Not the computed template: a model-worded reply passes on facts (any reply under Luna, `voice:` replies on-device).
    const facts = VOICE === "cloud" ? b.voice[i] ?? [] : VOICE === "device" ? b.voice[i] : undefined;
    const check = VOICE === "cloud" ? cloudFactProblems : factProblems;
    if (facts) for (const p of check(got[i], w, facts)) problems.push(`reply ${i + 1}: ${p}`);
    else problems.push(`reply ${i + 1} differs; want: ${w}`);
  });
  const rows = db.query("SELECT tier, canary_hits, payload_json FROM ledger WHERE id > ? AND COALESCE(intent, '') <> 'command'").all(ledgerBefore) as
    { tier: string; canary_hits: number | null; payload_json: string | null }[];
  const sent = LIVE ? rows.map((r) => r.payload_json ?? "").join("\n") : payloads.slice(sentBefore).join("\n");
  for (const c of b.checks) {
    const [kind, ...rest] = c.split(" ");
    if (kind === "tier" && VOICE === "cloud") continue; // facts only: a cloud-worded reply is logged "cloud" by design
    if (kind === "tier") {
      // Under VOICE=device a phrased local answer is logged "on-device"; both tiers mean it never left the Mac.
      const ok = rows[0]?.tier === rest[0] || (VOICE === "device" && rest[0] === "local" && rows[0]?.tier === "on-device");
      if (!ok) problems.push(`ledger tier ${rows[0]?.tier ?? "none"}, want ${rest[0]}`);
    }
    else if (kind === "cloud") {
      if (rows[0]?.tier !== "cloud") problems.push(`ledger tier ${rows[0]?.tier ?? "none"}, want cloud`);
      if ((rows[0]?.canary_hits ?? 0) !== 0) problems.push(`canary_hits ${rows[0]?.canary_hits}, want 0`);
      if (!sent) problems.push("nothing was sent to the cloud planner");
      // The body is logged even when the call fails, so also require a real answer (catches a bad key or model with --live-cloud).
      const failure = got.find((g) => [UNREACHABLE, CANNED, BLOCKED].includes(g));
      if (failure) problems.push(`the planner failed: ${failure}`);
      const raw = got.map((g) => RAW_SYMBOL.exec(g)?.[0]).find(Boolean);
      if (raw) problems.push(`the reply shows a raw symbol: ${raw}`);
    } else if (kind === "not-sent") {
      const needle = rest.join(" ").toLowerCase();
      if (sent.toLowerCase().includes(needle)) problems.push(`payload contains "${needle}"`);
    } else if (kind === "owner") {
      const r = db.query("SELECT owner, labelled_by_user FROM attributions WHERE txn_id = ?").get(rest[0]) as { owner: string; labelled_by_user: number } | null;
      if (r?.owner !== rest[1] || !r?.labelled_by_user) problems.push(`${rest[0]} owner ${r?.owner}, labelled ${r?.labelled_by_user}; want ${rest[1]}, labelled`);
    } else problems.push(`unknown check: ${c}`);
  }
  // --live-cloud: the cloud beats' expectations are wildcards, so show what the real planner said and what it took.
  const info: string[] = [];
  if (LIVE && b.checks.includes("cloud")) {
    const r = db.query("SELECT payload_json, canary_checked, canary_hits, partial_count FROM ledger WHERE id > ? AND tier = 'cloud' ORDER BY id LIMIT 1")
      .get(ledgerBefore) as { payload_json: string | null; canary_checked: number | null; canary_hits: number | null; partial_count: number | null } | null;
    const body = (r?.payload_json ?? "").trim();
    const calls = !body ? 0 : body.startsWith("[") ? (JSON.parse(body) as unknown[]).length : 1;
    info.push(`planner calls ${calls} · canary ${r?.canary_hits ?? "?"} hits / ${r?.canary_checked ?? "?"} values · partial ${r?.partial_count ?? 0}`, ...got.map((g) => `reply: ${g}`));
  }
  report(!problems.length, `${b.title}  > ${b.type}  (${secs}s)`, problems, got, info);
}

console.log(failed ? `\n${failed} FAIL: not ready for stage` : "\nALL PASS");
db.close();
process.exit(failed ? 1 : 0);
