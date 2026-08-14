import express from "express";
import {
  getEffectiveConfig,
  shouldTriggerTrade,
} from "../services/traderConfig.service.js";
import db from "../services/db.service.js";
import { getLogger } from "../utils/logger.js";
import {
  getJupiterQuote,
  buildJupiterSwapPayload,
  getJupiterTokenInfo,
  getSolPriceUsd,
} from "../services/jupiter.service.js";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { validateTradeOpportunity } from "../services/tradeValidation.service.js";
import { executeManualBuy } from "../services/manualBuy.service.js";

const logger = getLogger("trade.route");
const router = express.Router();

/**
 * GET /api/trade/history?limit=50
 * Recent real trades (buys + sells), newest first. Used to backfill the
 * frontend's Live Feed / Trade History on page load — without this, a
 * freshly-opened dashboard shows nothing for positions/trades that happened
 * before the page was loaded, since the socket-driven feed only ever
 * accumulates events that arrive while the page stays mounted.
 */
router.get("/history", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const trades = await db.getTrades(limit, false);
    return res.json({ success: true, trades });
  } catch (err: any) {
    logger.error("❌ Failed to load trade history:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/trade/validate
 * body: { tokenMint }
 * Returns validation result for 3 critical conditions
 */
router.post("/validate", async (req, res) => {
  try {
    const { tokenMint } = req.body;
    if (!tokenMint) {
      return res
        .status(400)
        .json({ success: false, message: "Missing tokenMint" });
    }

    const validation = await validateTradeOpportunity(tokenMint);
    return res.json({ success: true, validation });
  } catch (error: any) {
    logger.error(`Validation error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/trade/manual-buy
 * body: { tokenMint, amountSol, slippage?, wallet? }
 * NO VALIDATIONS - User discretion only (DYOR)
 */
router.post("/manual-buy", async (req, res) => {
  try {
    const { tokenMint, amountSol, slippage, wallet } = req.body;

    if (!tokenMint || !amountSol) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: tokenMint, amountSol",
      });
    }

    logger.info(
      `⚠️ Manual buy request: ${amountSol} SOL for ${tokenMint.slice(
        0,
        8
      )}... (NO VALIDATIONS)`
    );

    // Execute manual buy with NO validations
    const result = await executeManualBuy({
      tokenMint,
      amountSol,
      slippage:
        slippage ||
        parseFloat(process.env.MANUAL_BUY_DEFAULT_SLIPPAGE_PCT || "10"),
      reason: "manual_ui",
      wallet,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || "Manual buy failed",
      });
    }

    // Store trade in database
    const trade = await db.addTrade({
      type: "buy",
      token: tokenMint,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: tokenMint,
      amount: Math.floor(amountSol * 1e9),
      price: result.pricePerToken || 0,
      pnl: 0,
      wallet: wallet || process.env.WALLET_PUBLIC_KEY || "",
      simulated: false,
      signature: result.signature || null,
      route: "jupiter",
      timestamp: new Date(),
    });

    // Broadcast via socket
    const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
    io?.emit?.("tradeFeed", trade);

    logger.info(`✅ Manual buy executed: ${result.signature}`);

    return res.json({
      success: true,
      data: {
        ...result,
        trade,
      },
    });
  } catch (error: any) {
    logger.error(`Manual buy error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: error.message || "Manual buy failed",
    });
  }
});

// A generic "POST /api/trade" (root) endpoint used to live here — a second,
// server-signs-the-transaction execution path alongside the real one below
// (/prepare + /confirm, where the client signs with their own wallet).
// Nothing in the frontend ever called it (confirmed against every fetcher()/
// fetch() call in frontend/), and its trust model — the backend holding
// signing authority for an arbitrary `wallet` param — doesn't match how any
// live path actually works. Removed rather than left as an unused, divergent
// second way to execute a real trade.

/**
 * POST /api/trade/prepare
 * Prepare an unsigned transaction for the frontend to sign
 */
router.post("/prepare", async (req, res) => {
  try {
    const {
      type,
      inputMint,
      outputMint,
      wallet,
      amountLamports,
      slippageBps,
    } = req.body;

    if (!type || !outputMint || !wallet || !amountLamports) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    // Get the token mint (for buy it's outputMint, for sell it's inputMint)
    const tokenMint = type === "buy" ? outputMint : inputMint;
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // Set default mints if not provided
    const finalInputMint = inputMint || (type === "buy" ? SOL_MINT : tokenMint);
    const finalOutputMint =
      outputMint || (type === "sell" ? SOL_MINT : tokenMint);

    // Check trader config to see if trade should trigger
    const config = await getEffectiveConfig(wallet, tokenMint);

    // Enforce the configured trigger market cap server-side. Previously this
    // only ever ran client-side (token-config-modal.tsx), which a direct API
    // call bypasses entirely — this endpoint would prepare (and /confirm
    // would happily execute) a buy regardless of whether the user's own
    // trigger condition was actually met.
    if (type === "buy" && config.triggerMarketCapSol) {
      let currentMarketCapSol = 0;
      try {
        const [tokenInfo, solPriceUsd] = await Promise.all([
          getJupiterTokenInfo(tokenMint),
          getSolPriceUsd(),
        ]);
        const mcapUsd = (tokenInfo as any)?.mcap ?? 0;
        currentMarketCapSol = solPriceUsd > 0 ? mcapUsd / solPriceUsd : 0;
      } catch (err: any) {
        logger.warn(
          `Failed to fetch market cap for trigger check on ${tokenMint.slice(
            0,
            8
          )}...: ${err.message}`
        );
      }

      const shouldTrigger = await shouldTriggerTrade(
        wallet,
        tokenMint,
        currentMarketCapSol
      );
      if (!shouldTrigger) {
        logger.info(
          `⏭️ Trade not triggered: ${tokenMint.slice(
            0,
            8
          )}... current MC ${currentMarketCapSol.toFixed(
            2
          )} SOL has not reached configured trigger ${
            config.triggerMarketCapSol
          } SOL`
        );
        return res.status(400).json({
          success: false,
          message: `Market cap (${currentMarketCapSol.toFixed(
            2
          )} SOL) has not reached the configured trigger (${
            config.triggerMarketCapSol
          } SOL)`,
        });
      }
    }

    logger.info(
      `Preparing Jupiter ${type} trade for token ${tokenMint.slice(0, 8)}...`
    );

    const quote = await getJupiterQuote(
      finalInputMint,
      finalOutputMint,
      amountLamports,
      slippageBps || 100
    );

    if (!quote) {
      const errorMessage = "No Jupiter route found for this token.";
      const suggestion =
        "Verify the token address is correct and has sufficient liquidity.";

      logger.error(
        `No Jupiter quote available for ${tokenMint.slice(
          0,
          8
        )}... - ${errorMessage}`
      );

      return res.status(400).json({
        success: false,
        message: `${errorMessage} ${suggestion}`,
        tokenAddress: tokenMint,
        dexScreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
        canRetry: false,
      });
    }

    // Build unsigned transaction
    const { swapTransaction } = await buildJupiterSwapPayload(quote, wallet);

    logger.info(`Prepared Jupiter ${type} transaction for ${wallet}`);

    return res.json({
      success: true,
      data: {
        transaction: swapTransaction,
        config: config,
        quote: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inAmount: quote.inAmount,
          slippageBps: quote.slippageBps,
        },
      },
    });
  } catch (err: any) {
    logger.error("Prepare trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/confirm
 * Confirm and execute a client-signed transaction (Jupiter)
 */
router.post("/confirm", async (req, res) => {
  try {
    const {
      signedTransaction,
      type,
      token,
      amountLamports,
      takeProfit,
      stopLoss,
      wallet,
      slippageBps,
    } = req.body;

    if (!type || !token || !amountLamports) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    if (!signedTransaction) {
      return res.status(400).json({
        success: false,
        message: "Signed transaction required for Jupiter trades",
      });
    }

    let signature: string;
    let price: number;

    // Deserialize and send the client-signed transaction
    logger.info(
      `Executing ${type} trade via Jupiter for token ${token.slice(0, 8)}...`
    );

    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const versionedTx = VersionedTransaction.deserialize(txBuffer);

    // Send transaction to Solana
    signature = await connection.sendTransaction(versionedTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    logger.info(`Transaction sent: ${signature}`);

    // Confirm transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    // Real price (SOL per token) from a fresh same-direction quote — this used to
    // be Math.random(), which fabricated the recorded price/PnL for every trade
    // regardless of whether it succeeded. This is still a post-trade estimate
    // (a fresh quote, not a parse of this exact transaction's balance deltas —
    // and it assumes 9 token decimals, matching the approximation already used
    // elsewhere in this codebase, e.g. trancheBuyer.service.ts), but it's
    // grounded in real market data instead of being invented outright.
    price = 0;
    try {
      const quoteInputMint =
        type === "buy" ? "So11111111111111111111111111111111111111112" : token;
      const quoteOutputMint =
        type === "buy" ? token : "So11111111111111111111111111111111111111112";
      const priceQuote = await getJupiterQuote(
        quoteInputMint,
        quoteOutputMint,
        amountLamports,
        slippageBps || 500
      );
      if (priceQuote?.outAmount) {
        const solAmount = amountLamports / 1e9;
        const tokenAmount = Number(priceQuote.outAmount) / 1e9;
        price =
          type === "buy" ? solAmount / tokenAmount : tokenAmount / solAmount;
      }
    } catch (err: any) {
      logger.warn(`Failed to compute real trade price: ${err.message}`);
    }

    // Record trade in database
    const pnl = 0; // Will be calculated later based on position tracking

    const trade = await db.addTrade({
      type,
      token: token,
      inputMint:
        type === "buy" ? "So11111111111111111111111111111111111111112" : token,
      outputMint:
        type === "buy" ? token : "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      price,
      pnl,
      wallet: wallet || "unknown",
      simulated: false,
      signature,
      timestamp: new Date(),
    });

    // Broadcast via socket
    const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
    io?.emit?.("tradeFeed", trade);

    logger.info(`Confirmed ${type} trade (Jupiter): ${signature}`);

    return res.json({
      success: true,
      data: {
        ...trade,
        takeProfit,
        stopLoss,
      },
    });
  } catch (err: any) {
    logger.error("Confirm trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/calculate-risk
 * Calculate trade size based on risk parameters
 * Body: { balance, riskPercent, riskAmount }
 */
router.post("/calculate-risk", async (req, res) => {
  try {
    const { balance, riskPercent, riskAmount } = req.body;

    if (!balance || typeof balance !== "number") {
      return res.status(400).json({
        success: false,
        message: "Balance is required and must be a number",
      });
    }

    let calculatedAmount = 0;
    let calculatedPercent = 0;

    // If risk amount is provided, use it directly
    if (riskAmount && typeof riskAmount === "number" && riskAmount > 0) {
      calculatedAmount = riskAmount;
      calculatedPercent = (riskAmount / balance) * 100;
    }
    // If risk percent is provided, calculate amount from percentage
    else if (
      riskPercent &&
      typeof riskPercent === "number" &&
      riskPercent > 0
    ) {
      calculatedPercent = riskPercent;
      calculatedAmount = (balance * riskPercent) / 100;
    }
    // Default to 1% of balance
    else {
      calculatedPercent = 1;
      calculatedAmount = balance * 0.01;
    }

    // Cap at 100% of balance
    if (calculatedAmount > balance) {
      calculatedAmount = balance;
      calculatedPercent = 100;
    }

    // Ensure minimum trade size (0.001 SOL)
    if (calculatedAmount < 0.001) {
      calculatedAmount = 0.001;
      calculatedPercent = (0.001 / balance) * 100;
    }

    logger.info(
      `Risk calculation: Balance=${balance.toFixed(
        4
      )} SOL, Risk=${calculatedPercent.toFixed(
        2
      )}%, Amount=${calculatedAmount.toFixed(4)} SOL`
    );

    return res.json({
      success: true,
      data: {
        balance,
        riskPercent: Number(calculatedPercent.toFixed(2)),
        riskAmount: Number(calculatedAmount.toFixed(4)),
        amountLamports: Math.floor(calculatedAmount * 1e9),
        recommendation: {
          conservative: Number((balance * 0.01).toFixed(4)), // 1%
          moderate: Number((balance * 0.025).toFixed(4)), // 2.5%
          aggressive: Number((balance * 0.05).toFixed(4)), // 5%
        },
      },
    });
  } catch (err: any) {
    logger.error("Risk calculation error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * Pool monitoring endpoints removed - Jupiter-only system
 */

export default router;
