// Demo tick endpoint, loopback only: GET /demo/tick?at=HH:MM runs the scheduler at that simulated local time today.
export type TickFn = (at: string) => Promise<unknown | null>; // null = invalid time

export function startDemoServer(tick: TickFn, port = Number(process.env.DEMO_PORT ?? 4546)) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== "/demo/tick") return new Response("not found", { status: 404 });
      const at = url.searchParams.get("at") ?? "";
      const out = await tick(at);
      if (out === null) return Response.json({ error: "at must be HH:MM" }, { status: 400 });
      return Response.json(out);
    },
  });
}
