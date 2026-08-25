/**
 * ArchAngel Trade Validation Service
 *
 * Implements the CRITICAL CONDITIONS for safe trading, Jupiter-only:
 * 1. "Jupiter Tradable" Filter (real route + liquidity via Jupiter aggregator)
 * 2. "No Instant Dump" Anti-Manipulation Filter (safety checks)
 *
 * (Previously had a 3rd, separate "About to Graduate" bonding-curve condition and a
 * "Raydium Migration Confirmed" condition — those only made sense for Pump.fun's
 * bonding-curve-then-pool lifecycle. With Jupiter, a token either has a real
 * executable route right now or it doesn't; there's no separate pre-pool stage.)
 */

import jupiterService, {
  SOL_MINT,
  getSolPriceUsd,
  resolveLiquidityUsd,
} from "./jupiter.service.js";
import birdeyeService from "./birdeye.service.js";
import {
  getHolderDistribution,
  checkPoolStillLive,
  fetchRugCheckReport,
} from "./tokenSafetyChecks.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tradeValidation");

/**
 * Jupiter tradability + liquidity metrics
 */
export interface JupiterLiquidityMetrics {
  exists: boolean;
  liquiditySOL: number;
  liquidityUSD: number;
  mcapUSD: number;
  holderCount: number;
  poolAddress?: string;
  meetsMinimumLiquidity: boolean;
  buyRouteAvailable?: boolean;
  sellRouteAvailable?: boolean;
  buyPriceImpactPct?: number;
}

/**
 * Anti-manipulation safety checks
 */
export interface SafetyChecks {
  canSell: boolean; // Test sell successful
  mintAuthority: string | null;
  freezeAuthority: string | null;
  firstThreeCandlesValid: boolean; // No 60%+ dump
  lpRemovable: boolean;
  buyTax: number;
  sellTax: number;
  isHoneypot: boolean;
  allChecksPassed: boolean;
}

/**
 * Complete trade validation result
 */
export interface TradeValidationResult {
  mint: string;
  approved: boolean;

  // Condition 1: Jupiter Tradable
  jupiterMetrics: JupiterLiquidityMetrics;
  condition1Passed: boolean;

  // Condition 2: No Instant Dump
  safetyChecks: SafetyChecks;
  condition2Passed: boolean;

  recommendation: "BUY" | "IGNORE";
  reason: string;
  timestamp: number;
}

/**
 * CONDITION 1: Confirm the token has a real, sufficiently-liquid Jupiter route
 */
async function checkJupiterTradable(
  tokenMint: string,
): Promise<{ metrics: JupiterLiquidityMetrics; passed: boolean }> {
  try {
    const smallAmountLamports = 1_000_000; // 0.001 SOL test
    const [quote, tokenInfo, solPriceUsd] = await Promise.all([
      jupiterService.getQuote(SOL_MINT, tokenMint, smallAmountLamports, 100),
      jupiterService.getTokenInfo(tokenMint),
      getSolPriceUsd(),
    ]);

    if (!quote) {
      return {
        metrics: {
          exists: false,
          liquiditySOL: 0,
          liquidityUSD: 0,
          mcapUSD: 0,
          holderCount: 0,
          meetsMinimumLiquidity: false,
        },
        passed: false,
      };
    }

    // Aggressive mode: $1,500 minimum. Safe mode: $5,000 minimum.
    const tradingMode = process.env.TRADING_MODE || "aggressive";
    const minLiquidityUSD = tradingMode === "safe" ? 5000 : 1500;

    // tokenInfo?.liquidity comes from a *separate* Jupiter lookup
    // (/tokens/v2/search) than the quote above (/swap/v1/quote) — a catalog
    // miss there must not read as "$0 liquidity" when the quote we just got
    // proves a real route exists. Falls back to a price-impact estimate
    // instead of trusting a zero. See resolveLiquidityUsd's own doc comment.
    const { liquidityUSD, source: liquiditySource } = await resolveLiquidityUsd(
      tokenMint,
      minLiquidityUSD,
      tokenInfo,
      solPriceUsd,
    );
    const liquiditySOL = solPriceUsd > 0 ? liquidityUSD / solPriceUsd : 0;
    const meetsMinimum = liquidityUSD >= minLiquidityUSD;

    const metrics: JupiterLiquidityMetrics = {
      exists: true,
      liquiditySOL,
      liquidityUSD,
      mcapUSD: tokenInfo?.mcap ?? 0,
      holderCount: tokenInfo?.holderCount ?? 0,
      meetsMinimumLiquidity: meetsMinimum,
      ...(tokenInfo?.firstPoolId ? { poolAddress: tokenInfo.firstPoolId } : {}),
    };

    const passed = metrics.exists && metrics.meetsMinimumLiquidity;

    log.info(
      `Token ${tokenMint.slice(0, 8)}... Jupiter liquidity: ${liquiditySOL.toFixed(
        2,
      )} SOL ($${liquidityUSD.toFixed(0)}, source: ${liquiditySource}) | Min: $${minLiquidityUSD} (${tradingMode} mode) | Condition 1: ${
        passed ? "✅ PASS" : "❌ FAIL"
      }`,
    );

    return { metrics, passed };
  } catch (err) {
    log.error(`Error checking Jupiter tradability: ${err}`);
    return {
      metrics: {
        exists: false,
        liquiditySOL: 0,
        liquidityUSD: 0,
        mcapUSD: 0,
        holderCount: 0,
        meetsMinimumLiquidity: false,
      },
      passed: false,
    };
  }
}

