// `bun run demo`: reseed, then run the panel (127.0.0.1:4545) and the agent together. Ctrl-C stops everything.
// Agent: `src/main.ts --live --stage` (iMessage + large terminal mirror) when OWNER_HANDLE is set in .env, else --cli (this terminal).
// Refuses to start while a panel or agent is already running, so it can't reset a running demo's data or start a second agent.
import type { Subprocess } from "bun";
import { join } from "node:path";
import { DEMO_DB, reset } from "./reset";

const root = join(import.meta.dir, "..");
const bun = process.execPath;
const env = { ...process.env, FIN_DB: DEMO_DB };
const mode = process.argv.includes("--cli") ? "--cli" : process.argv.includes("--live") || process.env.OWNER_HANDLE ? "--live" : "--cli";
const agentArgs = mode === "--live" ? ["--live", "--stage"] : ["--cli"];
const ports = [Number(process.env.PANEL_PORT ?? 4545), Number(process.env.DEMO_PORT ?? 4546)];

/** True if something already listens on 127.0.0.1:port. Connects and closes; sends nothing. */
async function inUse(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}
const busy = (await Promise.all(ports.map(async (p) => ((await inUse(p)) ? p : null)))).filter((p) => p !== null);
if (busy.length) {
  console.error(`[demo] port ${busy.join(" and ")} already in use: a panel or agent is running. Stop it first, or run \`bun run demo:reset\` to reseed it in place. Nothing was reset.`);
  process.exit(1);
}

console.log("[demo] seeded", JSON.stringify(reset(DEMO_DB)));
const procs: Subprocess[] = [
  Bun.spawn([bun, "run", "src/panel/server.ts"], { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn([bun, "run", "src/main.ts", ...agentArgs], { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
];
console.log(`[demo] panel http://127.0.0.1:${ports[0]} · agent ${agentArgs.join(" ")} · Ctrl-C to stop`);

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  const timeout = setTimeout(() => { for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL"); }, 3000);
  await Promise.all(procs.map(p => p.exited));
  clearTimeout(timeout);
  console.log("[demo] stopped");
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
// If either child dies on its own, take the other down too.
for (const p of procs) p.exited.then(c => { if (!stopping) { console.error(`[demo] a process exited (${c}); stopping`); stop(c || 1); } });
