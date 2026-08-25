// backend/src/services/autoBuyer.service.ts
import crypto from "crypto";
import { Server } from "socket.io";
import { getJupiterQuote, executeJupiterSwap } from "./jupiter.service.js";
import dbService, { TradeRecord } from "./db.service.js";
import { getLogger } from "../utils/logger.js";
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { hasSufficientBalance, getBalanceInSol } from "./solana.service.js";
import { validateFastLaunchOpportunity } from "./tradeValidation.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { canExecuteTrade } from "./riskManagement.service.js";
import {
  executeFirstTranche,
  executeSecondTranche,
} from "./trancheBuyer.service.js";
import multiUserExecutionService, {
  launchAgeWithinWindow,
} from "./multiUserExecution.service.js";
import { WalletContext } from "./validationPipeline.service.js";
import {
  getEffectiveLaunchWindowSeconds,
  getEffectiveConfig,
} from "./traderConfig.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import { withWalletLock } from "../utils/walletMutex.js";

const LOG = getLogger("autoBuyer");
import { ENV } from "../utils/env.js";

// Returns true if mint is in list (case-insensitive)
function isInList(mint: string, list: string[]): boolean {
  return list.some((addr) => addr.trim().toLowerCase() === mint.toLowerCase());
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

/* ---------------- RPC for token decimals (Helius preferred) ---------------- */
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) || "https://api.mainnet-beta.solana.com";

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

const decimalsCache = new Map<string, number>();

// Returns null (never a guessed number) when the real decimals can't be
// determined. Decimals feed directly into tokenQty/pricePerToken math in
// trancheBuyer.service.ts, which becomes the position's recorded cost basis —
// silently guessing 9 for a 6-decimal token corrupts that by 1000x. A failure
// is NOT cached, so a transient RPC blip can self-heal on the next attempt
// instead of poisoning this mint for the rest of the process's lifetime.
async function getDecimals(mint: string): Promise<number | null> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!;

  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const d =
      (info.value?.data as any)?.parsed?.info?.decimals ??
      (info.value?.data as any)?.info?.decimals;

    if (d === undefined || d === null) {
      LOG.warn({ mint }, "Could not determine real token decimals");
      return null;
    }

    const num = Number(d);
    if (!Number.isFinite(num)) {
      LOG.warn({ mint, raw: d }, "Token decimals value not a valid number");
      return null;
    }
    decimalsCache.set(mint, num);
    return num;
  } catch (err) {
    LOG.warn({ mint, err }, "Failed to fetch token decimals");
    return null;
  }
}

