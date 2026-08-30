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
// A raw-transaction fallback is also provided for a Stream configured
// without a shaping Function (or for a plain QuickNode Webhook pointed at
// an RPC subscription), since payload shape is a QuickNode dashboard
// configuration choice, not something fixed in code. Adjust
// `extractFromRawTransaction` to match whatever your actual Stream/Function
// configuration sends — the exact field names below are a reasonable
// starting point, not a guarantee of QuickNode's wire format.
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
  poolAddress?: string;
  dex?: string;
  poolCreatedAt?: Date;
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
  if (!mint) return null;
  const poolAddress = isValidMint(ev.poolAddress) ? ev.poolAddress : undefined;
  const poolCreatedAt = parseTimestamp(ev);
  // Under exactOptionalPropertyTypes, an optional field must be a real value
  // or entirely absent — assigning it `undefined` explicitly is a type
  // error, not just a redundant value. Building the object with conditional
  // spreads omits each missing field outright instead.
  return {
    mint,
    ...(poolAddress !== undefined && { poolAddress }),
    ...(ev.dex !== undefined && { dex: ev.dex }),
    ...(poolCreatedAt !== undefined && { poolCreatedAt }),
  };
}

/**
 * Fallback: pull candidate mints out of a raw Solana transaction object
 * (as delivered by an unshaped QuickNode Stream/webhook). This inspects
 * `postTokenBalances` for mints that didn't exist in `preTokenBalances` —
 * i.e. genuinely new to this transaction — which is DEX-program-agnostic
 * and survives Raydium/Orca/whoever changing their instruction layout,
 * unlike parsing specific instruction indices.
 */
function extractFromRawTransaction(tx: any): CandidateMint[] {
  try {
    const meta = tx?.meta ?? tx?.transaction?.meta;
    if (!meta) return [];
    const pre = new Set(
      (meta.preTokenBalances ?? []).map((b: any) => b.mint).filter(isValidMint),
    );
    const post: string[] = (meta.postTokenBalances ?? [])
      .map((b: any) => b.mint)
      .filter(isValidMint);

    const newMints = Array.from(new Set(post)).filter(
      (m) => !pre.has(m) && !QUOTE_MINTS.has(m),
    );

    const poolCreatedAt = tx?.blockTime
      ? new Date(tx.blockTime * 1000)
      : undefined;

    return newMints.map((mint) => ({
      mint,
      ...(poolCreatedAt !== undefined && { poolCreatedAt }),
    }));
  } catch (err: any) {
    LOG.error(
      { err: err?.message },
      "Failed to extract mint from raw transaction",
    );
    return [];
  }
}

/**
 * Phase 2 entry point: given the raw JSON body QuickNode POSTed, return
 * every candidate mint it represents. Handles a single event, an array of
 * events (a batch delivery, which QuickNode Streams does by default), and
 * falls back to raw-transaction parsing if the payload doesn't look like
 * the structured shape.
 */
export function extractCandidateMints(payload: unknown): CandidateMint[] {
  const events = Array.isArray(payload) ? payload : [payload];
  const results: CandidateMint[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;

    const structured = extractFromStructuredEvent(ev as StructuredPoolEvent);
    if (structured) {
      results.push(structured);
      continue;
    }

    // Doesn't look like our structured shape — try raw-transaction parsing.
    const fromRaw = extractFromRawTransaction(ev);
    if (fromRaw.length > 0) {
      results.push(...fromRaw);
    } else {
      LOG.debug(
        { event: ev },
        "Webhook event had no extractable mint — skipping",
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
