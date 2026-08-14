// backend/src/services/storedTokenChecker.service.ts
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { validateJupiterToken } from "./jupiterTokenValidator.service.js";
import validationPipelineService from "./validationPipeline.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { TokenLifecycleState } from "./db.service.js";

const LOG = getLogger("stored-token-checker");

interface CheckerConfig {
  enabled: boolean;
  checkIntervalMs: number; // How often to check stored tokens (e.g., 60000 = 1 minute)
  maxTokensPerCheck: number; // Limit tokens per check cycle
  minTimeSinceLastCheck: number; // Minimum time before re-checking a token (ms)
  autoBuyEnabled: boolean;
  autoBuyAmountSol: number;
  minLiquiditySol: number;
}

class StoredTokenChecker {
  private config: CheckerConfig;
  private io: SocketIOServer | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private isChecking: boolean = false;
  private lastCheckTimes: Map<string, number> = new Map(); // mint -> timestamp
  // Unlike jupiterDiscovery.service.ts's detectedTokens Set (pruned at 5000)
  // and tokenDiscovery.service.ts's currentMints Set (pruned at 2000), this
  // map grew forever, one entry per distinct mint ever checked.
  private readonly MAX_TRACKED_MINTS = Number(
    process.env.MAX_STORED_TOKEN_CHECK_ENTRIES ?? 5000
  );

  constructor() {
    this.config = {
      enabled: process.env.STORED_TOKEN_CHECKER_ENABLED === "true",
      checkIntervalMs: parseInt(
        process.env.STORED_TOKEN_CHECK_INTERVAL_MS || "300000"
      ), // Default: 5 minutes
      maxTokensPerCheck: parseInt(process.env.MAX_TOKENS_PER_CHECK || "20"),
      minTimeSinceLastCheck: parseInt(
        process.env.MIN_TIME_BETWEEN_TOKEN_CHECKS || "900000"
      ), // Default: 15 minutes
      autoBuyEnabled: process.env.JUPITER_AUTO_BUY === "true",
      autoBuyAmountSol: parseFloat(process.env.JUPITER_AUTO_BUY_SOL || "0.05"),
      // Same default/fallback as jupiterDiscovery.service.ts — must not be
      // confused with autoBuyAmountSol above (how much to buy is a different
      // question from how much pool liquidity is required to consider buying).
      minLiquiditySol: Number(process.env.MIN_JUPITER_LIQUIDITY_SOL || 0.05),
    };

    LOG.info(
      {
        enabled: this.config.enabled,
        checkInterval: `${this.config.checkIntervalMs / 1000}s`,
        maxTokensPerCheck: this.config.maxTokensPerCheck,
        minTimeBetweenChecks: `${this.config.minTimeSinceLastCheck / 1000}s`,
      },
      "🔍 Stored Token Checker initialized"
    );
  }

  setSocketIO(io: SocketIOServer) {
    this.io = io;
    LOG.info("✅ Socket.IO connected to Stored Token Checker");
  }

