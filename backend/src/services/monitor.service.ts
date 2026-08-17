// backend/src/services/monitor.service.ts
import {
  getJupiterQuote,
  executeJupiterSwap,
  getJupiterTokenInfo,
  getSolPriceUsd,
} from "./jupiter.service.js";
import dbService, { Position } from "./db.service.js";
import { getLogger } from "../utils/logger.js";
import notify from "./notifications/notify.service.js";
import { Server } from "socket.io";
import crypto from "crypto";
import { Connection, Commitment, Keypair, PublicKey } from "@solana/web3.js";
import { checkAllEmergencyTriggers } from "./emergencyExit.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import userWalletService from "./userWallet.service.js";
import { loadKeypairFromEnv } from "./solana.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";

const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

/**
 * Resolves the keypair that can actually sign a sell for a given position's
 * owner wallet — the single admin keypair for the operator's own positions,
 * or that specific user's decrypted custodial hot-wallet keypair otherwise.
 * Positions bought under a wallet with no matching signer (e.g. a user
 * record that's since been removed) can't be sold automatically — logged
 * loudly rather than silently skipped, since that needs a human to notice.
 */
async function resolveSignerForPosition(
  ownerWallet: string
): Promise<Keypair | null> {
  if (ownerWallet === OPERATOR_WALLET) {
    return loadKeypairFromEnv();
  }
  return userWalletService.getUserWalletKeypair(ownerWallet);
}

// A token whose pool has genuinely run dry (fully rugged/delisted) can
// never be sold, no matter how many times a Jupiter quote is retried — but
// nothing here can tell "temporarily no route" apart from "permanently no
// route" in advance. Rather than guessing, this backs off the retry
// frequency (and the alert spam) after enough consecutive failures, while
// still trying occasionally in case liquidity genuinely comes back.
const SELL_BACKOFF_THRESHOLD = 5; // consecutive failures before slowing down
const SELL_BACKOFF_INTERVAL_MS = 30 * 60 * 1000; // 30 min between attempts once backed off
// Once backed off, only re-alert every Nth backed-off attempt (~6h at the
// 30-minute interval above) instead of every single one.
const SELL_NOTIFY_EVERY_N_BACKED_OFF_ATTEMPTS = 12;

/** True if this position is in backoff cooldown and this tick should skip
 * attempting a sell for it entirely (no Jupiter call, no log spam). */
function isSellInBackoffCooldown(pos: {
  sellFailureCount?: number;
  lastSellAttemptAt?: Date | string | null;
}): boolean {
  const failures = pos.sellFailureCount ?? 0;
  if (failures < SELL_BACKOFF_THRESHOLD) return false;
  const last = pos.lastSellAttemptAt
    ? new Date(pos.lastSellAttemptAt).getTime()
    : 0;
  return Date.now() - last < SELL_BACKOFF_INTERVAL_MS;
}

/** Records a failed sell attempt and returns whether this specific failure
 * should actually be alerted on (vs. silently logged) — always the first
 * failure, never again until backed off, then only every Nth attempt. */
async function recordSellFailure(
  tokenMint: string,
  wallet: string,
  currentFailureCount: number | undefined
): Promise<{ newCount: number; shouldNotify: boolean }> {
  const newCount = (currentFailureCount ?? 0) + 1;
  await dbService.updatePositionMetadata(tokenMint, wallet, {
    sellFailureCount: newCount,
    lastSellAttemptAt: new Date(),
  });
  const shouldNotify =
    newCount <= 1 ||
    (newCount >= SELL_BACKOFF_THRESHOLD &&
      (newCount - SELL_BACKOFF_THRESHOLD) %
        SELL_NOTIFY_EVERY_N_BACKED_OFF_ATTEMPTS ===
        0);
  return { newCount, shouldNotify };
}

/** Clears the failure streak after any successful sell for this position. */
async function recordSellSuccess(
  tokenMint: string,
  wallet: string
): Promise<void> {
  await dbService.updatePositionMetadata(tokenMint, wallet, {
    sellFailureCount: 0,
  });
}