/**
 * Look for a >60% price collapse in the token's short recent history (its
 * "first three candles" since discovery). A brand-new token — the normal
 * case, since this bot validates within seconds of launch — simply has no
 * history yet; that's not evidence of a dump, so it passes rather than being
 * fabricated as either always-true or always-false.
 */
async function checkNoEarlyDump(tokenMint: string): Promise<boolean> {
  try {
    const points = await birdeyeService.getPriceHistory(tokenMint, {
      intervalMinutes: 1,
      lookbackMinutes: 15,
    });
    if (points.length < 2) return true; // no data yet — nothing detected

    const prices = points.map((p) => p.price);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    if (high <= 0) return true;

    const dropPct = (high - low) / high;
    return dropPct < 0.6;
  } catch (err) {
    log.debug(
      `Early-dump check unavailable for ${tokenMint.slice(0, 8)}...: ${err}`,
    );
    return true; // no data — same honest-degradation reasoning as above
  }
}

/**
 * CONDITION 2: Perform anti-manipulation safety checks
 */
async function performSafetyChecks(
  tokenMint: string,
  poolAddress?: string,
): Promise<{ checks: SafetyChecks; passed: boolean }> {
  try {
    // Prefer Jupiter's own audit data (already fetched during discovery, cheap here too)
    // over a separate on-chain getParsedAccountInfo call.
    const tokenInfo = await jupiterService.getTokenInfo(tokenMint);

    const mintAuthorityNull = tokenInfo?.mintAuthorityDisabled ?? false;
    const freezeAuthorityNull = tokenInfo?.freezeAuthorityDisabled ?? false;

    const {
      creatorHoldings,
      top3Combined,
      available: holderDataAvailable,
    } = await getHolderDistribution(tokenMint, {
      creatorAddress: tokenInfo?.devAddress,
      excludeOwners: [poolAddress, tokenInfo?.firstPoolId],
    });

    let canSell = false;
    try {
      // Test with a realistic amount, not a fixed raw-unit constant: 1000 base
      // units is dust for almost any token (Jupiter returns NO_ROUTES_FOUND for
      // amounts that small even on the deepest pools, e.g. BONK) and would make
      // this check fail universally regardless of whether the token is sellable.
      // Quote a small real buy first, then test selling that resulting amount back.
      const probeBuyQuote = await jupiterService.getQuote(
        SOL_MINT,
        tokenMint,
        1_000_000, // 0.001 SOL
        1000,
      );
      if (probeBuyQuote?.outAmount) {
        const testQuote = await jupiterService.getQuote(
          tokenMint,
          SOL_MINT,
          probeBuyQuote.outAmount,
          1000, // High slippage tolerance for test
        );
        if (testQuote && testQuote.outAmount > 0) {
          canSell = true;
          log.debug(
            `Test sell quote successful for ${tokenMint.slice(0, 8)}... - ${
              testQuote.outAmount
            } lamports expected`,
          );
        }
      }
    } catch (err) {
      log.warn(`Test sell failed for ${tokenMint.slice(0, 8)}...: ${err}`);
      canSell = false;
    }

    // Fail closed if the concentration data itself couldn't be fetched — see
    // getHolderDistribution's `available` flag.
    const creatorBelowLimit = holderDataAvailable && creatorHoldings <= 20;
    const top3BelowLimit = holderDataAvailable && top3Combined <= 60;

    const lpNotRemoved = await checkPoolStillLive(tokenMint, poolAddress);
    const firstThreeCandlesValid = await checkNoEarlyDump(tokenMint);

    // Tax/honeypot via RugCheck — the other auto-buy path (jupiterTokenValidator.service.ts)
    // already checks this; this path previously didn't, so a token could
    // bypass tax/honeypot screening entirely depending on which discovery
    // mechanism found it first. Fails closed on an unavailable report, same
    // reasoning as jupiterTokenValidator.service.ts.
    const rugCheck = await fetchRugCheckReport(tokenMint);
    const maxBuyTax = Number(process.env.MAX_BUY_TAX_PCT ?? 5);
    const maxSellTax = Number(process.env.MAX_SELL_TAX_PCT ?? 5);
    const taxAcceptable =
      rugCheck.available &&
      rugCheck.taxes.buyTax <= maxBuyTax &&
      rugCheck.taxes.sellTax <= maxSellTax;
    const notHoneypot = rugCheck.available && !rugCheck.isHoneypot;

    const checks: SafetyChecks = {
      canSell,
      mintAuthority: mintAuthorityNull ? null : "unknown",
      freezeAuthority: freezeAuthorityNull ? null : "unknown",
      firstThreeCandlesValid,
      lpRemovable: !lpNotRemoved,
      buyTax: rugCheck.taxes.buyTax,
      sellTax: rugCheck.taxes.sellTax,
      isHoneypot: !rugCheck.available || rugCheck.isHoneypot,
      allChecksPassed:
        canSell &&
        mintAuthorityNull &&
        freezeAuthorityNull &&
        creatorBelowLimit &&
        top3BelowLimit &&
        lpNotRemoved &&
        firstThreeCandlesValid &&
        taxAcceptable &&
        notHoneypot,
    };

    const passed = checks.allChecksPassed;

    log.info(
      `Token ${tokenMint.slice(0, 8)}... Safety Checks:
      ✓ Sell Test: ${canSell ? "✅" : "❌"}
      ✓ Mint Authority: ${mintAuthorityNull ? "✅ DISABLED" : "❌ ENABLED"}
      ✓ Freeze Authority: ${freezeAuthorityNull ? "✅ DISABLED" : "❌ ENABLED"}
      ✓ Creator Holdings: ${creatorHoldings.toFixed(1)}% ${
        creatorBelowLimit ? "✅ ≤20%" : "❌ >20%"
      }
      ✓ Top 3 Wallets: ${top3Combined.toFixed(1)}% ${
        top3BelowLimit ? "✅ ≤60%" : "❌ >60%"
      }
      ✓ Tax: buy ${checks.buyTax}% / sell ${checks.sellTax}% ${
        taxAcceptable ? "✅" : "❌"
      }
      ✓ Honeypot: ${notHoneypot ? "✅ CLEAR" : "❌ FLAGGED/UNVERIFIED"}
      → Condition 2: ${passed ? "✅ PASS" : "❌ FAIL"}`,
    );

    return { checks, passed };
  } catch (err) {
    log.error(`Error performing safety checks: ${err}`);
    return {
      checks: {
        canSell: false,
        mintAuthority: "UNKNOWN",
        freezeAuthority: "UNKNOWN",
        firstThreeCandlesValid: false,
        lpRemovable: true,
        buyTax: 0,
        sellTax: 0,
        isHoneypot: true,
        allChecksPassed: false,
      },
      passed: false,
    };
  }
}

