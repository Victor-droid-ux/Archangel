import { getLogger } from "../utils/logger.js";
import { getJupiterQuote, executeJupiterSwap } from "./jupiter.service.js";
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
import { getEffectiveConfig } from "./traderConfig.service.js";

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

class ValidationPipelineService {
  // Was a bare literal with no override, unlike every sibling threshold in
  // this class. Default kept the same (49%) to avoid silently changing
  // trading behavior — this just makes it tunable.
  private readonly MAX_SLIPPAGE = Number(
    process.env.MAX_PIPELINE_SLIPPAGE_PCT ?? 49,
  );
  // Floor below which a trade is too small to be worth executing, not a hard
  // trade-size constant — the actual buy amount is computed per-run in
  // runPipeline() as a percentage of live wallet balance (see there for why).
  private readonly MIN_TRADE_SOL = Number(
    process.env.MIN_AUTO_TRADE_SOL ?? 0.003,
  );
  private readonly AUTO_BUY_SLIPPAGE = parseFloat(
    process.env.AUTO_BUY_SLIPPAGE_PCT || "10",
  );
  // Jupiter's quote/swap APIs take slippage in basis points, not percent
  private get AUTO_BUY_SLIPPAGE_BPS(): number {
    return this.AUTO_BUY_SLIPPAGE * 100;
  }