const log = getLogger("monitor");

/* ------------------------------------------------------------------
   CONFIG
------------------------------------------------------------------ */

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Global default TP/SL (percent *as decimal*; 0.1 = 10%)
const DEFAULT_TP_PCT = Number(process.env.TP_PCT ?? 0.1);
// 30% default — meaningfully wider than the ~2.4-2.7% round-trip price-impact
// "noise floor" measured on these thin/fresh pools, and in line with typical
// sniper-bot SL sizing for freshly-launched tokens (see SL_GRACE_PERIOD_MS
// below for the other half of this fix).
const DEFAULT_SL_PCT = Number(process.env.SL_PCT ?? 0.3);

// Don't evaluate TP/SL/emergency-exit at all until a position has been open
// this long. A fair-value price feed still has some settling/staleness right
// at the moment of entry, and this is a second, independent guard against
// stopping out on noise rather than a real move.
const SL_GRACE_PERIOD_MS = Number(process.env.SL_GRACE_PERIOD_MS ?? 20_000);

// Tiered profit-taking: sell a fixed slice of the remaining position each time
// PnL crosses one of these thresholds, locking in gains progressively rather
// than all-or-nothing at a single TP.
const TIER1_PROFIT_PCT = Number(process.env.TIER1_PROFIT_PCT ?? 0.4);
const TIER2_PROFIT_PCT = Number(process.env.TIER2_PROFIT_PCT ?? 0.8);
const TIER3_PROFIT_PCT = Number(process.env.TIER3_PROFIT_PCT ?? 1.5);
const TIER_SELL_PCT = Number(process.env.TIER_SELL_PCT ?? 30);

// Use Helius RPC for monitoring token balances and position tracking
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) ||
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
  "https://api.mainnet-beta.solana.com";

if (!SOLANA_RPC.startsWith("http")) {
  throw new Error("SOLANA_RPC_URL must start with http(s)://");
}

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

/* ------------------------------------------------------------------
   TYPES
------------------------------------------------------------------ */

// Position type now imported from db.service.ts
// Extended locally if needed for monitor-specific fields
type MonitorPosition = Position & {
  tpPct?: number; // take profit threshold (decimal: 0.15 = 15%)
  slPct?: number; // stop loss threshold (decimal: -0.05 = -5%)
  decimals?: number; // token decimals if stored
  highestPnlPct?: number; // highest profit % reached (for trailing)
  trailingActivated?: boolean; // whether trailing is active
};

// Trailing take-profit configuration - RULE 9
const TRAILING_ACTIVATION_PCT = Number(
  process.env.TRAILING_ACTIVATION_PCT ?? 0.15
); // 15% profit to activate trailing
const TRAILING_STOP_PCT = Number(process.env.TRAILING_STOP_PCT ?? 0.05); // 5% drop from peak to exit

/* ------------------------------------------------------------------
   MINT DECIMALS CACHE
------------------------------------------------------------------ */

const mintDecimalsCache = new Map<string, number>();

async function getMintDecimals(mint: string): Promise<number> {
  if (mintDecimalsCache.has(mint)) {
    return mintDecimalsCache.get(mint)!;
  }

  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed: any = info.value?.data;
    const decimals =
      parsed?.parsed?.info?.decimals ?? parsed?.info?.decimals ?? 9; // fallback

    const n = Number(decimals);
    const safeDecimals = Number.isFinite(n) ? n : 9;

    mintDecimalsCache.set(mint, safeDecimals);
    return safeDecimals;
  } catch (err: any) {
    log.warn(
      { mint, err: err?.message ?? String(err) },
      "Failed to fetch mint decimals; using 9"
    );
    mintDecimalsCache.set(mint, 9);
    return 9;
  }
}

/* ------------------------------------------------------------------
   CORE POSITION MONITOR
------------------------------------------------------------------ */

