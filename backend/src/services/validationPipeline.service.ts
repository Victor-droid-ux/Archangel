import { getLogger } from "../utils/logger.js";
import {
  getJupiterQuote,
  executeJupiterSwap,
  getJupiterTokenInfo,
} from "./jupiter.service.js";
import birdeyeService, { BirdeyeMarketHealth } from "./birdeye.service.js";
import {
  hasSufficientBalance,
  getConnection,
  getBalanceInSol,
  loadKeypairFromEnv,
} from "./solana.service.js";
import { PublicKey, Keypair } from "@solana/web3.js";
import dbService from "./db.service.js";
import { canExecuteTrade } from "./riskManagement.service.js";
import { ENV } from "../utils/env.js";

/**
 * Identifies which wallet a pipeline run buys/sells for — the custodial
 * hot wallet belonging to a specific connected user, not always the single
 * admin wallet. ownerWallet is the *connected* (Phantom/Solflare) wallet
 * this hot wallet belongs to, used for risk/settings lookups; publicKey and
 * keypair are the hot wallet that actually holds funds and signs.
 */
export interface WalletContext {
  ownerWallet: string;
  publicKey: string;
  keypair: Keypair;
}

function defaultWalletContext(): WalletContext {
  const keypair = loadKeypairFromEnv();
  const publicKey = keypair.publicKey.toBase58();
  return { ownerWallet: publicKey, publicKey, keypair };
}

const LOG = getLogger("validation-pipeline");
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface ExecutionResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  actualPrice?: number;
  amountSol?: number;
  error?: string;
}

interface ValidationResult {
  passed: boolean;
  stage: number;
  stageName: string;
  reason?: string;
  details?: any;
}

interface PipelineResult {
  success: boolean;
  failedStage?: number;
  failedStageName?: string;
  reason?: string;
  results: ValidationResult[];
  executionResult?: ExecutionResult;
}

interface PoolValidation {
  poolExists: boolean;
  lpSufficient: boolean;
  lpAmount: number;
  poolStable: boolean;
}

interface RoutingTestResult {
  buyRoutePasses: boolean;
  sellRoutePasses: boolean;
  slippageAcceptable: boolean;
  bidirectionalTrading: boolean;
}