  /**
   * Per-wallet execution leg of the single linear discovery→validate→buy
   * pipeline (see candidatePipeline.service.ts for the full sequence).
   *
   * Token-intrinsic checks — is it tradeable on Jupiter (Phase 3), and does
   * it pass ArchAngel's filters: tax, mint/freeze authority, LP lock, holder
   * concentration, liquidity/volume/price health (Phase 4) — already ran
   * exactly ONCE for this mint, globally, before any wallet gets here. This
   * function no longer re-derives any of that; re-checking it per wallet was
   * the exact duplicated work called out in the pre-refactor pipeline audit.
   *
   * What genuinely differs per wallet is handled here: position sizing
   * against that wallet's live balance and risk limits (Stage 0), a final
   * quote sized to that wallet's own buy amount (Stage 1 — Phase 5, done
   * per-wallet because the buy amount is per-wallet), and the actual buy
   * (Stage 2 — Phase 6).
   */
  async runPipeline(
    tokenMint: string,
    lpSol: number,
    walletContext: WalletContext = defaultWalletContext(),
  ): Promise<PipelineResult> {
    LOG.info(
      { wallet: walletContext.ownerWallet },
      `🚀 Starting per-wallet execution for ${tokenMint.slice(0, 8)}...`,
    );

    const results: ValidationResult[] = [];
    const wallet = walletContext.publicKey;

    // Stage 0: POSITION SIZING + RISK MANAGEMENT CHECK
    // Size the trade as a percentage of live wallet balance (AUTO_TRADE_PERCENT_OF_BALANCE,
    // 2% default) rather than a fixed SOL amount — a fixed amount either sits below the
    // risk cap's true minimum-balance requirement (rejected forever on a modest wallet) or,
    // on a larger wallet, wastes the chance to size up. Every eligible wallet's buy for a
    // candidate mint funnels through this one runPipeline(), so this is the single place
    // that guarantees sizing + MAX_OPEN_POSITIONS/MAX_DAILY_LOSS_PCT apply to every real
    // buy the pipeline executes.
    const walletBalance = await getBalanceInSol(wallet);
    const riskPct = ENV.AUTO_TRADE_PERCENT_OF_BALANCE;
    const config = await getEffectiveConfig(
      walletContext.ownerWallet,
      tokenMint,
    );
    const buySol = Math.min(walletBalance * riskPct, config.maxTradeAmountSol);

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
        stage0.reason || "Unknown",
      );
      return this.buildFailureResult(
        0,
        "Risk Management",
        stage0.reason,
        results,
      );
    }

    // Stage 1 (Phase 5 — Jupiter quote): fresh, per-wallet-sized quote +
    // affordability check right before committing capital.
    const stage1 = await this.stage1_preExecutionCheck(
      tokenMint,
      buySol,
      wallet,
    );
    results.push(stage1);
    if (!stage1.passed) {
      await this.logFailure(
        tokenMint,
        1,
        "Jupiter Pre-Execution",
        stage1.reason || "Unknown",
      );
      return this.buildFailureResult(
        1,
        "Jupiter Pre-Execution",
        stage1.reason,
        results,
      );
    }

    // Stage 2 (Phase 6 — Trading): execute the swap.
    const stage2 = await this.stage2_buyExecution(
      tokenMint,
      buySol,
      walletContext,
    );
    results.push(stage2);
    if (!stage2.passed) {
      await this.logFailure(
        tokenMint,
        2,
        "Jupiter Buy Execution",
        stage2.reason || "Unknown",
      );
      return this.buildFailureResult(
        2,
        "Jupiter Buy Execution",
        stage2.reason,
        results,
      );
    }

    LOG.info(`✅ Execution PASSED for ${tokenMint.slice(0, 8)}`);

    return {
      success: true,
      results,
      executionResult: stage2.details?.executionResult,
    };
  }

  /**
   * STAGE 1 (Phase 5 — Jupiter quote): get a fresh quote sized to this
   * wallet's own buy amount and confirm it can actually afford the trade
   * right before committing capital. Kept per-wallet rather than folded into
   * the one-time global Phase 3/4 checks because the buy amount — and so the
   * quote itself — is different for every wallet.
   */
  private async stage1_preExecutionCheck(
    tokenMint: string,
    buySol: number,
    wallet: string,
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 1] 🔍 Jupiter Pre-Execution Check for ${tokenMint.slice(0, 8)}...`,
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        this.AUTO_BUY_SLIPPAGE_BPS,
      );

      if (!quote || !quote.outAmount) {
        return {
          passed: false,
          stage: 1,
          stageName: "Jupiter Pre-Execution",
          reason: "No Jupiter route/output available for buy amount",
        };
      }

      if (quote.priceImpactPct && quote.priceImpactPct > this.MAX_SLIPPAGE) {
        return {
          passed: false,
          stage: 1,
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
            stage: 1,
            stageName: "Jupiter Pre-Execution",
            reason: "Insufficient wallet balance for buy amount",
          };
        }
      }

      LOG.info(`[Stage 1] ✅ Jupiter Pre-Execution Check PASSED`);
      return {
        passed: true,
        stage: 1,
        stageName: "Jupiter Pre-Execution",
        details: quote,
      };
    } catch (error: any) {
      LOG.error(`[Stage 1] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 1,
        stageName: "Jupiter Pre-Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 6: JUPITER EXECUTION (BUY)
   */
  private async stage2_buyExecution(
    tokenMint: string,
    buySol: number,
    walletContext: WalletContext,
  ): Promise<ValidationResult> {
    const wallet = walletContext.publicKey;
    LOG.info(
      `[Stage 2] 🚀 Jupiter Buy Execution for ${tokenMint.slice(0, 8)}...`,
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        this.AUTO_BUY_SLIPPAGE_BPS,
      );

      if (!quote || !quote.outAmount) {
        return {
          passed: false,
          stage: 2,
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
          stage: 2,
          stageName: "Jupiter Buy Execution",
          reason: (swapResult as any).error || "Execution failed",
          details: swapResult,
        };
      }

      // outAmount is in the output token's base units — fetch its real decimals
      // rather than assuming 9 (many SPL tokens, e.g. BONK, use fewer).
      // Decimals feed directly into tokensReceived/actualPrice, which become
      // this position's recorded cost basis — a silent wrong guess here
      // corrupts every downstream PnL/TP/SL decision by the same factor.
      // Sourced on-chain, straight from the mint account — Jupiter's role in
      // this pipeline is strictly trading (routing checks, quotes, and this
      // very swap execution), not fetching token metadata, so this
      // deliberately never calls Jupiter's catalog lookup. Log loudly rather
      // than silently trusting a last-resort guess if the RPC lookup fails.
      let decimals: number | null = null;
      try {
        const info = await getConnection().getParsedAccountInfo(
          new PublicKey(tokenMint),
        );
        const d = (info.value?.data as any)?.parsed?.info?.decimals;
        if (typeof d === "number" && Number.isFinite(d)) decimals = d;
      } catch {
        // handled below
      }
      if (decimals === null) {
        LOG.error(
          { tokenMint },
          "Could not determine real token decimals — recording cost basis with an assumed value of 9, verify this trade manually",
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
        `[Stage 2] ✅ Jupiter Buy Execution PASSED (${swapResult.signature})`,
      );
      return {
        passed: true,
        stage: 2,
        stageName: "Jupiter Buy Execution",
        details: { executionResult },
      };
    } catch (error: any) {
      LOG.error(`[Stage 2] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 2,
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
    results: ValidationResult[],
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
    reason: string,
  ): Promise<void> {
    try {
      // TODO: Store in database for analysis
      LOG.warn(
        `❌ Token ${tokenMint.slice(
          0,
          8,
        )} FAILED at Stage ${stage} (${stageName}): ${reason}`,
      );
    } catch (error: any) {
      LOG.error(`Error logging failure: ${error.message}`);
    }
  }
}

export default new ValidationPipelineService();
export { ValidationResult, PipelineResult };
