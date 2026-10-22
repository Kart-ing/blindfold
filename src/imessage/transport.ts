// A transport talks to exactly one peer: the owner. There is no "to" parameter, so nothing can message anyone else.
export interface Transport {
  start(onText: (text: string) => Promise<void>): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
}

/** Collects sends in memory; used by tests and the demo tick endpoint's dry runs. */
export class MemoryTransport implements Transport {
  sent: string[] = [];
  private onText?: (text: string) => Promise<void>;
  async start(onText: (text: string) => Promise<void>) { this.onText = onText; }
  async send(text: string) { this.sent.push(text); }
  async stop() {}
  async receive(text: string) { await this.onText?.(text); }
}