/**
 * MAIN VALIDATION: Check both conditions and approve/reject trade
 */
export async function validateTradeOpportunity(
  tokenMint: string,
): Promise<TradeValidationResult> {
  log.info(`🔍 Validating trade opportunity for ${tokenMint.slice(0, 8)}...`);

  const { metrics: jupiterMetrics, passed: condition1 } =
    await checkJupiterTradable(tokenMint);

  // Skip the (expensive) safety checks entirely if there's no route/liquidity at all
  const { checks: safetyChecks, passed: condition2 } = condition1
    ? await performSafetyChecks(tokenMint, jupiterMetrics.poolAddress)
    : {
        checks: {
          canSell: false,
          mintAuthority: "UNKNOWN",
          freezeAuthority: "UNKNOWN",
          firstThreeCandlesValid: false,
          lpRemovable: true,
          buyTax: 0,
          sellTax: 0,
          isHoneypot: true,
          allChecksPassed: false,
        } as SafetyChecks,
        passed: false,
      };

  const allConditionsPassed = condition1 && condition2;

  let recommendation: "BUY" | "IGNORE" = "IGNORE";
  let reason = "";

  if (allConditionsPassed) {
    recommendation = "BUY";
    reason = "✅ All conditions passed - SNIPE OPPORTUNITY!";
  } else if (!condition1) {
    reason = `❌ No Jupiter route or insufficient liquidity ($${jupiterMetrics.liquidityUSD.toFixed(
      0,
    )})`;
  } else {
    reason = "❌ Failed safety checks - SCAM RISK";
  }

  const result: TradeValidationResult = {
    mint: tokenMint,
    approved: allConditionsPassed,
    jupiterMetrics,
    condition1Passed: condition1,
    safetyChecks,
    condition2Passed: condition2,
    recommendation,
    reason,
    timestamp: Date.now(),
  };

  log.info(
    `🎯 Validation result: ${recommendation} - ${reason} | C1: ${
      condition1 ? "✅" : "❌"
    } C2: ${condition2 ? "✅" : "❌"}`,
  );

  return result;
}