/* ------------------------------------------------------------------------
   AUTO BUY EXECUTOR (triggered by token discovery)
------------------------------------------------------------------------ */
export async function registerAutoBuyCandidate(io: Server, token: any) {
  // === Blacklist/Whitelist Filtering ===
  const mint = token.mint;
  if (!mint) return;

  // Captured now, before the strategy engine, 3-condition validation, and
  // the 30-second market-behavior observation below run — those stages
  // alone add 30+ seconds of processing time, so measuring age AFTER them
  // (as this used to) checked "is this still young enough having spent 30+
  // seconds deciding," not "was this young enough when we found it." Against
  // the tight default Launch Window (10-60s), that inflation made the
  // window mathematically almost impossible to clear for a real launch —
  // this is reused as-is in the per-wallet loop further down, never
  // recomputed later.
  const ageSecondsAtDiscovery = token.pairCreatedAt
    ? (Date.now() - Number(token.pairCreatedAt)) / 1000
    : undefined;
  // The 4 checks below (blacklist/whitelist/strategy/decimals) are all
  // token-intrinsic — evaluated once per discovered token, before any
  // specific wallet is even considered. They used to broadcast as
  // "tradeError" to every connected socket, which meant every visitor got a
  // popup for the bot's routine background scanning of the entire token
  // universe (most tokens never pass these), not anything about their own
  // account. Logged for backend diagnostics only now — see the per-wallet
  // checks further down for what actually surfaces as a user-facing popup.
  if (ENV.TOKEN_BLACKLIST.length && isInList(mint, ENV.TOKEN_BLACKLIST)) {
    LOG.warn({ mint }, "⛔ Skipping blacklisted token");
    return;
  }
  if (ENV.TOKEN_WHITELIST.length && !isInList(mint, ENV.TOKEN_WHITELIST)) {
    LOG.warn({ mint }, "⛔ Skipping non-whitelisted token");
    return;
  }

  // The launch window is each wallet's own setting — see the per-wallet
  // check in the fan-out loop below, not a shared gate here.

  try {
    // Launch sniping uses fast intrinsic checks; historical strategy approval
    // is intentionally not required because new tokens have no history yet.
    LOG.info({ mint }, "🔍 Validating token with 3 CRITICAL CONDITIONS...");
    const validation = await validateFastLaunchOpportunity(mint);
    io.emit("validationResult", {
      ...validation,
      token: {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        logoUri: token.logoUri,
        marketCapSol: token.marketCapSol,
        priceSol: token.priceSol,
        lifecycleStage: token.lifecycleStage,
      },
    });
    if (!validation.approved) {
      LOG.info(
        {
          mint,
          recommendation: validation.recommendation,
          reason: validation.reason,
        },
        `⏭️ Skipping trade: ${validation.reason}`,
      );
      return;
    }

    LOG.info({ mint }, "✅ Fast intrinsic checks passed; evaluating wallets");

    // Real token decimals — token-intrinsic, doesn't depend on which wallet
    // ends up buying, so this is fetched once and reused across the fan-out
    // below rather than once per wallet.
    const decimals = await getDecimals(mint);
    if (decimals === null) {
      LOG.warn(
        { mint },
        "⏭️ Skipping trade: could not verify real token decimals — refusing to guess on a value that determines cost basis",
      );
      return;
    }

    // Every token-intrinsic check has passed — fan out across every
    // eligible wallet (the operator's own, plus every funded, auto-trade-
    // enabled user's custodial hot wallet), each independently sized,
    // risk-checked, and executed with its own capital. Same pattern as
    // jupiterDiscovery.service.ts / storedTokenChecker.service.ts.
    const eligibleWallets =
      await multiUserExecutionService.getEligibleWallets();
    let lastTrade: TradeRecord | null = null;
    // The age captured at the top of this function, before any of the
    // pipeline's own processing time could inflate it — undefined when
    // Jupiter didn't report a pool-creation time, matching the old
    // isWithinLaunchWindow's fallback of allowing the token through.
    const ageSeconds = ageSecondsAtDiscovery;

    for (const walletContext of eligibleWallets) {
      // Re-checked fresh right before this wallet's own execution, not just
      // trusted from the eligibleWallets snapshot above — closes the window
      // where Stop Auto Trade disables the flag after this fan-out started
      // but before this specific wallet's turn came up.
      if (
        !(await multiUserExecutionService.isAutoTradeCurrentlyEnabled(
          walletContext.ownerWallet,
        ))
      ) {
        LOG.debug(
          { mint, wallet: walletContext.ownerWallet },
          "⏭️ Skipping wallet: auto-trade was disabled after this run started",
        );
        continue;
      }

      const launchMetrics = {
        marketCapUSD: Number(token.launchMarketCapUSD ?? token.marketCapUSD),
        marketCapSOL: Number(token.launchMarketCapSOL ?? token.marketCapSol),
        liquidityUSD: Number(token.launchLiquidityUSD ?? token.liquidity),
        liquiditySOL: Number(token.launchLiquiditySOL ?? token.liquiditySOL),
      };
      const config = await getEffectiveConfig(walletContext.ownerWallet, mint);
      const launchMetricsAvailable = Object.values(launchMetrics).every(
        (value) => Number.isFinite(value),
      );
      const launchMetricsWithinLimits =
        launchMetricsAvailable &&
        launchMetrics.marketCapUSD >= config.minMarketCapUsd &&
        launchMetrics.marketCapUSD <= config.maxMarketCapUsd &&
        launchMetrics.marketCapSOL >= config.minMarketCapSol &&
        launchMetrics.marketCapSOL <= config.maxMarketCapSol &&
        launchMetrics.liquidityUSD >= config.minLiquidityUsd &&
        launchMetrics.liquidityUSD <= config.maxLiquidityUsd &&
        launchMetrics.liquiditySOL >= config.minLiquiditySol &&
        launchMetrics.liquiditySOL <= config.maxLiquiditySol;

      if (!launchMetricsWithinLimits) {
        LOG.info(
          { mint, wallet: walletContext.ownerWallet, launchMetrics, config },
          "Skipping wallet: launch market cap/liquidity is outside its configured limits",
        );
        emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeError", {
          type: "launch_metrics_out_of_range",
          mint,
          reason:
            "Launch market cap or liquidity is outside your configured limits",
          message:
            "Launch market cap or liquidity is outside your configured limits",
          launchMetrics,
          limits: {
            minMarketCapUSD: config.minMarketCapUsd,
            maxMarketCapUSD: config.maxMarketCapUsd,
            minMarketCapSOL: config.minMarketCapSol,
            maxMarketCapSOL: config.maxMarketCapSol,
            minLiquidityUSD: config.minLiquidityUsd,
            maxLiquidityUSD: config.maxLiquidityUsd,
            minLiquiditySOL: config.minLiquiditySol,
            maxLiquiditySOL: config.maxLiquiditySol,
          },
        });
        continue;
      }

      if (ageSeconds !== undefined) {
        const launchWindow = await getEffectiveLaunchWindowSeconds(
          walletContext.ownerWallet,
        );

        if (
          !launchWindow ||
          !launchAgeWithinWindow(token.pairCreatedAt, Date.now(), launchWindow)
        ) {
          LOG.debug(
            {
              mint,
              wallet: walletContext.ownerWallet,
              ageSeconds,
              launchWindow,
            },
            "⏳ Skipping wallet: token not within this wallet's launch window",
          );
          emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeError", {
            type: "launch_window",
            mint,
            reason: launchWindow
              ? `Not within your launch window (${launchWindow.min}-${launchWindow.max}s) — token is ${ageSeconds.toFixed(0)}s old`
              : "Launch window is not configured",
            message: launchWindow
              ? `Not within your launch window (${launchWindow.min}-${launchWindow.max}s)`
              : "Launch window is not configured",
          });
          continue;
        }
      } else {
        LOG.info(
          { mint, wallet: walletContext.ownerWallet },
          "Skipping wallet: pool creation time is missing",
        );
        continue;
      }

      // Serialized per wallet (see walletMutex.ts) — if this wallet already
      // has a buy in flight from a different token/pipeline, this waits for
      // it to finish and sizes against the balance actually left afterward,
      // rather than racing it off the same stale balance reading.
      const trade = await withWalletLock(walletContext.ownerWallet, () =>
        executeAutoBuyForWallet(io, mint, decimals, walletContext, config),
      );
      if (trade) lastTrade = trade;
    }
    return lastTrade;
  } catch (err: any) {
    LOG.error({ err: err.message ?? err }, "AutoBuyer error");
    return null;
  }
}