export function startPositionMonitor(
  io: Server,
  opts?: { intervalMs?: number }
) {
  const intervalMs = opts?.intervalMs ?? 5000;

  log.info(
    {
      intervalMs,
      DEFAULT_TP_PCT,
      DEFAULT_SL_PCT,
    },
    "Starting position monitor"
  );

  const tick = async () => {
    try {
      const positions: MonitorPosition[] = await dbService.getPositions();

      for (const pos of positions) {
        try {
          const tokenMint = pos.token;
          if (!tokenMint) continue;
          // Self-custody positions (manual buys, held in the user's own
          // connected wallet) can't be auto-managed here at all — this
          // monitor only ever resolves a signer for the operator's env key
          // or a custodial hot wallet (see resolveSignerForPosition below),
          // never the user's own private key, which the server never has.
          // Selling those is the user's own responsibility (the manual Sell
          // page). Legacy trades recorded before this field existed
          // (custody === null) are skipped too rather than guessed at.
          if (pos.custody !== "custodial") continue;
          // netSol is derived from cumulative buy-minus-sell lamports; after a
          // position is fully exited this rarely lands on exactly 0 due to
          // floating-point/rounding residue across multiple fills, leaving a
          // tiny positive value forever. Without a floor, this position never
          // reads as "closed" and the monitor keeps attempting real (fee-costing)
          // sells on economically meaningless dust every single tick, forever.
          const DUST_THRESHOLD_SOL = Number(
            process.env.POSITION_DUST_THRESHOLD_SOL ?? 0.0005
          );
          if (!pos.netSol || pos.netSol < DUST_THRESHOLD_SOL) continue;

          // A position that's failed to sell repeatedly (e.g. a rugged
          // token with no Jupiter route left) backs off to a slow retry
          // instead of hammering Jupiter and re-alerting every 5-second tick
          // forever — see recordSellFailure/isSellInBackoffCooldown above.
          if (isSellInBackoffCooldown(pos)) {
            continue;
          }

          // Grace period: don't evaluate TP/SL/emergency-exit at all until the
          // position has been open long enough for the price feed to settle.
          // See SL_GRACE_PERIOD_MS above for why this exists alongside the
          // fair-value price fix below — belt and suspenders against stopping
          // out on noise at the moment of entry rather than a real move.
          if (pos.firstBuyAt) {
            const ageMs = Date.now() - new Date(pos.firstBuyAt).getTime();
            if (ageMs < SL_GRACE_PERIOD_MS) {
              log.debug(
                { tokenMint, ageMs, graceMs: SL_GRACE_PERIOD_MS },
                "Skipping TP/SL check: position still within entry grace period"
              );
              continue;
            }
          }

          // Per-position overrides if you ever add them to DB
          const tpPct =
            typeof pos.tpPct === "number" ? pos.tpPct : DEFAULT_TP_PCT;
          const slPct =
            typeof pos.slPct === "number" ? pos.slPct : DEFAULT_SL_PCT;

          // Fetch decimals (cached)
          const decimals =
            typeof pos.decimals === "number"
              ? pos.decimals
              : await getMintDecimals(tokenMint);
          const base = 10 ** decimals;

          // avgBuyPrice = SOL per token, computed by db.service.ts directly from
          // this token's own real buy fills. There is no safe fallback for a
          // missing cost basis — substituting an arbitrary fixed price here
          // would compare a real current price against a fabricated entry
          // price, manufacturing a fake PnL that could trigger a real sell.
          // If the real cost basis isn't available, skip this position rather
          // than act on invented data.
          if (
            typeof pos.avgBuyPrice !== "number" ||
            !(pos.avgBuyPrice > 0)
          ) {
            log.warn(
              { tokenMint, avgBuyPrice: pos.avgBuyPrice },
              "Skipping position: no real avgBuyPrice recorded for this token"
            );
            continue;
          }
          const avgBuy = pos.avgBuyPrice;

          // Estimated token quantity = total SOL exposure / avg buy price
          const estTokenQty = pos.netSol / avgBuy;
          if (!Number.isFinite(estTokenQty) || estTokenQty <= 0) {
            log.debug(
              { tokenMint, netSol: pos.netSol, avgBuy },
              "Skipping position: invalid estTokenQty"
            );
            continue;
          }

          // Full position in token base units
          const fullAmountBase = Math.floor(estTokenQty * base);
          if (!fullAmountBase || fullAmountBase <= 0) {
            log.debug(
              { tokenMint, estTokenQty, decimals },
              "Skipping position: zero base amount"
            );
            continue;
          }

          // Fair-value price for PnL/TP/SL decisions — NOT a quote for a
          // specific trade size. A sell-side quote (what used to be used here)
          // bakes in that trade's own price impact on top of the pool's real
          // bid-ask spread, so it's always biased below what the token is
          // actually worth — comparing that against avgBuy (which is itself
          // inflated by buy-side price impact) manufactures an apparent loss
          // from the round-trip spread alone, the instant a position opens,
          // regardless of what the token's price actually does. Jupiter's
          // aggregated usdPrice is a fair-value estimate, not an executable
          // quote, so it doesn't have this bias. Real execution quotes are
          // still fetched fresh at the moment of an actual sell, below.
          const tokenInfo = await getJupiterTokenInfo(tokenMint);
          if (!tokenInfo || !tokenInfo.usdPrice) continue;
          const solPriceUsd = await getSolPriceUsd();
          const currentPrice = tokenInfo.usdPrice / solPriceUsd; // SOL per token

          const pnlPercent = (currentPrice - avgBuy) / avgBuy;

          // Update highest PnL for trailing stop - RULE 9
          const highestPnl = pos.highestPnlPct ?? pnlPercent;
          const newHighest = Math.max(highestPnl, pnlPercent);

          // Activate trailing if profit exceeds activation threshold
          const trailingActive =
            pos.trailingActivated || newHighest >= TRAILING_ACTIVATION_PCT;

          // Check trailing stop exit condition
          const trailingTriggered =
            trailingActive && newHighest - pnlPercent >= TRAILING_STOP_PCT;

          // Update position with new highest PnL and trailing status
          if (
            newHighest > highestPnl ||
            trailingActive !== pos.trailingActivated
          ) {
            await dbService.updatePositionMetadata(tokenMint, pos.wallet, {
              highestPnlPct: newHighest,
              trailingActivated: trailingActive,
            });

            // Emit trailing stop status to frontend — only this position's
            // own owner wallet (or everyone, for the shared operator bot).
            emitToWalletOrGlobal(io, pos.wallet, "position:trailingUpdate", {
              token: tokenMint,
              wallet: pos.wallet,
              currentPnlPct: pnlPercent,
              highestPnlPct: newHighest,
              trailingActivated: trailingActive,
              trailingStopPct: TRAILING_STOP_PCT,
              trailingActivationPct: TRAILING_ACTIVATION_PCT,
              drawdownFromPeak: trailingActive ? newHighest - pnlPercent : 0,
              timestamp: Date.now(),
            });
          }

          // ✨ RULE 10: EMERGENCY EXIT CHECKS (CRITICAL - CHECK FIRST!)
          // poolAddress/creatorAddress are stored on the token's DB record at
          // discovery time (both discovery paths now write them). Without these,
          // 3 of the 4 triggers below (LP removal, large-sell, creator-sell)
          // silently no-op — this lookup is what makes them real.
          const tokenState = await dbService.getTokenState(tokenMint);
          const emergencyCheck = await checkAllEmergencyTriggers(
            tokenMint,
            currentPrice,
            tokenState?.poolAddress || undefined,
            tokenState?.creatorAddress || undefined
          );

          if (emergencyCheck.shouldExit) {
            log.error(
              {
                tokenMint,
                reason: emergencyCheck.criticalReason,
                triggers: emergencyCheck.triggers,
              },
              "🚨 EMERGENCY EXIT TRIGGERED - SELLING ALL IMMEDIATELY!"
            );

            // This is the strongest signal this codebase ever produces that a
            // token is actively dangerous (LP pulled, creator dumping, etc.)
            // — blacklist it regardless of whether the sell below succeeds,
            // so it drops out of getTokensByState("TRADABLE") and stops being
            // recommended on the manual Buy page (trade.route.ts's
            // /manual-buy-candidates) or re-triggering auto-buy for anyone
            // else. Previously only the 30-second-behavior-check path ever
            // blacklisted anything — a token that looked fine at discovery
            // and only turned bad later stayed "TRADABLE" forever.
            await dbService.blacklistToken(
              tokenMint,
              emergencyCheck.criticalReason || "Emergency exit triggered"
            );

            // Emergency sell ALL tokens immediately — using THIS position's
            // own owner wallet, not a fixed backend wallet, since positions
            // can now belong to any of many custodial hot wallets.
            const useRealSwap = process.env.USE_REAL_SWAP === "true";
            const emergencySigner = await resolveSignerForPosition(pos.wallet);

            if (useRealSwap && emergencySigner) {
              // addTrade's `amount` field is SOL lamports, not the token amount
              // being sold — fetch a real quote to know actual SOL proceeds
              // rather than recording the raw token unit count (which silently
              // corrupts tradeVolumeSol/pnlSol by orders of magnitude).
              const emergencyQuote = await getJupiterQuote(
                tokenMint,
                SOL_MINT,
                fullAmountBase,
                1000
              );
              const emergencySwap = await executeJupiterSwap({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: fullAmountBase,
                userPublicKey: emergencySigner.publicKey.toBase58(),
                slippageBps: 1000, // High slippage for emergency
                signer: emergencySigner,
              });

              if (emergencySwap.success) {
                const emergencyTrade = {
                  id: crypto.randomUUID(),
                  type: "sell" as const,
                  token: tokenMint,
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: Number(emergencyQuote?.outAmount ?? 0),
                  price: currentPrice,
                  pnl: pnlPercent,
                  wallet: pos.wallet,
                  simulated: false,
                  signature: emergencySwap.signature ?? null,
                  timestamp: new Date(),
                  custody: "custodial" as const,
                };

                await dbService.addTrade(emergencyTrade);
                await recordSellSuccess(tokenMint, pos.wallet);

                // Emergency exit always sells the entire position — stop the
                // live P&L poll loop, otherwise it keeps polling Birdeye for
                // a token we no longer hold, forever (pnlTracker.service.ts's
                // stopTracking is never called automatically).
                pnlTrackerService.stopTracking(tokenMint, pos.wallet);

                emitToWalletOrGlobal(io, pos.wallet, "tradeFeed", {
                  ...emergencyTrade,
                  auto: true,
                  reason: "emergency_exit",
                  exitReason: emergencyCheck.criticalReason,
                  emergency: true,
                });

                log.info(
                  {
                    tokenMint,
                    reason: emergencyCheck.criticalReason,
                    signature: emergencySwap.signature,
                  },
                  "🚨 Emergency exit completed"
                );
              } else {
                log.error(
                  {
                    tokenMint,
                    error: emergencySwap.error,
                  },
                  "Emergency exit swap failed!"
                );

                const { newCount, shouldNotify } = await recordSellFailure(
                  tokenMint,
                  pos.wallet,
                  pos.sellFailureCount
                );
                if (shouldNotify) {
                  notify
                    .notifyError({
                      source: "position-monitor",
                      message: `Emergency exit failed for ${tokenMint}${
                        newCount >= SELL_BACKOFF_THRESHOLD
                          ? ` (${newCount} consecutive failures — backing off to a 30-minute retry interval)`
                          : ""
                      }`,
                      details: {
                        error: emergencySwap.error,
                        reason: emergencyCheck.criticalReason,
                      },
                    })
                    .catch(() => {});
                }
              }
            }

            continue; // Skip normal TP/SL checks - emergency handled
          }

          // ✨ RULE 9: TIERED PROFIT TARGETS (30% at +40%, +80%, +150%)
          const remainingPct = pos.remainingPct ?? 100; // Track remaining position %

          // Check for tiered profit target triggers
          let shouldSellTiered = false;
          let sellPercent = 0;
          let tierReason = "";

          if (!pos.soldAt40 && pnlPercent >= TIER1_PROFIT_PCT && remainingPct > 0) {
            shouldSellTiered = true;
            sellPercent = TIER_SELL_PCT;
            tierReason = `Tier 1: +${(TIER1_PROFIT_PCT * 100).toFixed(0)}% profit`;
            await dbService.updatePositionMetadata(tokenMint, pos.wallet, {
              soldAt40: true,
              remainingPct: remainingPct - TIER_SELL_PCT,
            });
          } else if (
            !pos.soldAt80 &&
            pnlPercent >= TIER2_PROFIT_PCT &&
            remainingPct > 0
          ) {
            shouldSellTiered = true;
            sellPercent = TIER_SELL_PCT;
            tierReason = `Tier 2: +${(TIER2_PROFIT_PCT * 100).toFixed(0)}% profit`;
            await dbService.updatePositionMetadata(tokenMint, pos.wallet, {
              soldAt80: true,
              remainingPct: remainingPct - TIER_SELL_PCT,
            });
          } else if (
            !pos.soldAt150 &&
            pnlPercent >= TIER3_PROFIT_PCT &&
            remainingPct > 0
          ) {
            shouldSellTiered = true;
            sellPercent = TIER_SELL_PCT;
            tierReason = `Tier 3: +${(TIER3_PROFIT_PCT * 100).toFixed(0)}% profit`;
            await dbService.updatePositionMetadata(tokenMint, pos.wallet, {
              soldAt150: true,
              remainingPct: remainingPct - TIER_SELL_PCT,
            });
          }

          // Execute tiered sell if triggered
          if (shouldSellTiered) {
            const sellAmountBase = Math.floor(
              fullAmountBase * (sellPercent / 100)
            );

            log.info(
              {
                tokenMint,
                pnlPercent,
                sellPercent,
                tierReason,
                remainingPct: remainingPct - sellPercent,
              },
              `🎯 Tiered profit target hit: ${tierReason}. Selling ${sellPercent}%`
            );

            const useRealSwap = process.env.USE_REAL_SWAP === "true";

            if (useRealSwap) {
              const tieredSigner = await resolveSignerForPosition(pos.wallet);

              if (tieredSigner) {
                // See emergency-exit block above: addTrade's `amount` is SOL
                // lamports, so record the quoted SOL proceeds, not the token
                // amount sold.
                const tieredQuote = await getJupiterQuote(
                  tokenMint,
                  SOL_MINT,
                  sellAmountBase,
                  Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1) * 100
                );
                const tieredSwap = await executeJupiterSwap({
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: sellAmountBase,
                  userPublicKey: tieredSigner.publicKey.toBase58(),
                  slippageBps: Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1) * 100,
                  signer: tieredSigner,
                });

                if (tieredSwap.success) {
                  const tieredTrade = {
                    id: crypto.randomUUID(),
                    type: "sell" as const,
                    token: tokenMint,
                    inputMint: tokenMint,
                    outputMint: SOL_MINT,
                    amount: Number(tieredQuote?.outAmount ?? 0),
                    price: currentPrice,
                    pnl: pnlPercent,
                    wallet: pos.wallet,
                    simulated: false,
                    signature: tieredSwap.signature ?? null,
                    timestamp: new Date(),
                  };

                  await dbService.addTrade(tieredTrade);
                  await recordSellSuccess(tokenMint, pos.wallet);

                  emitToWalletOrGlobal(io, pos.wallet, "tradeFeed", {
                    ...tieredTrade,
                    auto: true,
                    reason: "tiered_profit",
                    exitReason: tierReason,
                    sellPercent,
                    remainingPct: remainingPct - sellPercent,
                  });

                  log.info(
                    {
                      tokenMint,
                      tierReason,
                      sellPercent,
                      signature: tieredSwap.signature,
                    },
                    "✅ Tiered profit sell executed"
                  );
                } else {
                  log.error(
                    { tokenMint, error: tieredSwap.error },
                    "Tiered profit sell failed"
                  );

                  const { newCount, shouldNotify } = await recordSellFailure(
                    tokenMint,
                    pos.wallet,
                    pos.sellFailureCount
                  );
                  if (shouldNotify) {
                    notify
                      .notifyError({
                        source: "position-monitor",
                        message: `Tiered profit sell failed for ${tokenMint}${
                          newCount >= SELL_BACKOFF_THRESHOLD
                            ? ` (${newCount} consecutive failures — backing off to a 30-minute retry interval)`
                            : ""
                        }`,
                        details: { error: tieredSwap.error, tierReason, sellPercent },
                      })
                      .catch(() => {});
                  }
                }
              }
            }
          }

          // Check trailing stop for LAST 10% of position
          const isLastTenPercent = remainingPct <= 10;
          const trailingStopForFinal =
            isLastTenPercent &&
            trailingActive &&
            newHighest - pnlPercent >= TRAILING_STOP_PCT;

          // Check TP/SL triggers (including trailing for final 10%)
          if (
            pnlPercent <= -slPct || // Stop loss
            (isLastTenPercent && trailingStopForFinal) // Trailing stop for last 10%
          ) {
            const exitReason = trailingStopForFinal
              ? `Trailing stop on final 10% (peak: ${(newHighest * 100).toFixed(
                  1
                )}%, current: ${(pnlPercent * 100).toFixed(1)}%)`
              : `Stop loss (${(pnlPercent * 100).toFixed(1)}%)`;
            log.info(
              {
                tokenMint,
                pnlPercent,
                avgBuy,
                currentPrice,
                slPct,
                highestPnl: newHighest,
                trailingActive,
                remainingPct,
                exitReason,
              },
              `Position exit triggered: ${exitReason}. Executing auto-sell.`
            );

            const useRealSwap = process.env.USE_REAL_SWAP === "true";

            // Calculate remaining position to sell (based on remainingPct)
            const sellAmountBase = Math.floor(
              fullAmountBase * (remainingPct / 100)
            );

            let swapRes:
              | { success: true; signature?: string }
              | { success: false; error?: string };

            let finalSellSolAmount = 0;

            if (useRealSwap) {
              const finalSigner = await resolveSignerForPosition(pos.wallet);

              if (!finalSigner) {
                log.error(
                  { tokenMint, wallet: pos.wallet },
                  "USE_REAL_SWAP=true but no signer could be resolved for this position's wallet"
                );
                swapRes = {
                  success: false,
                  error: "Missing signer for auto-sell",
                };
              } else {
                // Verify balance before selling (should have tokens)
                log.info(
                  {
                    tokenMint,
                    amount: sellAmountBase,
                    remainingPct,
                  },
                  "Executing final auto-sell"
                );
                // addTrade's `amount` is SOL lamports, so record the quoted SOL
                // proceeds below, not the token amount sold (sellAmountBase).
                const finalQuote = await getJupiterQuote(
                  tokenMint,
                  SOL_MINT,
                  sellAmountBase,
                  Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1) * 100
                );
                finalSellSolAmount = Number(finalQuote?.outAmount ?? 0);
                swapRes = await executeJupiterSwap({
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: sellAmountBase,
                  userPublicKey: finalSigner.publicKey.toBase58(),
                  slippageBps: Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1) * 100,
                  signer: finalSigner,
                });
              }
            } else {
              const simQuote = await getJupiterQuote(
                tokenMint,
                SOL_MINT,
                sellAmountBase,
                Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1) * 100
              );
              finalSellSolAmount = Number(simQuote?.outAmount ?? 0);
              swapRes = {
                success: true,
                signature: `sim-sell-${Date.now()}`,
              };
            }

            if (!swapRes.success) {
              log.error(
                {
                  tokenMint,
                  error: swapRes.error,
                },
                "Auto-sell swap failed"
              );

              const { newCount, shouldNotify } = await recordSellFailure(
                tokenMint,
                pos.wallet,
                pos.sellFailureCount
              );
              if (shouldNotify) {
                notify
                  .notifyError({
                    source: "position-monitor",
                    message: `Auto-sell failed for ${tokenMint}${
                      newCount >= SELL_BACKOFF_THRESHOLD
                        ? ` (${newCount} consecutive failures — backing off to a 30-minute retry interval)`
                        : ""
                    }`,
                    details: { error: swapRes.error, pnlPercent, tpPct, slPct },
                  })
                  .catch(() => {});
              }

              continue;
            }

            await recordSellSuccess(tokenMint, pos.wallet);

            // Build trade record in DB format
            const tradeRecord = {
              id: crypto.randomUUID(),
              type: "sell" as const,
              token: tokenMint,
              inputMint: tokenMint,
              outputMint: SOL_MINT,
              amount: finalSellSolAmount, // SOL lamports received, not tokens sold
              price: currentPrice, // SOL per token
              pnl: pnlPercent, // decimal (0.12 = +12%)
              wallet: pos.wallet,
              simulated: !useRealSwap,
              signature: swapRes.signature ?? null,
              timestamp: new Date(),
            };

            // Update position metadata to mark as fully exited
            await dbService.updatePositionMetadata(tokenMint, pos.wallet, {
              remainingPct: 0,
            });

            // Position fully closed — stop the live P&L poll loop for it (see
            // the emergency-exit call site above for why this matters).
            pnlTrackerService.stopTracking(tokenMint, pos.wallet);

            // Persist and let db.service compute updated stats
            const saved = await dbService.addTrade(tradeRecord);

            // Emit rich tradeFeed event for frontend PnL
            emitToWalletOrGlobal(io, pos.wallet, "tradeFeed", {
              id: saved.id,
              type: saved.type,
              token: saved.token,
              wallet: pos.wallet,
              amount: saved.amountLamports,
              amountSol: saved.amountSol,
              price: saved.price,
              pnl: saved.pnl, // decimal
              pnlSol: saved.pnlSol,
              simulated: saved.simulated,
              signature: saved.signature,
              timestamp: saved.timestamp,
              auto: true,
              reason: trailingStopForFinal
                ? "trailing_stop_final"
                : pnlPercent <= -slPct
                ? "stop_loss"
                : "final_exit",
              exitReason: exitReason,
              sellPercent: remainingPct,
              remainingPct: 0,
              highestPnlPct: trailingStopForFinal ? newHighest : undefined,
            });

            log.info(
              {
                tokenMint,
                id: saved.id,
                reason: pnlPercent >= tpPct ? "TP" : "SL",
              },
              "Auto-sell executed & broadcast"
            );

            // Send notification (build object with only defined properties)
            const notifyPayload: {
              id: string;
              type: "sell";
              token: string;
              amountSol: number;
              price?: number;
              pnl?: number;
              signature?: string | null;
              simulated?: boolean;
            } = {
              id: saved.id,
              type: "sell",
              token: saved.token,
              amountSol: saved.amountSol,
            };
            if (saved.price !== undefined) notifyPayload.price = saved.price;
            if (saved.pnl !== undefined) notifyPayload.pnl = saved.pnl;
            if (saved.signature !== undefined)
              notifyPayload.signature = saved.signature;
            if (saved.simulated !== undefined)
              notifyPayload.simulated = saved.simulated;

            notify
              .notifyTrade(notifyPayload)
              .catch((notifyErr) =>
                log.warn(
                  { err: notifyErr },
                  "Failed to send trade notification"
                )
              );
          }
        } catch (innerErr: any) {
          log.error(
            {
              err: innerErr?.message ?? String(innerErr),
            },
            "Monitor inner loop error"
          );

          // Send error notification for critical monitoring failures
          notify
            .notifyError({
              source: "position-monitor",
              message: "Position monitoring error",
              details: {
                error: innerErr?.message ?? String(innerErr),
                position: pos,
              },
            })
            .catch(() => {});
        }
      }
    } catch (err: any) {
      log.error(
        { err: err?.message ?? String(err) },
        "Position monitor tick failed"
      );
    }
  };

  const timer = setInterval(tick, intervalMs);

  // Run one tick immediately on startup
  tick().catch((e) =>
    log.warn(
      { err: (e as any)?.message ?? String(e) },
      "Initial monitor tick error"
    )
  );

  // Allow caller to stop monitor
  return () => clearInterval(timer);
}
