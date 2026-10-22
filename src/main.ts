// Agent entry point. `bun run src/main.ts --cli` talks on the terminal; without --cli it uses local iMessage (OWNER_HANDLE only).
import { openDb } from "./db.ts";
import { atLocal } from "./imessage/clock.ts";
import { CliTransport } from "./imessage/cli.ts";
import { consentPending, setConsentSender, takeConsentAnswer } from "./imessage/consent.ts";
import { fm, localModelsOn, noFm } from "./imessage/fm.ts";
import { maybePrompt } from "./imessage/prompts.ts";
import { route, writeLedger } from "./imessage/router.ts";
import type { Transport } from "./imessage/transport.ts";
import { runScheduler } from "./nudges/scheduler.ts";
import { startDemoServer } from "./nudges/server.ts";
import type { Database } from "bun:sqlite";

const nowSec = () => Math.floor(Date.now() / 1000);

/** One FIFO lane for everything that reads-then-writes prompts/nudges, so limits can't be raced. */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// Not "other": a cloud answer ends clean (the canary beat), with no question riding along.
const REAL_ANSWERS = new Set(["afford", "goal_set", "goal_status", "spend_query"]);

export function makeAgent(db: Database, transport: Transport, opts: { cli?: boolean; fm?: typeof fm; now?: () => number } = {}) {
  const lane = serial();
  const clock = opts.now ?? nowSec;
  const send = (t: string) => transport.send(t);

  const tick = (at: string) => {
    const t = atLocal(clock(), at);
    if (t === null) return Promise.resolve(null);
    return lane(async () => {
      // Ticks only fire nudges; who-paid prompts piggyback on answers, so each demo beat is one message.
      return { at, ...(await runScheduler(db, t, { send, fm: opts.fm })) };
    });
  };

  const onText = async (text: string) => {
    // A cloud handler may be blocked inside the lane waiting for this very answer, so consent answers skip the queue.
    if (consentPending()) {
      const r = takeConsentAnswer(text);
      if (r) {
        writeLedger(db, { now: clock() }, "command", { text: r, tier: "local" });
        return send(r);
      }
    }
    await lane(async () => {
      const ctx = { now: clock() };
      const t0 = performance.now();
      let answered: string = "command";
      const reply = await route(db, text, ctx, {
        fm: opts.fm, cli: opts.cli, onIntent: (i) => { answered = i; },
        tick: async (at) => {
          const t = atLocal(ctx.now, at);
          if (t === null) return "Use tick HH:MM.";
          const res = await runScheduler(db, t, { send, fm: opts.fm });
          return `tick ${at}: fired ${res.fired.map((f) => f.kind).join(", ") || "nothing"}` +
            (res.skipped.length ? ` (skipped: ${res.skipped.join("; ")})` : "");
        },
      });
      const t1 = performance.now();
      await send(reply.text);
      // One line per answer, so a slow reply shows whether routing/handlers or the iMessage send took the time.
      console.log(`[timing] ${reply.tier} reply: route+handler ${((t1 - t0) / 1000).toFixed(1)}s, send ${((performance.now() - t1) / 1000).toFixed(1)}s`);
      // A who-paid question rides along only on a real answer, never on small talk, a command or another answer.
      if (REAL_ANSWERS.has(answered)) await maybePrompt(db, ctx.now, send).catch((e) => console.error("[prompt] send failed:", e));
    });
  };

  const periodic = () => lane(() => runScheduler(db, clock(), { send, fm: opts.fm })
    .then(() => maybePrompt(db, clock(), send))).catch((e) => console.error("[scheduler]", e));

  return { tick, onText, periodic };
}

if (import.meta.main) {
  // --cli: terminal. Otherwise (or --live): local iMessage. --dry: watch iMessage but print instead of sending. --check: readiness only.
  // --stage (with any mode): mirror every message to the terminal in large lines.
  const args = process.argv;
  const cli = args.includes("--cli");
  if (!cli) {
    const { selfCheck } = await import("./imessage/kit.ts");
    const check = selfCheck();
    check.lines.push((await import("./ingest/applemail.ts")).mailCheck());
    for (const l of check.lines) console.log(`[check] ${l}`);
    if (args.includes("--check")) process.exit(check.ok ? 0 : 1);
    if (!check.ok) console.log("[check] not ready for live iMessage; continuing so the demo tick and retries keep running");
  }
  const db = openDb();
  // One consistent snapshot of the handlers, loaded now rather than on first use.
  const { loaded, missing } = await (await import("./imessage/router.ts")).preloadHandlers();
  console.log(`[main] handlers loaded: ${loaded.join(", ")}${missing.length ? ` (not built: ${missing.join(", ")})` : ""}`);
  // No local models by default: routing is Luna first, keywords as the fallback. VOICE=device + LOCAL_MODELS=on is the
  // only way bin/fm runs (an opt-in experiment).
  const deviceVoice = localModelsOn() && process.env.VOICE === "device";
  if (deviceVoice) fm.extract("ping", { type: "object", properties: { ok: { type: "boolean" } } })
    .then((r) => console.log(`[main] on-device model ${r ? "warm" : "unavailable (plain wording)"}`));
  const base: Transport = cli ? new CliTransport()
    : new (await import("./imessage/kit.ts")).KitTransport(undefined, undefined, { dry: args.includes("--dry") });
  // --stage: big terminal mirror of every message, a fallback if phone mirroring fails.
  const transport: Transport = args.includes("--stage") ? new (await import("./imessage/stage.ts")).StageTransport(base) : base;
  const agent = makeAgent(db, transport, { cli, fm: deviceVoice ? fm : noFm });
  setConsentSender((t) => transport.send(t));
  const server = startDemoServer(agent.tick);
  console.log(`[main] ${cli ? "CLI" : "iMessage"} transport; demo tick on http://127.0.0.1:${server.port}/demo/tick?at=HH:MM`);
  // Don't block startup on chat.db access; the kit transport retries in the background.
  transport.start(agent.onText).catch((e) => console.error("[main] transport failed to start:", e));
  // Demo default: nudges and prompts go out only from a tick or after an answer. NUDGES_AUTO=1 runs the real 15-minute scheduler.
  const timer = process.env.NUDGES_AUTO === "1" ? setInterval(agent.periodic, 15 * 60 * 1000) : undefined;
  const shutdown = async () => {
    clearInterval(timer);
    server.stop();
    await transport.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
