// backend/src/services/trancheBuyer.service.ts
import {
  getJupiterQuote,
  executeJupiterSwap,
  getJupiterTokenInfo,
  getSolPriceUsd,
} from "./jupiter.service.js";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("tranche-buyer");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Previously bare literals with no override anywhere in this file, unlike
// MAX_SLIPPAGE_PCT just below.
const PRICE_IMPACT_ABORT_PCT = Number(process.env.TRANCHE_PRICE_IMPACT_ABORT_PCT ?? 15);
const TEST_SELL_PCT = Number(process.env.TEST_SELL_PCT ?? 0.005);
const TEST_SELL_SLIPPAGE_BPS = Number(process.env.TEST_SELL_SLIPPAGE_BPS ?? 200);
const PULLBACK_THRESHOLD_PCT = Number(process.env.PULLBACK_THRESHOLD_PCT ?? 0.02);

interface TrancheResult {
  success: boolean;
  tokenQty?: number; // Token quantity received
  pricePerToken?: number; // SOL per token
  signature?: string | undefined;
  error?: string;
}

async function executeTranche(
  mint: string,
  trancheSol: number,
  wallet: string,
  decimals: number,
  useReal: boolean,
  simLabel: string,
  logLabel: string
): Promise<TrancheResult> {
  try {
    const lamports = Math.floor(trancheSol * 1e9);

    LOG.info({ mint, trancheSol, useReal }, `Executing ${logLabel}`);

    // Get quote to estimate token amount with slippage 8-12%
    const slippagePct = Number(process.env.MAX_SLIPPAGE_PCT || 10); // Default 10%
    const quote = await getJupiterQuote(SOL_MINT, mint, lamports, slippagePct * 100);
    if (!quote?.outAmount) {
      return { success: false, error: `No quote for ${logLabel}` };
    }

    // Check if price impact is extreme (abort)
    if (quote.priceImpactPct && quote.priceImpactPct > PRICE_IMPACT_ABORT_PCT) {
      return {
        success: false,
        error: `Price impact too high: ${quote.priceImpactPct.toFixed(2)}%`,
      };
    }

    const swap = useReal
      ? await executeJupiterSwap({
          inputMint: SOL_MINT,
          outputMint: mint,
          amount: lamports,
          userPublicKey: wallet,
          slippageBps: slippagePct * 100,
        })
      : { success: true as const, signature: `sim-${simLabel}-${Date.now()}` };

    if (!swap.success) {
      return { success: false, error: (swap as any).error || "Swap failed" };
    }

    const tokenQty = Number(quote.outAmount) / 10 ** decimals;
    const pricePerToken = trancheSol / tokenQty;

    LOG.info(
      { mint, tokenQty, pricePerToken, signature: swap.signature },
      `${logLabel} executed successfully`
    );

    return { success: true, tokenQty, pricePerToken, signature: swap.signature };
  } catch (err: any) {
    LOG.error({ err: err.message || err }, `${logLabel} execution failed`);
    return { success: false, error: err.message || "Unknown error" };
  }
}

/**
 * Execute first tranche buy (60% of position)
 */
export async function executeFirstTranche(
  mint: string,
  totalBuySol: number,
  wallet: string,
  useReal: boolean,
  decimals: number = 9
): Promise<TrancheResult> {
  return executeTranche(
    mint,
    totalBuySol * 0.6,
    wallet,
    decimals,
    useReal,
    "tranche1",
    "first tranche (60%)"
  );
}

/**
 * Execute second tranche buy (40% of position)
 */
export async function executeSecondTranche(
  mint: string,
  totalBuySol: number,
  wallet: string,
  useReal: boolean,
  decimals: number = 9
): Promise<TrancheResult> {
  return executeTranche(
    mint,
    totalBuySol * 0.4,
    wallet,
    decimals,
    useReal,
    "tranche2",
    "second tranche (40%)"
  );
}

/**
 * Execute test sell (0.5% of received tokens)
 * Used to verify liquidity and trading viability
 */
export async function executeTestSell(
  mint: string,
  tokenQty: number,
  decimals: number,
  wallet: string,
  useReal: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const testSellQty = tokenQty * TEST_SELL_PCT;
    const testSellBase = Math.floor(testSellQty * 10 ** decimals);

    LOG.info(
      { mint, totalTokens: tokenQty, testSellQty, testSellBase, decimals },
      "Executing 0.5% test sell"
    );

    if (!testSellBase || testSellBase <= 0) {
      return { success: false, error: "Test sell amount too small" };
    }

    // Get quote to verify we can sell
    const quote = await getJupiterQuote(mint, SOL_MINT, testSellBase, 100);
    if (!quote?.outAmount) {
      return { success: false, error: "No quote for test sell - illiquid!" };
    }

    const receivedSol = Number(quote.outAmount) / 1e9;
    if (receivedSol <= 0) {
      return { success: false, error: "Test sell would receive 0 SOL" };
    }

    if (useReal) {
      const swap = await executeJupiterSwap({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: testSellBase,
        userPublicKey: wallet,
        slippageBps: TEST_SELL_SLIPPAGE_BPS, // Higher slippage for small test sell
      });

      if (!swap.success) {
        return { success: false, error: swap.error || "Test sell swap failed" };
      }

      LOG.info({ mint, receivedSol, signature: swap.signature }, "Test sell executed successfully");
    } else {
      LOG.info({ mint, receivedSol }, "Test sell simulated successfully");
    }

    return { success: true };
  } catch (err: any) {
    LOG.error({ err: err.message || err }, "Test sell execution failed");
    return { success: false, error: err.message || "Unknown error" };
  }
}

/**
 * Wait for price pullback before executing second tranche
 * Monitors price for a micro-dip (configurable threshold)
 */
export async function waitForPullback(
  mint: string,
  entryPrice: number,
  timeoutMs: number = 300000 // 5 minutes default
): Promise<{ success: boolean; currentPrice?: number }> {
  const startTime = Date.now();
  const pullbackThreshold = 1 - PULLBACK_THRESHOLD_PCT;

  LOG.info(
    { mint, entryPrice, targetPrice: entryPrice * pullbackThreshold, timeoutMs },
    "Waiting for pullback to execute second tranche"
  );

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Fair-value price, not a buy-side probe quote — a probe's own price
      // impact isn't comparable to entryPrice (the real fill price of a much
      // larger tranche at a different size), the same bias already fixed in
      // monitor.service.ts's PnL calculation.
      const [tokenInfo, solPriceUsd] = await Promise.all([
        getJupiterTokenInfo(mint),
        getSolPriceUsd(),
      ]);

      if (tokenInfo?.usdPrice && solPriceUsd) {
        const currentPrice = tokenInfo.usdPrice / solPriceUsd;

        LOG.debug(
          {
            mint,
            currentPrice,
            entryPrice,
            pullbackPct: ((currentPrice - entryPrice) / entryPrice) * 100,
          },
          "Checking for pullback"
        );

        if (currentPrice <= entryPrice * pullbackThreshold) {
          LOG.info(
            {
              mint,
              currentPrice,
              entryPrice,
              pullbackPct: ((currentPrice - entryPrice) / entryPrice) * 100,
            },
            "Pullback detected - ready for second tranche"
          );
          return { success: true, currentPrice };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (err: any) {
      LOG.warn({ err: err.message || err }, "Error checking price for pullback");
    }
  }

  LOG.warn({ mint, timeoutMs }, "Pullback timeout - executing second tranche at current price");
  return { success: true }; // Still return success to not block second tranche
}
