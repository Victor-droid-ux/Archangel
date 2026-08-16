// backend/src/services/jupiterDiscovery.service.ts
// Replaces raydiumPoolListener.service.ts. That version subscribed to Raydium's
// on-chain program logs for new pool creation; this one polls Jupiter's own
// "recent tokens" feed instead, since Jupiter is now the sole discovery + execution
// venue. Feeds the same 8-stage validationPipeline used before (now Jupiter-based).
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";
import jupiterService, {
  JupiterRecentToken,
  getSolPriceUsd,
} from "./jupiter.service.js";
import { validateJupiterToken } from "./jupiterTokenValidator.service.js";
import dbService from "./db.service.js";
import multiUserExecutionService from "./multiUserExecution.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";

const LOG = getLogger("jupiter-discovery");

interface DiscoveryConfig {
  minLiquiditySol: number;
  maxBuyTax: number;
  maxSellTax: number;
  requireMintDisabled: boolean;
  requireFreezeDisabled: boolean;
  requireLpLocked: boolean;
  autoBuyEnabled: boolean;
  autoBuyAmountSol: number;
  pollIntervalMs: number;
}

class JupiterDiscoveryService {
  private config: DiscoveryConfig;
  private detectedTokens: Set<string> = new Set();
  private isWatching = false;
  private io: SocketIOServer | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private activeValidations = 0;
  private readonly CONCURRENT_VALIDATIONS = 3;

  constructor() {
    this.config = {
      minLiquiditySol: Number(process.env.MIN_JUPITER_LIQUIDITY_SOL || 0.05),
      maxBuyTax: Number(process.env.MAX_BUY_TAX_PCT || 5),
      maxSellTax: Number(process.env.MAX_SELL_TAX_PCT || 5),
      requireMintDisabled: process.env.REQUIRE_MINT_DISABLED !== "false",
      requireFreezeDisabled: process.env.REQUIRE_FREEZE_DISABLED !== "false",
      requireLpLocked: process.env.REQUIRE_LP_LOCKED === "true",
      autoBuyEnabled: process.env.JUPITER_AUTO_BUY === "true",
      autoBuyAmountSol: Number(process.env.JUPITER_AUTO_BUY_SOL || 0.1),
      pollIntervalMs: Number(process.env.JUPITER_DISCOVERY_POLL_MS || 15000),
    };

    LOG.info(
      { minLiquiditySol: this.config.minLiquiditySol, autoBuy: this.config.autoBuyEnabled },
      "Jupiter discovery service initialized"
    );
  }

  setSocketIO(io: SocketIOServer) {
    this.io = io;
    LOG.info("Socket.IO connected to Jupiter discovery service");
  }

  async startWatching() {
    if (this.isWatching) {
      LOG.warn("Jupiter discovery already running");
      return;
    }
    this.isWatching = true;
    LOG.info("🎧 Starting Jupiter token discovery (polling recent-tokens feed)...");

    const tick = () => this.poll().catch((err) => LOG.error({ err: err.message }, "Poll tick error"));
    tick();
    this.intervalHandle = setInterval(tick, this.config.pollIntervalMs);
  }

