// backend/src/services/solamiExtraction.service.ts
//
// Solami counterpart to tokenExtraction.service.ts. Unlike QuickNode
// (which can batch multiple matched transactions into one webhook
// delivery, hence extractCandidateMints returning an array), Solami's own
// docs describe each webhook delivery as one decoded event — so this
// returns a single CandidateMint or null, not an array.
//
// Confirmed field shapes: Blur's token_create example gives
// {mint, pool, quote_mint, dex, name, symbol, uri, creator, signature,
// slot, block_time}; pool_create is documented as "same shape, with the
// name fields blank." That's the assumption this is built against — it
// has NOT been verified against a real pool_create delivery yet, since
// none had arrived as of writing this. Re-check field names here against
// the first real delivery this route receives before trusting it in
// production.
//
// Same strict-rejection philosophy as tokenExtraction.service.ts: mint,
// poolAddress, dex, and poolCreatedAt are all required, or the event is
// rejected outright — a partially-shaped event is a Solami-side config
// issue (wrong event_types, wrong payload_kind), not something to
// silently trade around.
import { PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import type { CandidateMint } from "./tokenExtraction.service.js";

const LOG = getLogger("solami-extraction");

function isValidPubkeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function extractCandidateMintFromSolamiEvent(
  body: unknown,
): CandidateMint | null {
  if (typeof body !== "object" || body === null) {
    LOG.warn("Solami webhook payload was not an object — rejecting");
    return null;
  }
  const event = body as Record<string, unknown>;

  if (event.type !== "pool_create") {
    // Not necessarily an error — the webhook is currently configured with
    // event_types including swap/token_create too (per the live dashboard
    // config at time of writing), so non-pool_create deliveries are
    // expected and should be silently ignored here, not logged as noise.
    return null;
  }

  const mint = event.mint;
  const poolAddress = event.pool;
  const dex = event.dex;
  const blockTime = event.block_time;

  if (!isValidPubkeyString(mint)) {
    LOG.warn({ event }, "Solami pool_create missing/invalid mint — rejecting");
    return null;
  }
  if (!isValidPubkeyString(poolAddress)) {
    LOG.warn({ event }, "Solami pool_create missing/invalid pool — rejecting");
    return null;
  }
  if (typeof dex !== "string" || dex.length === 0) {
    LOG.warn({ event }, "Solami pool_create missing dex — rejecting");
    return null;
  }
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) {
    LOG.warn(
      { event },
      "Solami pool_create missing/invalid block_time — rejecting",
    );
    return null;
  }

  return {
    mint,
    poolAddress,
    // Passed through as-is, deliberately not remapped here — Solami's
    // underscore-separated naming (raydium_cpmm, raydium_v4, raydium_clmm)
    // is already handled by raydiumProgramIds.ts's
    // toCanonicalRaydiumPoolType, which normalizes underscores to hyphens
    // before matching. No separate mapping table needed.
    dex,
    poolCreatedAt: new Date(blockTime * 1000),
  };
}