/**
 * The wallet-specific half of registerAutoBuyCandidate — sizing, risk
 * check, the 2-tranche buy, test sell, and PnL tracking, all scoped to one
 * wallet's own balance and signed with its own keypair.
 */
async function executeAutoBuyForWallet(
  io: Server,
  mint: string,
  decimals: number,
  walletContext: WalletContext,
  walletConfig: Awaited<ReturnType<typeof getEffectiveConfig>>,
): Promise<TradeRecord | null> {
  const wallet = walletContext.publicKey;
  try {
    // Size the trade as a percentage of the actual wallet balance
    // (AUTO_TRADE_PERCENT_OF_BALANCE, 2% default) rather than a fixed SOL
    // amount. A fixed amount either sits below the risk cap's true
    // minimum-balance requirement (rejected forever until the wallet is
    // funded well past what the trade itself needs) or, on a larger
    // wallet, wastes the chance to size up — this way the bot trades at
    // whatever scale the wallet actually supports.
    const walletBalance = await getBalanceInSol(wallet);
    const riskPct = ENV.AUTO_TRADE_PERCENT_OF_BALANCE;
    const minTradeSol = Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003);
    const buySol = Math.min(
      walletBalance * riskPct,
      walletConfig.maxTradeAmountSol,
    );

    if (buySol < minTradeSol) {
      const neededBalance = minTradeSol / riskPct;
      LOG.info(
        {
          mint,
          wallet: walletContext.ownerWallet,
          walletBalance,
          buySol,
          minTradeSol,
        },
        `⏭️ Skipping trade: wallet balance too low for a meaningful trade size ` +
          `(${walletBalance.toFixed(4)} SOL × ${(riskPct * 100).toFixed(
            0,
          )}% = ${buySol.toFixed(4)} SOL, below the ${minTradeSol} SOL minimum — ` +
          `needs ~${neededBalance.toFixed(2)} SOL total to clear it)`,
      );
      return null;
    }

    const lamports = Math.round(buySol * 1e9);

    // STAGE 6: Risk Management Check

    const riskCheck = await canExecuteTrade(buySol, wallet);
    if (!riskCheck.allowed) {
      LOG.warn(
        { mint, reason: riskCheck.reason },
        `⏭️ Skipping trade: Risk limit exceeded`,
      );
      emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeError", {
        type: "risk_limit",
        mint,
        reason: riskCheck.reason,
        message: riskCheck.reason,
      });
      return null;
    }

    LOG.info(
      { mint, buySol, openPositions: riskCheck.currentRisk.openPositions },
      "✅ Risk check PASSED - Proceeding with buy execution",
    );

    const quote = await getJupiterQuote(SOL_MINT, mint, lamports, 500);
    if (!quote?.outAmount) {
      LOG.info({ mint }, "Not tradable / no Jupiter quote");
      return null;
    }
    const sellQuote = await getJupiterQuote(
      mint,
      SOL_MINT,
      quote.outAmount,
      1000,
    );
    if (!sellQuote?.outAmount) {
      LOG.info({ mint }, "Skipping launch buy: no executable sell route");
      return null;
    }

    // wallet already declared earlier - verify it's set
    if (!wallet) {
      LOG.error("AUTO BUY FAILED → Wallet not configured");
      return null;
    }

    const useReal = process.env.USE_REAL_SWAP === "true";

    // Check wallet balance before attempting trade (skip in simulation mode)
    if (useReal) {
      const hasBalance = await hasSufficientBalance(wallet, buySol);
      if (!hasBalance) {
        LOG.warn(
          {
            wallet,
            requiredSol: buySol,
            mint,
          },
          "Insufficient balance for auto-buy",
        );
        emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeError", {
          type: "insufficient_balance",
          mint,
          required: buySol,
          message: `Insufficient balance for ${buySol} SOL trade`,
        });
        return null;
      }
    } else {
      LOG.info({ mint }, "Simulation mode: bypassing balance check");
    }
    // ✨ RULE 8: 2-TRANCHE BUYING STRATEGY
    LOG.info({ mint, buySol }, "📊 Executing 2-tranche buy (60% + 40%)");

    // TRANCHE 1: Buy 60% of position
    const tranche1Result = await executeFirstTranche(
      mint,
      buySol,
      wallet,
      useReal,
      decimals,
      walletContext.keypair,
    );

    if (!tranche1Result.success) {
      LOG.error(
        { mint, error: tranche1Result.error },
        "First tranche failed - aborting buy",
      );
      emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeError", {
        type: "tranche1_failed",
        mint,
        error: tranche1Result.error,
        message: "First tranche (60%) failed",
      });
      return null;
    }

    const firstTokenQty = tranche1Result.tokenQty || 0;
    const firstPrice = tranche1Result.pricePerToken || 0;

    LOG.info(
      {
        mint,
        tokenQty: firstTokenQty,
        price: firstPrice,
        signature: tranche1Result.signature,
      },
      "✅ First tranche (60%) executed",
    );

    // Record first tranche trade under the OWNER's wallet — the address a
    // dashboard viewer actually recognizes and queries by, not the
    // generated hot-wallet address that signed it (see db.service.ts's
    // viewerWalletFilter()).
    const trade1 = {
      id: crypto.randomUUID(),
      type: "buy" as const,
      token: mint,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: Math.floor(buySol * 0.6 * 1e9), // 60% in lamports
      price: firstPrice,
      pnl: 0,
      wallet: walletContext.ownerWallet,
      simulated: !useReal,
      signature: tranche1Result.signature ?? null,
      timestamp: new Date(),
      custody: "custodial" as const,
    };

    const savedTrade1 = await dbService.addTrade(trade1);
    await dbService.updatePositionMetadata(mint, walletContext.ownerWallet, {
      firstTrancheEntry: Date.now(),
      remainingPct: 100, // Full position after first buy
      tpPct: walletConfig.takeProfitPct,
      slPct: walletConfig.stopLossPct,
    });

    emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeFeed", {
      ...trade1,
      auto: true,
      reason: "tranche1_buy",
      route: "jupiter",
      tranche: "1 of 2 (60%)",
    });

    // TRANCHE 2: Buy remaining 40% immediately for launch-sniper entry
    LOG.info({ mint }, "📊 Executing second tranche (40%)");

    const tranche2Result = await executeSecondTranche(
      mint,
      buySol,
      wallet,
      useReal,
      decimals,
      walletContext.keypair,
    );

    if (!tranche2Result.success) {
      LOG.warn(
        { mint, error: tranche2Result.error },
        "Second tranche failed - continuing with first tranche only",
      );
      // Not a critical failure - we still have 60% position. Unlike
      // jupiterDiscovery.service.ts / storedTokenChecker.service.ts, this
      // pipeline never registered the position for live P&L tracking at all
      // (pnlTracker.service.ts) — wire it here too, using what we actually hold.
      pnlTrackerService.startTracking({
        tokenMint: mint,
        entryPrice: firstPrice,
        amount: firstTokenQty,
        wallet: walletContext.ownerWallet,
        entryTime: Date.now(),
      });
      emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeFeed", {
        ...trade1,
        auto: true,
        reason: "partial_buy",
        tranche: "1 of 2 (60%)",
        secondTrancheFailed: true,
        secondTrancheError: tranche2Result.error,
      });
      return savedTrade1;
    }

    const secondTokenQty = tranche2Result.tokenQty || 0;
    const secondPrice = tranche2Result.pricePerToken || 0;

    LOG.info(
      {
        mint,
        tokenQty: secondTokenQty,
        price: secondPrice,
        signature: tranche2Result.signature,
      },
      "✅ Second tranche (40%) executed",
    );

    // Record second tranche trade — under the OWNER's wallet, same reason
    // as trade1 above.
    const trade2 = {
      id: crypto.randomUUID(),
      type: "buy" as const,
      token: mint,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: Math.floor(buySol * 0.4 * 1e9), // 40% in lamports
      price: secondPrice,
      pnl: 0,
      wallet: walletContext.ownerWallet,
      simulated: !useReal,
      signature: tranche2Result.signature ?? null,
      timestamp: new Date(),
      custody: "custodial" as const,
    };

    const savedTrade2 = await dbService.addTrade(trade2);
    await dbService.updatePositionMetadata(mint, walletContext.ownerWallet, {
      secondTrancheEntry: Date.now(),
    });

    emitToWalletOrGlobal(io, walletContext.ownerWallet, "tradeFeed", {
      ...trade2,
      auto: true,
      reason: "tranche2_buy",
      route: "jupiter",
      tranche: "2 of 2 (40%)",
    });

    // Calculate weighted average entry price
    const totalTokens = firstTokenQty + secondTokenQty;
    const avgPrice =
      (firstTokenQty * firstPrice + secondTokenQty * secondPrice) / totalTokens;

    LOG.info(
      {
        mint,
        totalTokens,
        avgPrice,
        tranche1Price: firstPrice,
        tranche2Price: secondPrice,
      },
      "🎯 2-tranche buy completed successfully",
    );

    pnlTrackerService.startTracking({
      tokenMint: mint,
      entryPrice: avgPrice,
      amount: totalTokens,
      wallet: walletContext.ownerWallet,
      entryTime: Date.now(),
    });

    // Both tranches completed successfully
    return savedTrade2; // Return second tranche trade (with computed amountSol/amountLamports) as final confirmation
  } catch (err: any) {
    LOG.error({ err: err.message ?? err }, "AutoBuyer error");
    return null;
  }
}
