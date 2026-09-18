// backend/src/services/solamiExtraction.service.ts
//
// Adapter from Solami's enriched webhook payload into ArchAngel's
// existing CandidateMint shape.
//
// Real Solami pool_create deliveries have the important pool fields
// inside body.events[], while block_time remains at the top level.
//
// Example:
//
// {
//   type: "pool_create",
//   block_time: 1789692005,
//   events: [
//     {
//       type: "pool_create",
//       dex: "raydium_cpmm",
//       pool: "...",
//       base_mint: "...",
//       quote_mint: "..."
//     }
//   ]
// }
//
// The adapter deliberately keeps CandidateMint unchanged. Its job is
// only to translate Solami's payload into the shape already consumed
// by candidatePipeline.service.ts.

import { PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import type { CandidateMint } from "./tokenExtraction.service.js";

const LOG = getLogger("solami-extraction");

// These are the only quote assets ArchAngel currently treats as valid
// trading-pair quote currencies.
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

function isValidPubkeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32) return false;

  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

interface SolamiPoolEvent {
  type?: unknown;
  dex?: unknown;
  pool?: unknown;
  base_mint?: unknown;
  quote_mint?: unknown;
}

export function extractCandidateMintFromSolamiEvent(
  body: unknown,
): CandidateMint | null {
  if (typeof body !== "object" || body === null) {
    LOG.warn("Solami webhook payload was not an object — rejecting");
    return null;
  }

  const payload = body as Record<string, unknown>;

  // Solami can deliver several event types through the same webhook.
  if (payload.type !== "pool_create") {
    return null;
  }

  const blockTime = payload.block_time;

  if (
    typeof blockTime !== "number" ||
    !Number.isFinite(blockTime) ||
    blockTime <= 0
  ) {
    LOG.warn(
      { blockTime },
      "Solami pool_create missing/invalid block_time — rejecting",
    );
    return null;
  }

  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    LOG.warn(
      { type: payload.type },
      "Solami pool_create has no events array — rejecting",
    );
    return null;
  }

  // Find the actual pool_create event inside Solami's enriched events array.
  const poolEvent = payload.events.find((item): item is SolamiPoolEvent => {
    if (typeof item !== "object" || item === null) return false;

    const event = item as SolamiPoolEvent;
    return event.type === "pool_create";
  });

  if (!poolEvent) {
    LOG.warn(
      { eventCount: payload.events.length },
      "Solami pool_create contains no nested pool_create event — rejecting",
    );
    return null;
  }

  const baseMint = poolEvent.base_mint;
  const quoteMint = poolEvent.quote_mint;
  const poolAddress = poolEvent.pool;
  const dex = poolEvent.dex;

  if (!isValidPubkeyString(baseMint)) {
    LOG.warn(
      { baseMint },
      "Solami pool_create has invalid base_mint — rejecting",
    );
    return null;
  }

  if (!isValidPubkeyString(quoteMint)) {
    LOG.warn(
      { quoteMint },
      "Solami pool_create has invalid quote_mint — rejecting",
    );
    return null;
  }

  if (!isValidPubkeyString(poolAddress)) {
    LOG.warn(
      { poolAddress },
      "Solami pool_create has invalid pool — rejecting",
    );
    return null;
  }

  if (typeof dex !== "string" || dex.length === 0) {
    LOG.warn({ dex }, "Solami pool_create missing dex — rejecting");
    return null;
  }

  // Exactly one side must be one of our supported quote assets.
  //
  // If neither side is SOL/USDC/USDT, this is not a pair we want to
  // treat as a new-token candidate.
  //
  // If both sides are quote assets, there is no new token.
  const baseIsQuote = QUOTE_MINTS.has(baseMint);
  const quoteIsQuote = QUOTE_MINTS.has(quoteMint);

  if (baseIsQuote === quoteIsQuote) {
    LOG.debug(
      {
        baseMint: baseMint.slice(0, 8),
        quoteMint: quoteMint.slice(0, 8),
        dex,
      },
      "Solami pool_create does not contain exactly one supported quote mint — rejecting",
    );
    return null;
  }

  const mint = baseIsQuote ? quoteMint : baseMint;

  return {
    mint,
    poolAddress,
    dex,
    poolCreatedAt: new Date(blockTime * 1000),
  };
}
