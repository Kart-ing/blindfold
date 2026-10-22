// Thin wrapper over bin/fm (Apple Foundation Models, on-device). Any failure returns null so callers fall back.
import { join } from "node:path";

export type Fm = {
  extract(prompt: string, schema: object): Promise<Record<string, unknown> | null>;
  respond(prompt: string): Promise<string | null>;
};

const FM_BIN_DEFAULT = join(import.meta.dir, "..", "..", "bin", "fm");

/**
 * Local models are OFF unless LOCAL_MODELS=on: the human chose Luna + Sol only. With it off, no call site can spawn
 * bin/fm (this is the one place that does). bin/fm stays in the repo for the VOICE=device experiment.
 */
export const localModelsOn = () => process.env.LOCAL_MODELS === "on";

async function call(sub: "extract" | "respond", input: object, timeoutMs: number): Promise<any | null> {
  if (!localModelsOn()) return null;
  try {
    const proc = Bun.spawn([process.env.FM_BIN ?? FM_BIN_DEFAULT, sub], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    const res = JSON.parse(out);
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

export const fm: Fm = {
  async extract(prompt, schema) {
    const res = await call("extract", { prompt, schema }, 6000);
    return res && typeof res.json === "object" ? res.json : null;
  },
  async respond(prompt) {
    const res = await call("respond", { prompt }, 6000);
    return res && typeof res.text === "string" ? res.text : null;
  },
};

/** An fm that always fails: forces the deterministic fallbacks. */
export const noFm: Fm = { extract: async () => null, respond: async () => null };
