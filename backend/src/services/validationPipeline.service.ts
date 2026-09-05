import { getLogger } from "../utils/logger.js";
import {
  getJupiterQuote,
  executeJupiterSwap,
  type JupiterQuote,
} from "./jupiter.service.js";
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
  // Used by the "liquidity sufficient?" Jupiter execution check — see
  // evaluateJupiterExecutionQuote. Deliberately independent of Phase 3's own
  // liquidity floor (jupiterTradeability.service.ts): that one ran once,
  // possibly seconds to minutes ago; this one re-checks right before
  // spending real capital.
  private readonly MIN_EXECUTION_LIQUIDITY_SOL = Number(
    process.env.MIN_EXECUTION_LIQUIDITY_SOL ?? 1,
  );
  // Used by the "quote still valid?" Jupiter execution check.
  private readonly MAX_QUOTE_AGE_MS = Number(
    process.env.MAX_QUOTE_AGE_MS ?? 8000,
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
  /**
   * The five Jupiter execution checks, run twice per buy: once in Stage 1
   * (pre-execution, before touching balance checks or the wallet lock) and
   * again in Stage 2 on a BRAND NEW quote fetched immediately before the
   * swap itself. Running it twice against two different quotes is what
   * makes "quote still valid" a real check rather than a formality — a
   * pool can thin out or get partially drained in the seconds between
   * Stage 1 approving a candidate and Stage 2 actually executing (wallet
   * lock queueing, balance checks, other wallets' buys in the same
   * fan-out), and only re-validating a fresh quote at the last possible
   * moment catches that.
   *
   *   Jupiter
   *   ├── Buy route exists?
   *   ├── Liquidity sufficient?
   *   ├── Price impact acceptable?
   *   ├── Expected output acceptable?
   *   └── Quote still valid?
   */
  private evaluateJupiterExecutionQuote(
    quote: JupiterQuote | null,
    quoteFetchedAt: number,
  ): { passed: boolean; reason?: string; checks: Record<string, boolean> } {
    const checks: Record<string, boolean> = {
      buy_route_exists: false,
      liquidity_sufficient: false,
      price_impact_acceptable: false,
      expected_output_acceptable: false,
      quote_still_valid: false,
    };

    // 1. Buy route exists?
    if (!quote || !(quote.outAmount > 0)) {
      return {
        passed: false,
        reason: "No Jupiter buy route available",
        checks,
      };
    }
    checks.buy_route_exists = true;

    // 2. Liquidity sufficient? — same constant-product price-impact-implied
    // reserve estimate resolveLiquidityUsd uses (see jupiter.service.ts),
    // inlined here in pure SOL terms so this needs no USD conversion and no
    // third-party price feed. impact === 0 reads as "comfortably deep, no
    // measurable impact from this trade size" rather than "unknown."
    const impact = quote.priceImpactPct;
    const inSol = quote.inAmount / 1e9;
    let impliedLiquiditySol = Infinity;
    if (Number.isFinite(impact) && impact > 0) {
      impliedLiquiditySol = (2 * inSol) / impact;
    } else if (!Number.isFinite(impact) || impact < 0) {
      impliedLiquiditySol = 0; // can't read the impact at all — fail closed
    }
    if (impliedLiquiditySol < this.MIN_EXECUTION_LIQUIDITY_SOL) {
      return {
        passed: false,
        reason: `Implied liquidity too thin: ~${impliedLiquiditySol.toFixed(2)} SOL < ${this.MIN_EXECUTION_LIQUIDITY_SOL} SOL minimum`,
        checks,
      };
    }
    checks.liquidity_sufficient = true;

    // 3. Price impact acceptable?
    if (!Number.isFinite(impact) || impact > this.MAX_SLIPPAGE) {
      return {
        passed: false,
        reason: `Price impact too high: ${Number.isFinite(impact) ? impact.toFixed(2) : "unknown"}%`,
        checks,
      };
    }
    checks.price_impact_acceptable = true;

    // 4. Expected output acceptable? — Jupiter's own worst-case guaranteed
    // output (otherAmountThreshold) must exist and must not imply Jupiter
    // is itself budgeting for far more slippage than we configured; either
    // one is a sign something is wrong with this specific quote, not just
    // "the market moved."
    const guaranteedOut = quote.otherAmountThreshold;
    if (!(guaranteedOut > 0)) {
      return {
        passed: false,
        reason: "No guaranteed minimum output on quote",
        checks,
      };
    }
    const impliedWorstCaseSlippagePct =
      ((quote.outAmount - guaranteedOut) / quote.outAmount) * 100;
    const configuredSlippagePct = quote.slippageBps / 100;
    if (impliedWorstCaseSlippagePct > configuredSlippagePct * 2) {
      return {
        passed: false,
        reason: `Quote's guaranteed output implies ${impliedWorstCaseSlippagePct.toFixed(1)}% slippage, far above the ${configuredSlippagePct.toFixed(1)}% configured`,
        checks,
      };
    }
    checks.expected_output_acceptable = true;

    // 5. Quote still valid? — freshness. Jupiter quotes are only good for a
    // few seconds on a fast-moving pool; anything fetched further back than
    // this is stale enough that re-quoting is safer than trusting it.
    const ageMs = Date.now() - quoteFetchedAt;
    if (ageMs > this.MAX_QUOTE_AGE_MS) {
      return {
        passed: false,
        reason: `Quote is ${(ageMs / 1000).toFixed(1)}s old, exceeds ${this.MAX_QUOTE_AGE_MS / 1000}s freshness limit`,
        checks,
      };
    }
    checks.quote_still_valid = true;

    return { passed: true, checks };
  }

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
      const quoteFetchedAt = Date.now();

      const evaluation = this.evaluateJupiterExecutionQuote(
        quote,
        quoteFetchedAt,
      );
      if (!evaluation.passed) {
        return {
          passed: false,
          stage: 1,
          stageName: "Jupiter Pre-Execution",
          details: { checks: evaluation.checks, quote },
          // Under exactOptionalPropertyTypes, an optional field must be a
          // real value or entirely absent — evaluation.reason is typed
          // string | undefined, so assigning it directly is a type error
          // even though it's only ever actually undefined when passed=true
          // (which never reaches this branch). Conditional spread omits the
          // key outright instead.
          ...(evaluation.reason !== undefined && { reason: evaluation.reason }),
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

      LOG.info(
        { checks: evaluation.checks },
        `[Stage 1] ✅ Jupiter Pre-Execution Check PASSED`,
      );
      return {
        passed: true,
        stage: 1,
        stageName: "Jupiter Pre-Execution",
        details: { checks: evaluation.checks, quote },
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
      const quoteFetchedAt = Date.now();

      // Re-run the same five checks Stage 1 did, against a BRAND NEW quote
      // fetched right now — this is what makes "quote still valid" mean
      // something: Stage 1 may have approved this buy seconds ago, before
      // the wallet lock queue or a balance check added latency, or before
      // another wallet in this same fan-out moved the pool. If the pool has
      // thinned out or the price has moved past what's acceptable since
      // then, this catches it immediately before capital actually moves —
      // not "does a route exist," the same full bar Stage 1 held it to.
      const evaluation = this.evaluateJupiterExecutionQuote(
        quote,
        quoteFetchedAt,
      );
      if (!evaluation.passed || !quote) {
        // The `!quote` half of this condition should be unreachable in
        // practice — evaluateJupiterExecutionQuote only reports passed=true
        // when its own internal quote check succeeded — but TypeScript
        // can't see that guarantee across the function boundary. Checking
        // it explicitly here (rather than a non-null assertion) is what
        // keeps `quote` narrowed to non-null for everything below.
        const reason =
          evaluation.reason ?? "Quote unexpectedly missing after evaluation";
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Buy Execution",
          reason,
          details: { checks: evaluation.checks },
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
