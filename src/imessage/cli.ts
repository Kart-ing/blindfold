import { createInterface } from "node:readline";
import type { Transport } from "./transport.ts";

export class CliTransport implements Transport {
  private rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

  async start(onText: (text: string) => Promise<void>) {
    this.rl.prompt();
    // Each line starts at once (a handler may be waiting for the answer typed on a later line, e.g. consent);
    // main.ts's FIFO lane keeps replies in order.
    const inflight = new Set<Promise<void>>();
    this.rl.on("line", (line) => {
      if (!line.trim()) { this.rl.prompt(); return; }
      const p: Promise<void> = Promise.resolve().then(() => onText(line)).catch((e) => console.error("error:", e))
        .finally(() => { inflight.delete(p); this.rl.prompt(); });
      inflight.add(p);
    });
    this.rl.on("close", () => Promise.allSettled([...inflight]).then(() => process.exit(0)));
  }

  async send(text: string) {
    process.stdout.write(`\rbot> ${text}\n`);
  }

  async stop() { this.rl.close(); }
}
