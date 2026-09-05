// backend/src/services/tokenExtraction.service.ts
//
// Phase 2 of the linear discovery→validate→buy pipeline: given a raw
// QuickNode webhook delivery, reliably pull out the new token mint
// address(es) it represents.
//
// QuickNode Streams (https://www.quicknode.com/docs/streams) let you attach
// a Filter/Function that runs QuickNode-side and reshapes each matched
// transaction before it's POSTed to your webhook. This pipeline requires
// that shaping Function: a Solana dataset (block/transaction) filtered to
// new-pool instructions on the DEX programs you care about (Raydium, Orca,
// etc.), emitting ONE clean object per new pool — mint address, pool
// address, dex name, and pool-creation time. That is the "structured" shape
// below, and it is now the ONLY shape this file accepts for auto-trade
// candidates.
//
// Strict on purpose: mint, poolAddress, dex, and a creation timestamp are
// ALL required, or the event is rejected outright (empty result, not a
// partial candidate). A candidate missing poolAddress can't be excluded
// from its own holder-concentration ranking in Phase 4 (see
// tokenFiltering.service.ts); one missing dex can't be filtered by DEX
// later if that's ever wanted; one missing a timestamp can't be checked for
// delivery freshness (see candidatePipeline.service.ts's isFreshCandidate).
// A partially-shaped event is a QuickNode Stream/Function misconfiguration,
// not something to silently trade around.
//
// The previous raw-transaction fallback (parsing pre/postTokenBalances
// directly out of an unshaped transaction) has been removed entirely for
// the same reason: it can supply a mint, but never a reliable poolAddress,
// dex, or precise creation time — every candidate it produced was
// necessarily missing data this pipeline now requires for auto-trading.
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
 * Structured event shape: what a QuickNode Stream Function must emit for a
 * new-pool-creation match. One event can reference multiple pools if a
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

/**
 * Accepts a structured event only when mint, poolAddress, dex, and a valid
 * creation timestamp are ALL present — see this file's header comment for
 * why each one is mandatory now. Returns null on any single missing piece,
 * not a partial CandidateMint.
 */
function extractFromStructuredEvent(
  ev: StructuredPoolEvent,
): CandidateMint | null {
  const mint = pickNewMint(ev);
  if (!mint) return null;

  const poolAddress = isValidMint(ev.poolAddress) ? ev.poolAddress : null;
  const poolCreatedAt = parseTimestamp(ev) ?? null;
  const dex = typeof ev.dex === "string" && ev.dex.length > 0 ? ev.dex : null;

  if (!poolAddress || !dex || !poolCreatedAt) {
    LOG.debug(
      {
        mint: mint.slice(0, 8),
        hasPoolAddress: !!poolAddress,
        hasDex: !!dex,
        hasTimestamp: !!poolCreatedAt,
      },
      "Rejecting incomplete pool-creation event — missing required field(s)",
    );
    return null;
  }

  return { mint, poolAddress, dex, poolCreatedAt };
}

/**
 * Phase 2 entry point: given the raw JSON body QuickNode POSTed, return
 * every candidate mint it represents. Handles a single event and an array
 * of events (a batch delivery, which QuickNode Streams does by default).
 * Any event that isn't a complete structured pool-creation event (see
 * extractFromStructuredEvent) is silently dropped, not degraded into a
 * partial candidate.
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
        "Webhook event rejected — not a complete structured pool-creation event",
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
