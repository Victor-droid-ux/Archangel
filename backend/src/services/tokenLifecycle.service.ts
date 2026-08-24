import jupiterService, {
  SOL_MINT,
  getSolPriceUsd,
  resolveLiquidityUsd,
  type JupiterRecentToken,
} from "./jupiter.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenLifecycle");

/**
 * Token lifecycle stages, Jupiter-only.
 *
 * Previously modeled Pump.fun's bonding-curve → graduation → Raydium-pool journey
 * (PUMP_FUN_BONDING, GRADUATED_NO_POOL, GRADUATED_ZERO_LIQUIDITY, FULLY_TRADABLE).
 * With Jupiter as the sole execution venue, there's no separate pre-pool bonding
 * stage to track — a token is either tradable through the aggregator right now
 * (with real liquidity) or it isn't.
 */
export enum TokenLifecycleStage {
  TRADABLE = "tradable",
  ZERO_LIQUIDITY = "zero_liquidity", // has a route but liquidity is effectively zero
  NOT_TRADABLE = "not_tradable", // no Jupiter route at all
  UNKNOWN = "unknown",
}

export interface TokenLifecycleResult {
  mint: string;
  stage: TokenLifecycleStage;
  hasLiquidity: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
  isTradable: boolean;
  errorMessage?: string;
  timestamp: number;
}

/**
 * Validate a token's tradability via Jupiter: a real quote + real liquidity.
 *
 * `prefetchedTokenInfo` lets a batch caller (validateTokenBatch) pass in a
 * tokenInfo it already fetched for the whole batch in one request, instead
 * of this function doing its own per-mint /tokens/v2/search call. Pass
 * `undefined` (the default) to have it fetched here for a standalone call;
 * pass `null` explicitly if the batch lookup ran but didn't find this mint.
 */