class ValidationPipelineService {
  // Same default as jupiterDiscovery.service.ts / storedTokenChecker.service.ts —
  // this used to default to 0.5 here vs 0.05 there, a 10x gap for what should be
  // one agreed-upon "is this pool real" threshold across every caller.
  private readonly MIN_LP_SOL = parseFloat(
    process.env.MIN_JUPITER_LIQUIDITY_SOL || "0.05"
  );
  // Was a bare literal with no override, unlike every sibling threshold in
  // this class. Default kept the same (49%) to avoid silently changing
  // trading behavior — this just makes it tunable.
  private readonly MAX_SLIPPAGE = Number(process.env.MAX_PIPELINE_SLIPPAGE_PCT ?? 49);
  // Floor below which a trade is too small to be worth executing, not a hard
  // trade-size constant — the actual buy amount is computed per-run in
  // runPipeline() as a percentage of live wallet balance (see there for why).
  private readonly MIN_TRADE_SOL = Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003);
  private readonly AUTO_BUY_SLIPPAGE = parseFloat(
    process.env.AUTO_BUY_SLIPPAGE_PCT || "10"
  );
  // Jupiter's quote/swap APIs take slippage in basis points, not percent
  private get AUTO_BUY_SLIPPAGE_BPS(): number {
    return this.AUTO_BUY_SLIPPAGE * 100;
  }

  /**
   * Run the complete 8-stage validation pipeline
   */
  async runPipeline(
    tokenMint: string,
    lpSol: number,
    walletContext: WalletContext = defaultWalletContext()
  ): Promise<PipelineResult> {
    LOG.info(
      { wallet: walletContext.ownerWallet },
      `🚀 Starting 8-stage validation pipeline for ${tokenMint.slice(0, 8)}...`
    );

    const results: ValidationResult[] = [];
    const wallet = walletContext.publicKey;

    // Stage 0: POSITION SIZING + RISK MANAGEMENT CHECK
    // Size the trade as a percentage of live wallet balance (AUTO_TRADE_PERCENT_OF_BALANCE,
    // 2% default) rather than a fixed SOL amount — mirrors autoBuyer.service.ts's identical
    // fix for the same reason: a fixed amount either sits below the risk cap's true
    // minimum-balance requirement (rejected forever on a modest wallet) or, on a larger
    // wallet, wastes the chance to size up. Both auto-buy paths (jupiterDiscovery.service.ts
    // and storedTokenChecker.service.ts) funnel through runPipeline, so this is the single
    // place that guarantees sizing + MAX_OPEN_POSITIONS/MAX_DAILY_LOSS_PCT apply to every
    // real buy this pipeline executes.
    const walletBalance = await getBalanceInSol(wallet);
    const riskPct = ENV.AUTO_TRADE_PERCENT_OF_BALANCE;
    const buySol = walletBalance * riskPct;

    if (buySol < this.MIN_TRADE_SOL) {
      const neededBalance = this.MIN_TRADE_SOL / riskPct;
      const reason =
        `Wallet balance too low for a meaningful trade size ` +
        `(${walletBalance.toFixed(4)} SOL × ${(riskPct * 100).toFixed(0)}% = ` +
        `${buySol.toFixed(4)} SOL, below the ${this.MIN_TRADE_SOL} SOL minimum — ` +
        `needs ~${neededBalance.toFixed(2)} SOL total to clear it)`;
      const stage0: ValidationResult = {
        passed: false,
        stage: 0,
        stageName: "Position Sizing",
        reason,
        details: { walletBalance, riskPct, buySol },
      };
      results.push(stage0);
      await this.logFailure(tokenMint, 0, "Position Sizing", reason);
      return this.buildFailureResult(0, "Position Sizing", reason, results);
    }

    const riskCheck = await canExecuteTrade(buySol, wallet);
    if (!riskCheck.allowed) {
      const stage0: ValidationResult = {
        passed: false,
        stage: 0,
        stageName: "Risk Management",
        reason: riskCheck.reason || "Risk limit exceeded",
        details: riskCheck.currentRisk,
      };
      results.push(stage0);
      await this.logFailure(
        tokenMint,
        0,
        "Risk Management",
        stage0.reason || "Unknown"
      );
      return this.buildFailureResult(0, "Risk Management", stage0.reason, results);
    }

    // Stage 1: JUPITER DISCOVERY
    const stage1 = await this.stage1_jupiterDiscovery(tokenMint, lpSol);
    results.push(stage1);
    if (!stage1.passed) {
      await this.logFailure(
        tokenMint,
        1,
        "Jupiter Discovery",
        stage1.reason || "Unknown"
      );
      return this.buildFailureResult(
        1,
        "Jupiter Discovery",
        stage1.reason,
        results
      );
    }

    // Stage 2: JUPITER ROUTING TEST
    const stage2 = await this.stage2_jupiterRoutingTest(tokenMint);
    results.push(stage2);
    if (!stage2.passed) {
      await this.logFailure(
        tokenMint,
        2,
        "Jupiter Routing Test",
        stage2.reason || "Unknown"
      );
      return this.buildFailureResult(
        2,
        "Jupiter Routing Test",
        stage2.reason,
        results
      );
    }

    // Stage 3: BIRDEYE HONEYPOT CHECK
    const stage3 = await this.stage3_authorityCheck(tokenMint);
    results.push(stage3);
    if (!stage3.passed) {
      await this.logFailure(
        tokenMint,
        3,
        "Authority Check",
        stage3.reason || "Unknown"
      );
      return this.buildFailureResult(
        3,
        "Authority Check",
        stage3.reason,
        results
      );
    }

    // Stage 4: BIRDEYE MARKET HEALTH CHECK
    const stage4 = await this.stage4_birdeyeMarketHealth(tokenMint, buySol);
    results.push(stage4);
    if (!stage4.passed) {
      await this.logFailure(
        tokenMint,
        4,
        "Birdeye Market Health",
        stage4.reason || "Unknown"
      );
      return this.buildFailureResult(
        4,
        "Birdeye Market Health",
        stage4.reason,
        results
      );
    }

    // Stage 5: JUPITER PRE-EXECUTION CHECK
    const stage5 = await this.stage5_jupiterPreExecution(
      tokenMint,
      buySol,
      wallet
    );
    results.push(stage5);
    if (!stage5.passed) {
      await this.logFailure(
        tokenMint,
        5,
        "Jupiter Pre-Execution",
        stage5.reason || "Unknown"
      );
      return this.buildFailureResult(
        5,
        "Jupiter Pre-Execution",
        stage5.reason,
        results
      );
    }

    // Stage 6: JUPITER EXECUTION (BUY)
    const stage6 = await this.stage6_jupiterBuy(tokenMint, buySol, walletContext);
    results.push(stage6);
    if (!stage6.passed) {
      await this.logFailure(
        tokenMint,
        6,
        "Jupiter Buy Execution",
        stage6.reason || "Unknown"
      );
      return this.buildFailureResult(
        6,
        "Jupiter Buy Execution",
        stage6.reason,
        results
      );
    }

    LOG.info(`✅ All 6 execution stages PASSED for ${tokenMint.slice(0, 8)}`);

    return {
      success: true,
      results,
      executionResult: stage6.details?.executionResult,
    };
  }

  /**
   * STAGE 1: JUPITER DISCOVERY
   * Only detect tokens that truly exist AND have actual LP
   */
  private async stage1_jupiterDiscovery(
    tokenMint: string,
    lpSol: number
  ): Promise<ValidationResult> {
    LOG.info(`[Stage 1] 🔍 Jupiter Discovery for ${tokenMint.slice(0, 8)}...`);

    try {
      // Pool existence is already confirmed by pool listener
      // Just validate LP amount here

      // Check LP amount
      if (lpSol < this.MIN_LP_SOL) {
        return {
          passed: false,
          stage: 1,
          stageName: "Jupiter Discovery",
          reason: `Insufficient LP: ${lpSol} SOL < ${this.MIN_LP_SOL} SOL`,
        };
      }

      // Check if it's a fake placeholder pool (LP = 0)
      if (lpSol === 0) {
        return {
          passed: false,
          stage: 1,
          stageName: "Jupiter Discovery",
          reason: "Pool LP is exactly 0 (fake pool)",
        };
      }

      LOG.info(`[Stage 1] ✅ Jupiter Discovery PASSED (LP: ${lpSol} SOL)`);
      return {
        passed: true,
        stage: 1,
        stageName: "Jupiter Discovery",
        details: { lpSol },
      };
    } catch (error: any) {
      LOG.error(`[Stage 1] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 1,
        stageName: "Jupiter Discovery",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 2: JUPITER ROUTING TEST
   * Make sure Jupiter can actually perform swaps
   */
  private async stage2_jupiterRoutingTest(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 2] 🔍 Jupiter Routing Test for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const testAmount = 10000000; // 0.01 SOL for testing

      // Test BUY route
      const buyQuote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        testAmount,
        this.AUTO_BUY_SLIPPAGE_BPS
      );

      if (!buyQuote || !buyQuote.outAmount) {
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Routing Test",
          reason: "Buy route not available",
        };
      }

      // Test SELL route (simulate selling the tokens we would buy)
      const sellQuote = await getJupiterQuote(
        tokenMint,
        SOL_MINT,
        Number(buyQuote.outAmount),
        this.AUTO_BUY_SLIPPAGE_BPS
      );

      if (!sellQuote || !sellQuote.outAmount) {
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Routing Test",
          reason: "Sell route not available (potential honeypot)",
        };
      }

      // Check if price impact is acceptable — use Jupiter's own priceImpactPct,
      // which is computed correctly against real reserves/decimals. (The previous
      // version diffed raw SOL lamports against raw token base units directly,
      // two incommensurable quantities, which produced meaningless multi-million
      // percent "slippage" values and made this stage fail almost every time.)
      const buySlippage = buyQuote.priceImpactPct ?? 0;
      const sellSlippage = sellQuote.priceImpactPct ?? 0;

      if (buySlippage > this.MAX_SLIPPAGE || sellSlippage > this.MAX_SLIPPAGE) {
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Routing Test",
          reason: `Slippage too high (buy: ${buySlippage}%, sell: ${sellSlippage}%)`,
        };
      }

      LOG.info(
        `[Stage 2] ✅ Jupiter Routing Test PASSED (bidirectional trading works)`
      );
      return {
        passed: true,
        stage: 2,
        stageName: "Jupiter Routing Test",
        details: { buyQuote, sellQuote, buySlippage, sellSlippage },
      };
    } catch (error: any) {
      LOG.error(`[Stage 2] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 2,
        stageName: "Jupiter Routing Test",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 3: AUTHORITY / HONEYPOT CHECK
   * Uses Jupiter's /tokens/v2 audit data (already fetched for free at discovery
   * time) rather than Birdeye's token_security endpoint — that endpoint returns
   * "API key lacks sufficient permissions" on the current plan, and the actual
   * ability to sell is already exercised structurally by Stage 2's bidirectional
   * routing test (a real honeypot can't produce a sell quote at all).
   */
  private async stage3_authorityCheck(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 3] 🔍 Authority Check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const info = await getJupiterTokenInfo(tokenMint);

      if (!info) {
        return {
          passed: false,
          stage: 3,
          stageName: "Authority Check",
          reason: "Token metadata unavailable from Jupiter",
        };
      }

      const reasons: string[] = [];
      if (!info.mintAuthorityDisabled) {
        reasons.push("Mint authority still active");
      }
      if (!info.freezeAuthorityDisabled) {
        reasons.push("Freeze authority still active");
      }

      if (reasons.length > 0) {
        return {
          passed: false,
          stage: 3,
          stageName: "Authority Check",
          reason: reasons.join(", "),
          details: info,
        };
      }

      LOG.info(`[Stage 3] ✅ Authority Check PASSED`);
      return {
        passed: true,
        stage: 3,
        stageName: "Authority Check",
        details: info,
      };
    } catch (error: any) {
      LOG.error(`[Stage 3] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 3,
        stageName: "Authority Check",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 4: BIRDEYE MARKET HEALTH CHECK
   * Ensure token is tradeable and worth entering
   */
  private async stage4_birdeyeMarketHealth(
    tokenMint: string,
    buySol: number
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 4] 🔍 Birdeye Market Health for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const healthResult = await birdeyeService.checkMarketHealth(
        tokenMint,
        buySol
      );

      if (!healthResult.isHealthy) {
        return {
          passed: false,
          stage: 4,
          stageName: "Birdeye Market Health",
          reason: healthResult.reasons.join(", "),
          details: healthResult,
        };
      }

      LOG.info(`[Stage 4] ✅ Birdeye Market Health PASSED`);
      return {
        passed: true,
        stage: 4,
        stageName: "Birdeye Market Health",
        details: healthResult,
      };
    } catch (error: any) {
      LOG.error(`[Stage 4] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 4,
        stageName: "Birdeye Market Health",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 5: JUPITER PRE-EXECUTION CHECK
   * Get a fresh quote and confirm the wallet can actually afford the trade
   * right before committing capital.
   */
  private async stage5_jupiterPreExecution(
    tokenMint: string,
    buySol: number,
    wallet: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 5] 🔍 Jupiter Pre-Execution Check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        this.AUTO_BUY_SLIPPAGE_BPS
      );

      if (!quote || !quote.outAmount) {
        return {
          passed: false,
          stage: 5,
          stageName: "Jupiter Pre-Execution",
          reason: "No Jupiter route/output available for buy amount",
        };
      }

      if (quote.priceImpactPct && quote.priceImpactPct > this.MAX_SLIPPAGE) {
        return {
          passed: false,
          stage: 5,
          stageName: "Jupiter Pre-Execution",
          reason: `Price impact too high: ${quote.priceImpactPct.toFixed(2)}%`,
          details: quote,
        };
      }

      if (process.env.USE_REAL_SWAP === "true") {
        const hasBalance = await hasSufficientBalance(wallet, buySol);
        if (!hasBalance) {
          return {
            passed: false,
            stage: 5,
            stageName: "Jupiter Pre-Execution",
            reason: "Insufficient wallet balance for buy amount",
          };
        }
      }

      LOG.info(`[Stage 5] ✅ Jupiter Pre-Execution Check PASSED`);
      return {
        passed: true,
        stage: 5,
        stageName: "Jupiter Pre-Execution",
        details: quote,
      };
    } catch (error: any) {
      LOG.error(`[Stage 5] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 5,
        stageName: "Jupiter Pre-Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 6: JUPITER EXECUTION (BUY)
   */
  private async stage6_jupiterBuy(
    tokenMint: string,
    buySol: number,
    walletContext: WalletContext
  ): Promise<ValidationResult> {
    const wallet = walletContext.publicKey;
    LOG.info(
      `[Stage 6] 🚀 Jupiter Buy Execution for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        this.AUTO_BUY_SLIPPAGE_BPS
      );

      if (!quote || !quote.outAmount) {
        return {
          passed: false,
          stage: 6,
          stageName: "Jupiter Buy Execution",
          reason: "No Jupiter route/output available at execution time",
        };
      }

      const useReal = process.env.USE_REAL_SWAP === "true";
      const swapResult = useReal
        ? await executeJupiterSwap({
            inputMint: SOL_MINT,
            outputMint: tokenMint,
            amount: lamports,
            userPublicKey: wallet,
            slippageBps: this.AUTO_BUY_SLIPPAGE_BPS,
            signer: walletContext.keypair,
          })
        : {
            success: true as const,
            signature: `sim-${Date.now()}`,
            simulated: true,
          };

      if (!swapResult.success) {
        return {
          passed: false,
          stage: 6,
          stageName: "Jupiter Buy Execution",
          reason: (swapResult as any).error || "Execution failed",
          details: swapResult,
        };
      }

      // outAmount is in the output token's base units — fetch its real decimals
      // rather than assuming 9 (many SPL tokens, e.g. BONK, use fewer)
      // Decimals feed directly into tokensReceived/actualPrice, which become
      // this position's recorded cost basis — a silent wrong guess here
      // corrupts every downstream PnL/TP/SL decision by the same factor.
      // Prefer Jupiter's own token info (already fetched during discovery,
      // no extra RPC round trip, same source already trusted pre-buy) before
      // falling back to an on-chain lookup, and log loudly rather than
      // silently trusting a last-resort guess if both fail.
      let decimals: number | null = null;
      const jupInfo = await getJupiterTokenInfo(tokenMint);
      if (typeof jupInfo?.decimals === "number" && Number.isFinite(jupInfo.decimals)) {
        decimals = jupInfo.decimals;
      } else {
        try {
          const info = await getConnection().getParsedAccountInfo(new PublicKey(tokenMint));
          const d = (info.value?.data as any)?.parsed?.info?.decimals;
          if (typeof d === "number" && Number.isFinite(d)) decimals = d;
        } catch {
          // handled below
        }
      }
      if (decimals === null) {
        LOG.error(
          { tokenMint },
          "Could not determine real token decimals — recording cost basis with an assumed value of 9, verify this trade manually"
        );
        decimals = 9;
      }
      const tokensReceived = Number(quote.outAmount) / 10 ** decimals;
      const actualPrice = tokensReceived > 0 ? buySol / tokensReceived : 0;

      const executionResult: ExecutionResult = {
        success: true,
        signature: swapResult.signature ?? "",
        tokensReceived,
        actualPrice,
        amountSol: buySol,
      };

      // Store trade in database under the OWNER's wallet (the address a
      // dashboard viewer actually recognizes and queries by), not the
      // generated hot-wallet address that signed it — see db.service.ts's
      // viewerWalletFilter(), which matches trades on this field.
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        price: actualPrice,
        pnl: 0,
        wallet: walletContext.ownerWallet,
        simulated: !useReal,
        signature: swapResult.signature || "",
        route: "jupiter",
        custody: "custodial",
      });

      LOG.info(
        `[Stage 6] ✅ Jupiter Buy Execution PASSED (${swapResult.signature})`
      );
      return {
        passed: true,
        stage: 6,
        stageName: "Jupiter Buy Execution",
        details: { executionResult },
      };
    } catch (error: any) {
      LOG.error(`[Stage 6] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 6,
        stageName: "Jupiter Buy Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  // Helper methods
  private buildFailureResult(
    stage: number,
    stageName: string,
    reason: string | undefined,
    results: ValidationResult[]
  ): PipelineResult {
    return {
      success: false,
      failedStage: stage,
      failedStageName: stageName,
      reason: reason || "Unknown error",
      results,
    };
  }

  private async logFailure(
    tokenMint: string,
    stage: number,
    stageName: string,
    reason: string
  ): Promise<void> {
    try {
      // TODO: Store in database for analysis
      LOG.warn(
        `❌ Token ${tokenMint.slice(
          0,
          8
        )} FAILED at Stage ${stage} (${stageName}): ${reason}`
      );
    } catch (error: any) {
      LOG.error(`Error logging failure: ${error.message}`);
    }
  }
}

export default new ValidationPipelineService();
export { ValidationResult, PipelineResult };
