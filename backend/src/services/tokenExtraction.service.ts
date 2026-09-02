// backend/src/services/tokenExtraction.service.ts
//
// Phase 2 of the linear discovery→validate→buy pipeline: given a raw
// QuickNode webhook delivery, reliably pull out the new token mint
// address(es) it represents.
//
// QuickNode Streams (https://www.quicknode.com/docs/streams) let you attach
// a Filter/Function that runs QuickNode-side and reshapes each matched
// transaction before it's POSTed to your webhook. The recommended setup for
// this pipeline is a Solana dataset (block/transaction) filtered to new-pool
// instructions on the DEX programs you care about (Raydium, Orca Whirlpool,
// etc.), with a Function that emits ONE clean object per new pool — mint
// addresses, pool address, dex name, and pool-creation timestamp — instead
// of forwarding the raw transaction. That is the "structured" shape below,
// and it's what this file expects by default.
//
// Auto-trading accepts only these structured pool-creation events. Raw
// transaction payloads are intentionally ignored because they cannot prove
// a mint was newly launched by that transaction.
import { PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("token-extraction");

// Mints that are the "other side" of every pool (SOL/stables) — never a
// genuine new-token candidate, so any instruction naming these as one of a
// pool's two mints tells you the mint you actually want is the OTHER one.
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface CandidateMint {
  mint: string;
  poolAddress: string;
  dex: string;
  poolCreatedAt: Date;
}

function isValidMint(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.length < 32) return false;
  try {
    // Throws on anything that isn't a real base58 Solana address — cheaper
    // and more reliable than a length/regex heuristic, and catches malformed
    // or truncated payload fields before they reach Phase 3.
    new PublicKey(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured event shape: what a QuickNode Stream Function should emit for
 * a new-pool-creation match. One event can reference multiple pools if a
 * single block/transaction created more than one (e.g. a batched deploy).
 */
interface StructuredPoolEvent {
  poolAddress?: string;
  dex?: string; // "raydium" | "orca" | ...
  baseMint?: string;
  quoteMint?: string;
  mint?: string; // some Stream configs emit the new-token mint directly
  timestamp?: number | string; // unix seconds/ms or ISO string
  blockTime?: number;
}

function pickNewMint(ev: StructuredPoolEvent): string | null {
  if (isValidMint(ev.mint)) return ev.mint;
  const candidates = [ev.baseMint, ev.quoteMint].filter(
    isValidMint,
  ) as string[];
  // Whichever side of the pool ISN'T SOL/a stablecoin is the new token.
  const nonQuote = candidates.filter((m) => !QUOTE_MINTS.has(m));
  if (nonQuote.length === 1) return nonQuote[0] ?? null;
  if (nonQuote.length > 1) {
    LOG.warn(
      { candidates },
      "Pool event has two non-quote mints — ambiguous, taking the first",
    );
    return nonQuote[0] ?? null;
  }
  return null;
}

function parseTimestamp(ev: StructuredPoolEvent): Date | undefined {
  const raw = ev.timestamp ?? ev.blockTime;
  if (raw == null) return undefined;
  const ms = typeof raw === "number" && raw < 1e12 ? raw * 1000 : Number(raw);
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function extractFromStructuredEvent(
  ev: StructuredPoolEvent,
): CandidateMint | null {
  const mint = pickNewMint(ev);
  const poolAddress = isValidMint(ev.poolAddress) ? ev.poolAddress : null;
  const poolCreatedAt = parseTimestamp(ev);
  if (!mint || !poolAddress || !ev.dex || !poolCreatedAt) {
    LOG.warn(
      {
        mint,
        poolAddress: ev.poolAddress,
        dex: ev.dex,
        timestamp: ev.timestamp ?? ev.blockTime,
      },
      "Rejected unstructured QuickNode event: strict pool-creation fields are required",
    );
    return null;
  }
  return { mint, poolAddress, dex: ev.dex, poolCreatedAt };
}

/**
 * Phase 2 entry point: given the raw JSON body QuickNode POSTed, return
 * every candidate mint it represents. Only structured pool-creation events
 * with mint, pool, DEX, and creation time are accepted for auto-trading.
 */
export function extractCandidateMints(payload: unknown): CandidateMint[] {
  const events = Array.isArray(payload) ? payload : [payload];
  const results: CandidateMint[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;

    const structured = extractFromStructuredEvent(ev as StructuredPoolEvent);
    if (structured) {
      results.push(structured);
    } else {
      LOG.debug(
        { event: ev },
        "Webhook event is not a valid structured pool-creation event — skipping",
      );
    }
  }

  // De-dupe within a single delivery (a batched block can reference the
  // same brand-new mint more than once, e.g. init + first swap).
  const seen = new Set<string>();
  return results.filter((c) => {
    if (seen.has(c.mint)) return false;
    seen.add(c.mint);
    return true;
  });
}