  start() {
    if (!this.config.enabled) {
      LOG.info("⏸️  Stored token checker is disabled");
      return;
    }

    if (this.intervalId) {
      LOG.warn("Stored token checker already running");
      return;
    }

    LOG.info(
      `🚀 Starting stored token checker (interval: ${
        this.config.checkIntervalMs / 1000
      }s)`
    );

    // Run initial check after 30 seconds
    setTimeout(() => this.checkStoredTokens(), 30000);

    // Set up recurring checks
    this.intervalId = setInterval(
      () => this.checkStoredTokens(),
      this.config.checkIntervalMs
    );
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      LOG.info("🛑 Stored token checker stopped");
    }
  }

  private async checkStoredTokens() {
    if (this.isChecking) {
      LOG.debug("Check already in progress, skipping...");
      return;
    }

    this.isChecking = true;
    const startTime = Date.now();

    try {
      LOG.info("🔍 Checking stored tokens for trading opportunities...");

      // Re-check tokens that were discovered but not yet confirmed tradable
      // (e.g. liquidity was too low at detection time, may have grown since)
      const candidateStates: TokenLifecycleState[] = ["DISCOVERED"];

      const tokens = await this.getTokensToCheck(candidateStates);

      if (tokens.length === 0) {
        LOG.debug("No stored tokens to check");
        this.emitStatus(0, 0);
        return;
      }

      LOG.info(`📊 Found ${tokens.length} stored tokens to evaluate`);
      this.emitStatus(tokens.length, 0);

      let checkedCount = 0;
      let qualifiedCount = 0;

      for (const token of tokens) {
        try {
          const shouldCheck = this.shouldCheckToken(token.mint);
          if (!shouldCheck) {
            LOG.debug(
              { mint: token.mint.substring(0, 8) },
              `Skipping ${token.symbol} - checked recently`
            );
            continue;
          }

          checkedCount++;
          LOG.debug(
            {
              mint: token.mint.substring(0, 8),
              state: token.state,
              poolId: token.poolAddress?.substring(0, 8),
            },
            `Evaluating stored token: ${token.symbol}`
          );

          const qualified = await this.evaluateToken(token);
          if (qualified) {
            qualifiedCount++;
            LOG.info(
              {
                mint: token.mint.substring(0, 8),
                poolId: token.poolAddress?.substring(0, 8),
              },
              `✅ Stored token ${token.symbol} now meets criteria!`
            );
          }

          this.lastCheckTimes.set(token.mint, Date.now());
          if (this.lastCheckTimes.size > this.MAX_TRACKED_MINTS) {
            const oldest = this.lastCheckTimes.keys().next().value;
            if (oldest) this.lastCheckTimes.delete(oldest);
          }
        } catch (error) {
          LOG.error(error, `Error checking token ${token.symbol}`);
        }
      }

      const duration = Date.now() - startTime;
      LOG.info(
        {
          totalFound: tokens.length,
          checked: checkedCount,
          qualified: qualifiedCount,
          durationMs: duration,
        },
        `✅ Stored token check completed`
      );

      this.emitStatus(checkedCount, qualifiedCount);
    } catch (error) {
      LOG.error(error, "Error in stored token check");
    } finally {
      this.isChecking = false;
    }
  }

  private async getTokensToCheck(
    states: TokenLifecycleState[]
  ): Promise<any[]> {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const minTimestamp = new Date(now - maxAge);

    try {
      const tokens = await dbService.getTokensByStates(states, {
        limit: this.config.maxTokensPerCheck,
        minCreatedAt: minTimestamp,
      });

      return tokens;
    } catch (error) {
      LOG.error(error, "Error fetching tokens to check");
      return [];
    }
  }

  private shouldCheckToken(mint: string): boolean {
    const lastCheck = this.lastCheckTimes.get(mint);
    if (!lastCheck) return true;

    const timeSinceLastCheck = Date.now() - lastCheck;
    return timeSinceLastCheck >= this.config.minTimeSinceLastCheck;
  }

  private async evaluateToken(token: any): Promise<boolean> {
    try {
      // Step 1: Re-check Jupiter tradability with current parameters
      LOG.debug(`Validating ${token.symbol || "Unknown"}...`);
      const validation = await validateJupiterToken(token.mint, {
        minLiquiditySol: this.config.minLiquiditySol,
        maxBuyTax: parseInt(process.env.MAX_BUY_TAX_PCT || "5"),
        maxSellTax: parseInt(process.env.MAX_SELL_TAX_PCT || "5"),
        // Same default polarity as jupiterDiscovery.service.ts: required unless
        // explicitly disabled, not opt-in-only-when-explicitly-true. Both callers
        // of validateJupiterToken must agree here or a fresh discovery and a
        // re-evaluated stored token get different safety guarantees for free.
        requireMintDisabled: process.env.REQUIRE_MINT_DISABLED !== "false",
        requireFreezeDisabled: process.env.REQUIRE_FREEZE_DISABLED !== "false",
        requireLpLocked: process.env.REQUIRE_LP_LOCKED === "true",
      });

      if (!validation.approved) {
        LOG.debug(
          {
            reason: validation.reason,
          },
          `Validation failed for ${token.symbol || "Unknown"}`
        );
        return false;
      }

      LOG.info(
        {
          lpSol: validation.details.liquiditySol,
          mint: token.mint.substring(0, 8),
        },
        `✅ ${token.symbol || "Unknown"} passed validation!`
      );

      // Emit to frontend
      this.emitTokenQualified(token, validation);

      // Step 2: If auto-buy is enabled, run through validation pipeline
      if (this.config.autoBuyEnabled) {
        LOG.info(
          `🎯 Starting validation pipeline for stored token ${
            token.symbol || "Unknown"
          }...`
        );

        // Use runPipeline like jupiterDiscovery does
        const pipelineResult = await validationPipelineService.runPipeline(
          token.mint,
          validation.details.liquiditySol
        );

        if (!pipelineResult.success) {
          LOG.debug(
            {
              failedStage: pipelineResult.failedStage,
              reason: pipelineResult.reason,
            },
            `Pipeline failed for ${token.symbol || "Unknown"}`
          );
          return false;
        }

        LOG.info(`✅ ${token.symbol || "Unknown"} passed full pipeline!`);

        // Same as jupiterDiscovery.service.ts's buy path — without this,
        // positions bought through this pipeline never get live P&L tracking
        // (pnlTracker.service.ts only ever heard about the other path's buys).
        if (pipelineResult.executionResult) {
          pnlTrackerService.startTracking({
            tokenMint: token.mint,
            entryPrice: pipelineResult.executionResult.actualPrice || 0,
            amount: pipelineResult.executionResult.tokensReceived || 0,
            wallet: process.env.WALLET_PUBLIC_KEY || "",
            entryTime: Date.now(),
          });
        }

        // Live Feed / Trade History only render off "tradeFeed" — without
        // this, buys executed here never showed up on the dashboard.
        if (this.io) {
          this.io.emit("tradeFeed", {
            type: "buy",
            token: token.mint,
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
        }
      }

      return true;
    } catch (error) {
      LOG.error(error, `Error evaluating token ${token.symbol || "Unknown"}`);
      return false;
    }
  }

  private emitStatus(totalChecked: number, qualified: number) {
    if (!this.io) return;

    this.io.emit("storedTokenChecker:status", {
      timestamp: new Date().toISOString(),
      totalChecked,
      qualified,
      isChecking: this.isChecking,
    });
  }

  private emitTokenQualified(token: any, validation: any) {
    if (!this.io) return;

    const poolId = token.poolAddress;
    this.io.emit("storedTokenChecker:qualified", {
      timestamp: new Date().toISOString(),
      token: {
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown Token",
        poolId: poolId,
      },
      validation: {
        liquiditySol: validation.details.liquiditySol,
        isValid: validation.approved,
      },
    });

    LOG.info(`📡 Emitted qualified token: ${token.symbol || "Unknown"}`);
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      isChecking: this.isChecking,
      checkIntervalMs: this.config.checkIntervalMs,
      maxTokensPerCheck: this.config.maxTokensPerCheck,
      lastCheckTimesCount: this.lastCheckTimes.size,
    };
  }
}

// Singleton instance
const storedTokenChecker = new StoredTokenChecker();
export default storedTokenChecker;