export async function validateFastLaunchOpportunity(
  tokenMint: string,
): Promise<TradeValidationResult> {
  const timestamp = Date.now();
  try {
    const [tokenInfo, solPriceUsd, buyQuote] = await Promise.all([
      jupiterService.getTokenInfo(tokenMint),
      getSolPriceUsd(),
      jupiterService.getQuote(SOL_MINT, tokenMint, 1_000_000, 1000),
    ]);
    const sellQuote = buyQuote?.outAmount
      ? await jupiterService.getQuote(
          tokenMint,
          SOL_MINT,
          buyQuote.outAmount,
          1000,
        )
      : null;
    const liquidityUSD = Number(tokenInfo?.liquidity ?? 0);
    const liquiditySOL = solPriceUsd > 0 ? liquidityUSD / solPriceUsd : 0;
    const mintDisabled = tokenInfo?.mintAuthorityDisabled === true;
    const freezeDisabled = tokenInfo?.freezeAuthorityDisabled === true;
    const approved = Boolean(
      tokenInfo &&
      buyQuote?.outAmount &&
      sellQuote?.outAmount &&
      mintDisabled &&
      freezeDisabled &&
      Number.isFinite(liquiditySOL) &&
      liquiditySOL > 0 &&
      (buyQuote.priceImpactPct ?? 0) <=
        Number(process.env.MAX_PIPELINE_PRICE_IMPACT_PCT ?? 30),
    );
    const safetyChecks: SafetyChecks = {
      canSell: Boolean(sellQuote?.outAmount),
      mintAuthority: mintDisabled ? null : "unknown",
      freezeAuthority: freezeDisabled ? null : "unknown",
      firstThreeCandlesValid: true,
      lpRemovable: false,
      buyTax: 0,
      sellTax: 0,
      isHoneypot: false,
      allChecksPassed: approved,
    };
    const jupiterMetrics: JupiterLiquidityMetrics = {
      exists: Boolean(buyQuote?.outAmount),
      buyRouteAvailable: Boolean(buyQuote?.outAmount),
      sellRouteAvailable: Boolean(sellQuote?.outAmount),
      buyPriceImpactPct: Number(buyQuote?.priceImpactPct ?? 0),
      liquiditySOL,
      liquidityUSD,
      mcapUSD: Number(tokenInfo?.mcap ?? 0),
      holderCount: Number(tokenInfo?.holderCount ?? 0),
      meetsMinimumLiquidity: liquiditySOL > 0,
      ...(tokenInfo?.firstPoolId ? { poolAddress: tokenInfo.firstPoolId } : {}),
    };
    return {
      mint: tokenMint,
      approved,
      jupiterMetrics,
      condition1Passed: Boolean(buyQuote?.outAmount && sellQuote?.outAmount),
      safetyChecks,
      condition2Passed: approved,
      recommendation: approved ? "BUY" : "IGNORE",
      reason: approved
        ? "Fast launch checks passed"
        : "Fast launch checks failed",
      timestamp,
    };
  } catch (err: any) {
    log.warn({ tokenMint, err: err?.message }, "Fast launch validation failed");
    return {
      mint: tokenMint,
      approved: false,
      jupiterMetrics: {
        exists: false,
        liquiditySOL: 0,
        liquidityUSD: 0,
        mcapUSD: 0,
        holderCount: 0,
        meetsMinimumLiquidity: false,
      },
      condition1Passed: false,
      safetyChecks: {
        canSell: false,
        mintAuthority: "unknown",
        freezeAuthority: "unknown",
        firstThreeCandlesValid: false,
        lpRemovable: false,
        buyTax: 0,
        sellTax: 0,
        isHoneypot: true,
        allChecksPassed: false,
      },
      condition2Passed: false,
      recommendation: "IGNORE",
      reason: "Fast launch validation unavailable",
      timestamp,
    };
  }
}

/**
 * Batch validate multiple tokens
 */
export async function validateBatchTradeOpportunities(
  tokenMints: string[],
): Promise<TradeValidationResult[]> {
  log.info(`📊 Batch validating ${tokenMints.length} trade opportunities...`);

  const results = await Promise.all(
    tokenMints.map((mint) => validateTradeOpportunity(mint)),
  );

  const approved = results.filter((r) => r.approved);
  const ignored = results.filter((r) => !r.approved);

  log.info(
    `📊 Batch results: ${approved.length} APPROVED | ${ignored.length} IGNORED`,
  );

  return results;
}