export async function validateTokenLifecycle(
  tokenMint: string,
  prefetchedTokenInfo?: JupiterRecentToken | null
): Promise<TokenLifecycleResult> {
  const result: TokenLifecycleResult = {
    mint: tokenMint,
    stage: TokenLifecycleStage.UNKNOWN,
    hasLiquidity: false,
    isTradable: false,
    timestamp: Date.now(),
  };

  try {
    log.info(`Validating lifecycle for token ${tokenMint.slice(0, 8)}...`);

    const smallAmountLamports = 1_000_000; // 0.001 SOL
    const needsTokenInfoFetch = prefetchedTokenInfo === undefined;
    const [quote, fetchedTokenInfo, solPriceUsd] = await Promise.all([
      jupiterService.getQuote(SOL_MINT, tokenMint, smallAmountLamports, 500),
      needsTokenInfoFetch
        ? jupiterService.getTokenInfo(tokenMint)
        : Promise.resolve(prefetchedTokenInfo ?? null),
      getSolPriceUsd(),
    ]);
    const tokenInfo = fetchedTokenInfo;

    if (tokenInfo?.firstPoolId) {
      result.poolAddress = tokenInfo.firstPoolId;
    }

    if (!quote) {
      result.stage = TokenLifecycleStage.NOT_TRADABLE;
      result.isTradable = false;
      result.errorMessage = "No Jupiter route found";
      log.info(`Token ${tokenMint.slice(0, 8)}... has no Jupiter route`);
      return result;
    }

    // tokenInfo?.liquidity comes from a separate Jupiter lookup
    // (/tokens/v2/search) than the quote above (/swap/v1/quote) — a catalog
    // miss/lag there must not read as "$0 liquidity" when the quote just
    // proved a real route exists. resolveLiquidityUsd() falls back to a
    // price-impact estimate from an actual quote instead of trusting a zero.
    //
    // (This also carries forward a fix from before this batching change: the
    // liquidity figure is USD and must be divided by the SOL price to become
    // "SOL" — it was previously written straight into liquiditySOL with no
    // conversion, which made the ~0.05 SOL threshold this gates against
    // downstream pass for essentially any token regardless of real liquidity.)
    const minLiquidityUsdHint = 0.05 * solPriceUsd; // rough USD equivalent of the downstream 0.05 SOL floor
    const { liquidityUSD } = await resolveLiquidityUsd(
      tokenMint,
      minLiquidityUsdHint,
      tokenInfo,
      solPriceUsd
    );
    const liquiditySOL = solPriceUsd > 0 ? liquidityUSD / solPriceUsd : 0;
    result.liquiditySOL = liquiditySOL;
    result.hasLiquidity = liquiditySOL > 0;

    if (result.hasLiquidity) {
      result.stage = TokenLifecycleStage.TRADABLE;
      result.isTradable = true;
      log.info(
        `Token ${tokenMint.slice(0, 8)}... is tradable via Jupiter with ${liquiditySOL.toFixed(
          4
        )} SOL liquidity`
      );
    } else {
      result.stage = TokenLifecycleStage.ZERO_LIQUIDITY;
      result.isTradable = false;
      result.errorMessage = "Jupiter route exists but liquidity is zero";
      log.warn(`Token ${tokenMint.slice(0, 8)}... has a route but zero liquidity`);
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(
      `Lifecycle validation failed for ${tokenMint.slice(0, 8)}...: ${errorMsg}`
    );

    result.stage = TokenLifecycleStage.UNKNOWN;
    result.isTradable = false;
    result.errorMessage = `Validation error: ${errorMsg}`;
    return result;
  }
}

/**
 * Batch validate multiple tokens and classify them
 */
export async function validateTokenBatch(tokenMints: string[]): Promise<{
  tradable: TokenLifecycleResult[];
  notTradable: TokenLifecycleResult[];
  summary: {
    total: number;
    tradableCount: number;
    zeroLiquidity: number;
    unknown: number;
  };
}> {
  log.info(`Batch validating ${tokenMints.length} tokens...`);

  // One batched /tokens/v2/search call for the whole set instead of each
  // validateTokenLifecycle() call doing its own — this is what was turning
  // a routine 4-30 token discovery cycle into 4-30 separate rate-limited
  // requests, stacking on top of whatever autoBuyer/storedTokenChecker were
  // firing at the same time.
  const tokenInfoByMint = await jupiterService.getTokenInfoBatch(tokenMints);

  const results = await Promise.all(
    tokenMints.map((mint) =>
      validateTokenLifecycle(mint, tokenInfoByMint.get(mint) ?? null)
    )
  );

  const tradable = results.filter((r) => r.isTradable);
  const notTradable = results.filter((r) => !r.isTradable);

  const summary = {
    total: results.length,
    tradableCount: tradable.length,
    zeroLiquidity: results.filter(
      (r) => r.stage === TokenLifecycleStage.ZERO_LIQUIDITY
    ).length,
    unknown: results.filter((r) => r.stage === TokenLifecycleStage.UNKNOWN).length,
  };

  log.info(
    `Batch validation complete: ${summary.tradableCount}/${summary.total} tradable ` +
      `(${summary.zeroLiquidity} zero liquidity, ${summary.unknown} unknown)`
  );

  return { tradable, notTradable, summary };
}

/**
 * Get human-readable status message for lifecycle result
 */
export function getLifecycleStatusMessage(result: TokenLifecycleResult): string {
  switch (result.stage) {
    case TokenLifecycleStage.TRADABLE:
      return `✅ Tradable via Jupiter with ${
        result.liquiditySOL?.toFixed(2) || "active"
      } liquidity`;
    case TokenLifecycleStage.ZERO_LIQUIDITY:
      return "⚠️ Jupiter route exists but liquidity is zero - Not Tradable";
    case TokenLifecycleStage.NOT_TRADABLE:
      return "⏳ No Jupiter route available yet - Not Tradable";
    case TokenLifecycleStage.UNKNOWN:
      return `❓ ${result.errorMessage || "Unable to determine token status"} - Not Tradable`;
    default:
      return "❓ Unknown status";
  }
}

export default {
  validateTokenLifecycle,
  validateTokenBatch,
  getLifecycleStatusMessage,
  TokenLifecycleStage,
};