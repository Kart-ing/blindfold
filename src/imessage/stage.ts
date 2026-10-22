// `--stage`: mirror every inbound and outbound message to the terminal in big, clear lines,
// a fallback display if phone mirroring fails on stage. Wraps any transport; delivery is unchanged.
import type { Transport } from "./transport.ts";

const ESC = "\x1b[";
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

/** The box printed for one message, exported for tests. */
export function stageBlock(who: "YOU" | "AGENT", text: string, width = Math.min(process.stdout.columns || 80, 100)): string {
  const inner = Math.max(width - 4, 20);
  const rule = "━".repeat(inner + 2);
  const tag = who === "YOU" ? paint("1;97;44", ` 📱 ${who} `) : paint("1;30;42", ` 🤖 ${who} `);
  const body = wrap(text, inner).map((l) => `┃ ${paint("1", l.padEnd(inner))} ┃`);
  return ["", tag, `┏${rule}┓`, ...body, `┗${rule}┛`].join("\n");
}

export class StageTransport implements Transport {
  constructor(private inner: Transport, private out: (s: string) => void = (s) => console.log(s)) {}
  async start(onText: (text: string) => Promise<void>) {
    await this.inner.start(async (text) => {
      this.out(stageBlock("YOU", text));
      await onText(text);
    });
  }
  async send(text: string) {
    await this.inner.send(text);
    this.out(stageBlock("AGENT", text));
  }
  async stop() { await this.inner.stop(); }
}
