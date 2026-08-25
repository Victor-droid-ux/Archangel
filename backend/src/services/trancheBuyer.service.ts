// backend/src/services/trancheBuyer.service.ts
import { getJupiterQuote, executeJupiterSwap } from "./jupiter.service.js";
import { Keypair } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("tranche-buyer");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Previously bare literals with no override anywhere in this file, unlike
// MAX_SLIPPAGE_PCT just below.
const PRICE_IMPACT_ABORT_PCT = Number(
  process.env.TRANCHE_PRICE_IMPACT_ABORT_PCT ?? 15,
);

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
  logLabel: string,
  signer?: Keypair,
): Promise<TrancheResult> {
  try {
    const lamports = Math.floor(trancheSol * 1e9);

    LOG.info({ mint, trancheSol, useReal }, `Executing ${logLabel}`);

    // Get quote to estimate token amount with slippage 8-12%
    const slippagePct = Number(process.env.MAX_SLIPPAGE_PCT || 10); // Default 10%
    const quote = await getJupiterQuote(
      SOL_MINT,
      mint,
      lamports,
      slippagePct * 100,
    );
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
          ...(signer ? { signer } : {}),
        })
      : { success: true as const, signature: `sim-${simLabel}-${Date.now()}` };

    if (!swap.success) {
      return { success: false, error: (swap as any).error || "Swap failed" };
    }

    const tokenQty = Number(quote.outAmount) / 10 ** decimals;
    const pricePerToken = trancheSol / tokenQty;

    LOG.info(
      { mint, tokenQty, pricePerToken, signature: swap.signature },
      `${logLabel} executed successfully`,
    );

    return {
      success: true,
      tokenQty,
      pricePerToken,
      signature: swap.signature,
    };
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
  decimals: number = 9,
  signer?: Keypair,
): Promise<TrancheResult> {
  return executeTranche(
    mint,
    totalBuySol * 0.6,
    wallet,
    decimals,
    useReal,
    "tranche1",
    "first tranche (60%)",
    signer,
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
  decimals: number = 9,
  signer?: Keypair,
): Promise<TrancheResult> {
  return executeTranche(
    mint,
    totalBuySol * 0.4,
    wallet,
    decimals,
    useReal,
    "tranche2",
    "second tranche (40%)",
    signer,
  );
}
