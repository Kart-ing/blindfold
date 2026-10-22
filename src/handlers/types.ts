import type { Database } from "bun:sqlite";

export type Tier = "local" | "on-device" | "cloud";
export type Intent = "afford" | "goal_set" | "goal_status" | "spend_query" | "attribution_fix" | "command" | "other" | "runway" | "research";
// Cloud-only details for the ledger row. The router writes exactly one ledger row per answer and copies these in;
// egress/plan never insert ledger rows themselves (blocked calls are reported here too, with canary_hits > 0).
export type LedgerMeta = {
  question_sym?: string; payload_json?: string; exact_disclosed?: number; partial_count?: number;
  canary_checked?: number; canary_hits?: number; consent?: string;
};
export type Reply = { text: string; tier: Tier; ledger?: LedgerMeta };
export type Ctx = { now: number }; // unix seconds; injectable for demo ticks and tests
export type Handler = (db: Database, text: string, ctx: Ctx) => Promise<Reply>;