  stopWatching() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    this.isWatching = false;
    LOG.info("Jupiter discovery stopped");
  }

  private async poll() {
    const tokens = await jupiterService.getRecentTokens(100);
    const fresh = tokens.filter((t) => t.mint && !this.detectedTokens.has(t.mint));

    for (const token of fresh) {
      this.detectedTokens.add(token.mint);
      if (this.activeValidations >= this.CONCURRENT_VALIDATIONS) {
        // Backpressure: skip this tick, it'll be picked up again if still "recent" next poll
        continue;
      }
      this.activeValidations++;
      this.processToken(token)
        .catch((err) => LOG.error({ err: err.message, mint: token.mint }, "Token processing error"))
        .finally(() => this.activeValidations--);
    }

    if (this.detectedTokens.size > 5000) {
      const keep = Array.from(this.detectedTokens).slice(-2500);
      this.detectedTokens = new Set(keep);
    }
  }

  private async processToken(token: JupiterRecentToken) {
    const existingToken = await dbService.getTokenState(token.mint);
    if (existingToken) {
      LOG.debug({ mint: token.mint.slice(0, 8), state: existingToken.state }, "Already processed");
      return;
    }

    await dbService.upsertTokenState({
      mint: token.mint,
      symbol: token.symbol || "UNKNOWN",
      name: token.name || "Unknown Token",
      state: "DISCOVERED",
      source: "jupiter",
      liquiditySOL: 0,
      liquidityUSD: token.liquidity,
      poolAddress: token.firstPoolId || "",
      ...(token.devAddress ? { creatorAddress: token.devAddress } : {}),
      detectedAt: new Date(),
    });

    const solPriceUsd = await getSolPriceUsd();
    if (token.liquidity < this.config.minLiquiditySol * solPriceUsd) {
      // rough USD floor before spending a full validation pass; validateJupiterToken
      // does the precise SOL-denominated check. Uses a live SOL price rather
      // than a hardcoded $150 — that was inconsistent with the rest of the
      // codebase and would silently skip/admit the wrong tokens whenever
      // real SOL price drifts from $150.
      LOG.debug({ mint: token.mint.slice(0, 8), liquidity: token.liquidity }, "Below liquidity floor, skipping for now");
      if (this.io) {
        this.io.emit("jupiter:token_skipped", {
          mint: token.mint,
          reason: "Low liquidity",
          liquidityUSD: token.liquidity,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (this.io) {
      this.io.emit("jupiter:token_detected", {
        mint: token.mint,
        symbol: token.symbol,
        liquidityUSD: token.liquidity,
        timestamp: new Date().toISOString(),
      });
    }

    const validation = await validateJupiterToken(token.mint, {
      minLiquiditySol: this.config.minLiquiditySol,
      maxBuyTax: this.config.maxBuyTax,
      maxSellTax: this.config.maxSellTax,
      requireMintDisabled: this.config.requireMintDisabled,
      requireFreezeDisabled: this.config.requireFreezeDisabled,
      requireLpLocked: this.config.requireLpLocked,
    });

    await dbService.upsertTokenState({
      mint: token.mint,
      symbol: token.symbol || "UNKNOWN",
      name: token.name || "Unknown Token",
      state: validation.approved ? "TRADABLE" : "DISCOVERED",
      source: "jupiter",
      jupiterTradable: validation.approved,
      liquiditySOL: validation.details.liquiditySol,
      liquidityUSD: token.liquidity,
      poolAddress: token.firstPoolId || "",
      ...(token.devAddress ? { creatorAddress: token.devAddress } : {}),
      detectedAt: new Date(),
      ...(validation.approved ? { confirmedTradableAt: new Date() } : {}),
    });

    if (!validation.approved) {
      LOG.warn(
        { mint: token.mint.slice(0, 8), filters: validation.failedFilters },
        `⚠️ Token failed validation: ${validation.reason}`
      );
      if (this.io) {
        this.io.emit("jupiter:validation_failed", {
          mint: token.mint,
          reason: validation.reason,
          failedFilters: validation.failedFilters,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    LOG.info(
      { mint: token.mint.slice(0, 8), filters: validation.passedFilters },
      `✅ Token passed all safety checks (eligible for auto-buy): ${token.symbol}`
    );
    if (this.io) {
      this.io.emit("jupiter:validation_passed", {
        mint: token.mint,
        passedFilters: validation.passedFilters,
        timestamp: new Date().toISOString(),
      });
    }

    if (!this.config.autoBuyEnabled) return;

    LOG.info(`🚀 Starting validation pipeline for auto-buy: ${token.symbol}...`);
    // Fans out across the operator wallet plus every eligible funded,
    // auto-trade-enabled user wallet — each independently risk-checked and
    // executed with its own capital. See multiUserExecution.service.ts.
    // NOTE: socket events below still broadcast globally rather than to a
    // per-wallet room — that's the next phase of this work, not yet done,
    // so for now every connected dashboard sees every wallet's auto-buy
    // activity for this event type (trade history/positions reads are
    // already wallet-scoped; this is a live-feed-only gap).
    const fanOutResults = await multiUserExecutionService.runPipelineForAllEligibleWallets(
      token.mint,
      validation.details.liquiditySol
    );

    for (const { ownerWallet, result: pipelineResult } of fanOutResults) {
      if (!pipelineResult.success) {
        LOG.error(
          {
            mint: token.mint.slice(0, 8),
            wallet: ownerWallet,
            failedStage: pipelineResult.failedStage,
            stageName: pipelineResult.failedStageName,
            reason: pipelineResult.reason,
          },
          `❌ Pipeline failed at Stage ${pipelineResult.failedStage}: ${pipelineResult.failedStageName}`
        );
        emitToWalletOrGlobal(this.io, ownerWallet, "jupiter:pipeline_failed", {
          mint: token.mint,
          wallet: ownerWallet,
          failedStage: pipelineResult.failedStage,
          failedStageName: pipelineResult.failedStageName,
          reason: pipelineResult.reason,
          results: pipelineResult.results,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      LOG.info(
        {
          mint: token.mint.slice(0, 8),
          wallet: ownerWallet,
          signature: pipelineResult.executionResult?.signature,
        },
        `✅ Pipeline completed successfully! Buy executed via Jupiter.`
      );

      if (pipelineResult.executionResult) {
        pnlTrackerService.startTracking({
          tokenMint: token.mint,
          entryPrice: pipelineResult.executionResult.actualPrice || 0,
          amount: pipelineResult.executionResult.tokensReceived || 0,
          wallet: ownerWallet,
          entryTime: Date.now(),
        });
      }

      // Live Feed / Trade History on the dashboard only render off "tradeFeed"
      // — without this, buys executed through this pipeline (the dominant
      // auto-buy path) never appeared there even though they're real trades.
      emitToWalletOrGlobal(this.io, ownerWallet, "tradeFeed", {
        type: "buy",
        token: token.mint,
        wallet: ownerWallet,
        amount: Math.round(
          (pipelineResult.executionResult?.amountSol ?? 0) * 1e9
        ),
        price: pipelineResult.executionResult?.actualPrice,
        pnl: 0,
        signature: pipelineResult.executionResult?.signature,
        timestamp: new Date().toISOString(),
        auto: true,
        reason: "jupiter_pipeline_buy",
        route: "jupiter",
      });

      emitToWalletOrGlobal(this.io, ownerWallet, "jupiter:pipeline_success", {
        mint: token.mint,
        wallet: ownerWallet,
        signature: pipelineResult.executionResult?.signature,
        tokensReceived: pipelineResult.executionResult?.tokensReceived,
        actualPrice: pipelineResult.executionResult?.actualPrice,
        results: pipelineResult.results,
        timestamp: new Date().toISOString(),
      });
    }
  }

  getStatus() {
    return {
      isWatching: this.isWatching,
      detectedTokensCount: this.detectedTokens.size,
      config: this.config,
    };
  }

  updateConfig(updates: Partial<DiscoveryConfig>) {
    this.config = { ...this.config, ...updates };
    LOG.info(updates, "Jupiter discovery config updated");
  }
}

export const jupiterDiscovery = new JupiterDiscoveryService();
