// backend/src/services/manualBuy.service.ts
import { executeJupiterSwap, getJupiterQuote } from "./jupiter.service.js";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";

const LOG = getLogger("manual-buy");

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface ManualBuyParams {
  tokenMint: string;
  amountSol: number;
  slippage: number;
  reason?: string;
  poolId?: string;
  wallet?: string;
}

interface ManualBuyResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  pricePerToken?: number;
  error?: string;
}

/**
 * Execute a manual buy via Jupiter
 * Used for both UI manual trades and programmatic auto-buy
 */
export async function executeManualBuy(
  params: ManualBuyParams
): Promise<ManualBuyResult> {
  const { tokenMint, amountSol, slippage, reason, poolId, wallet } = params;

  try {
    const isAutoBuy = reason === "auto_buy";
    const isManual = !isAutoBuy;

    // Apply configuration based on trade type
    let effectiveSlippage = slippage;

    if (isManual) {
      // Manual buy: NO VALIDATIONS - user has done their own research
      LOG.info(
        {
          token: tokenMint.slice(0, 8),
          amountSol,
          slippage: slippage || "default",
        },
        "🛒 Manual buy - NO SAFETY CHECKS (user discretion)"
      );

      // Use default slippage if not provided
      if (!effectiveSlippage) {
        effectiveSlippage = parseFloat(
          process.env.MANUAL_BUY_DEFAULT_SLIPPAGE_PCT || "10"
        );
      }
    } else {
      // Auto-buy: Apply strict validations
      LOG.info(
        {
          token: tokenMint.slice(0, 8),
          amountSol,
          slippage: effectiveSlippage,
        },
        "🛒 Auto-buy with validation"
      );
    }

    // FIX 3: Minimum trade size protection
    // Block trades smaller than minimum to prevent routing failures
    const MINIMUM_SWAP_SOL = 0.003;
    if (amountSol < MINIMUM_SWAP_SOL) {
      throw new Error(
        `Trade too small: ${amountSol} SOL (minimum: ${MINIMUM_SWAP_SOL} SOL)`
      );
    }

    // Convert to lamports and keep as string to avoid precision loss
    const lamports = Math.floor(amountSol * 1e9).toString();

    // Step 1: Get Jupiter quote
    LOG.debug("Getting Jupiter quote...");
    const quote = await getJupiterQuote(
      SOL_MINT,
      tokenMint,
      lamports,
      effectiveSlippage * 100 // percent -> bps
    );

    if (!quote || !quote.outAmount) {
      LOG.error("Failed to get swap quote from Jupiter");
      LOG.warn(`Token ${tokenMint.slice(0, 8)}... has no Jupiter route or pool not found`);
      return {
        success: false,
        error:
          "No Jupiter route found for this token. Verify the token address is correct and has sufficient liquidity.",
      };
    }

    // Price impact check: ONLY for auto-buy
    if (isAutoBuy && quote.priceImpactPct && quote.priceImpactPct > 15) {
      LOG.warn(
        `Auto-buy rejected: Price impact too high: ${quote.priceImpactPct.toFixed(
          2
        )}%`
      );
      return {
        success: false,
        error: `Price impact too high: ${quote.priceImpactPct.toFixed(
          2
        )}%. Aborting for safety.`,
      };
    }

    // Manual buy: Log price impact but don't block
    if (isManual && quote.priceImpactPct) {
      LOG.warn(
        `⚠️ Manual buy proceeding with ${quote.priceImpactPct.toFixed(
          2
        )}% price impact (no restrictions)`
      );
    }

    LOG.info(
      {
        tokensOut: (quote.outAmount / 1e9).toFixed(6),
        priceImpact: quote.priceImpactPct?.toFixed(2) + "%",
      },
      "Quote received"
    );

    // Step 2: Execute swap
    const useRealSwap = process.env.USE_REAL_SWAP === "true";

    if (useRealSwap) {
      LOG.info("🚀 Executing real swap via Jupiter...");

      const swapParams = {
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        userPublicKey: wallet || process.env.WALLET_PUBLIC_KEY || "",
        slippageBps: effectiveSlippage * 100,
      };
      const result = await executeJupiterSwap(swapParams);

      if (!result.success) {
        LOG.error(`Swap failed: ${result.error}`);
        return {
          success: false,
          error: result.error || "Swap execution failed",
        };
      }
      // Estimate from the quote fetched in Step 1 (before execution, so this
      // is the expected output, not an exact parse of this swap's actual
      // balance deltas — same caveat as trade.route.ts's /confirm handler).
      // This used to be hardcoded to 0 ("will be calculated from on-chain
      // data" — never was), which reported "0 tokens received" on every
      // successful real buy and saved price: 0 into the trade record.
      const tokensReceived = quote.outAmount / 1e9;
      const pricePerToken = tokensReceived > 0 ? amountSol / tokensReceived : 0;

      LOG.info(
        {
          signature: result.signature,
          tokensReceived: tokensReceived.toFixed(6),
          pricePerToken: pricePerToken.toFixed(9),
        },
        "✅ Manual buy executed"
      );

      // Store in database
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: Number(lamports),
        price: pricePerToken,
        pnl: 0,
        wallet: wallet || process.env.WALLET_PUBLIC_KEY || "",
        simulated: false,
        signature: result.signature ?? null,
        route: "jupiter",
      });

      // Update token state
      await dbService.upsertTokenState({
        mint: tokenMint,
        state: "BOUGHT",
        source: "jupiter",
        detectedAt: new Date(),
      });

      return {
        success: true,
        signature: result.signature ?? "",
        tokensReceived,
        pricePerToken,
      };
    } else {
      // Simulation mode
      LOG.info("📝 Simulating swap (USE_REAL_SWAP=false)");

      const tokensReceived = quote.outAmount / 1e9;
      const pricePerToken = amountSol / tokensReceived;
      const signature = `sim-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;

      LOG.info(
        {
          signature,
          tokensReceived: tokensReceived.toFixed(6),
          pricePerToken: pricePerToken.toFixed(9),
        },
        "✅ Simulated swap"
      );

      // Store in database
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: Number(lamports),
        price: pricePerToken,
        pnl: 0,
        wallet: wallet || process.env.WALLET_PUBLIC_KEY || "",
        simulated: true,
        signature,
        route: "jupiter",
      });

      return {
        success: true,
        signature,
        tokensReceived,
        pricePerToken,
      };
    }
  } catch (err: any) {
    LOG.error(`Manual buy error: ${err.message}`);
    return {
      success: false,
      error: err.message || "Unknown error during manual buy",
    };
  }
}

/**
 * Calculate position size based on risk percentage
 * Example: If balance is 10 SOL and risk is 2%, returns 0.2 SOL
 */
export async function calculatePositionSize(
  balanceSol: number,
  riskPercentage: number
): Promise<number> {
  const maxRisk = Number(process.env.MAX_RISK_PER_TRADE_PCT || 2);
  const actualRisk = Math.min(riskPercentage, maxRisk);
  return balanceSol * (actualRisk / 100);
}

/**
 * Get current SOL balance
 */
export async function getSolBalance(wallet: string): Promise<number> {
  try {
    const { Connection } = await import("@solana/web3.js");
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
    );
    const balance = await connection.getBalance(
      new (
        await import("@solana/web3.js")
      ).PublicKey(wallet)
    );
    return balance / 1e9;
  } catch (err: any) {
    LOG.error(`Error fetching SOL balance: ${err.message}`);
    return 0;
  }
}
