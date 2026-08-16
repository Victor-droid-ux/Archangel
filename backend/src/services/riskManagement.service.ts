/**
 * Risk Management Engine
 *
 * POSITION SIZING: Risk Engine
 * - Max 2% risk per trade
 * - No arbitrary cap on simultaneous open positions by default (was
 *   hardcoded to 3 — that number had no basis in an actual risk model, it
 *   just silently stopped the bot from taking new qualifying trades once 3
 *   were open). Real protection against overexposure still comes from the
 *   per-trade risk-percent sizing and the daily-loss circuit breaker below,
 *   both of which remain fully enforced. Set MAX_OPEN_POSITIONS in .env if
 *   you actually want a cap.
 * - Max 6% daily loss
 * - Bot stops trading when limits hit
 */

import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { getBalanceInSol } from "./solana.service.js";

const log = getLogger("riskManagement");

// Configuration (can be overridden by environment variables)
const MAX_RISK_PER_TRADE_PCT = Number(process.env.MAX_RISK_PER_TRADE_PCT ?? 2); // 2%
// Unset/0 means "no cap" — the number of *qualifying* trades the bot can
// hold is bounded by real risk controls (position sizing, daily-loss limit,
// wallet balance), not by an arbitrary count.
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS ?? 0);
const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT ?? 6); // 6%

interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  currentRisk: {
    openPositions: number;
    dailyLossPct: number;
    portfolioValue: number;
    maxTradeSize: number;
  };
}

/**
 * Check if a trade is allowed based on risk management rules
 */
export async function canExecuteTrade(
  tradeAmountSol: number,
  walletAddress: string
): Promise<RiskCheckResult> {
  try {
    // Scoped to this specific wallet — each user's exposure/risk state must
    // be independent. Without walletAddress here, one user's open positions
    // would count against (and could block) every other user's trades.
    const positions = await dbService.getPositions(walletAddress);
    const openPositions = positions.filter((p) => p.netSol > 0).length;

    // Check max open positions (0/unset = no cap)
    if (MAX_OPEN_POSITIONS > 0 && openPositions >= MAX_OPEN_POSITIONS) {
      log.warn(
        `Trade blocked: Max ${MAX_OPEN_POSITIONS} open positions reached (current: ${openPositions})`
      );
      return {
        allowed: false,
        reason: `Maximum ${MAX_OPEN_POSITIONS} open positions already active`,
        currentRisk: {
          openPositions,
          dailyLossPct: 0,
          portfolioValue: 0,
          maxTradeSize: 0,
        },
      };
    }

    // Calculate daily loss
    const dailyLoss = await calculateDailyLoss(walletAddress);
    // Position sizing must be based on actual wallet equity, not on money
    // already committed to positions (dbService.getPortfolioPnL().totalInvestedSol
    // is a running sum of past buys — with few/no trades yet that's ~0, which made
    // "2% of portfolio" collapse to ~0 SOL and reject every trade regardless of
    // real wallet balance).
    const portfolioValue = await getBalanceInSol(walletAddress);
    const dailyLossPct = portfolioValue > 0 ? (dailyLoss / portfolioValue) * 100 : 0;

    // Check max daily loss
    if (dailyLossPct >= MAX_DAILY_LOSS_PCT) {
      log.warn(
        `Trade blocked: Max daily loss ${MAX_DAILY_LOSS_PCT}% reached (current: ${dailyLossPct.toFixed(
          2
        )}%)`
      );
      return {
        allowed: false,
        reason: `Daily loss limit ${MAX_DAILY_LOSS_PCT}% exceeded (${dailyLossPct.toFixed(
          2
        )}%)`,
        currentRisk: {
          openPositions,
          dailyLossPct,
          portfolioValue,
          maxTradeSize: 0,
        },
      };
    }

    // Calculate max trade size (2% of portfolio)
    const maxTradeSize = (portfolioValue * MAX_RISK_PER_TRADE_PCT) / 100;

    // Callers size trades as exactly `balance * riskPct` before calling here, so a
    // legitimate trade should land right at maxTradeSize — but that's a different
    // formula (`(x * pct) / 100` vs `x * (pct / 100)`), which can disagree by a
    // sub-lamport floating-point rounding error on an otherwise-identical value.
    // A tiny relative tolerance absorbs that noise without loosening the real cap.
    if (tradeAmountSol > maxTradeSize * (1 + 1e-6)) {
      log.warn(
        `Trade blocked: Amount ${tradeAmountSol} SOL exceeds max ${MAX_RISK_PER_TRADE_PCT}% risk (${maxTradeSize.toFixed(
          2
        )} SOL)`
      );
      return {
        allowed: false,
        reason: `Trade size ${tradeAmountSol} SOL exceeds ${MAX_RISK_PER_TRADE_PCT}% max risk (${maxTradeSize.toFixed(
          2
        )} SOL)`,
        currentRisk: {
          openPositions,
          dailyLossPct,
          portfolioValue,
          maxTradeSize,
        },
      };
    }

    // All checks passed
    log.info(
      `Risk check PASSED: ${tradeAmountSol} SOL trade allowed | Open: ${openPositions}/${MAX_OPEN_POSITIONS} | Daily Loss: ${dailyLossPct.toFixed(
        2
      )}%/${MAX_DAILY_LOSS_PCT}%`
    );

    return {
      allowed: true,
      currentRisk: {
        openPositions,
        dailyLossPct,
        portfolioValue,
        maxTradeSize,
      },
    };
  } catch (err) {
    log.error(`Risk check failed: ${err}`);
    return {
      allowed: false,
      reason: `Risk check error: ${err}`,
      currentRisk: {
        openPositions: 0,
        dailyLossPct: 0,
        portfolioValue: 0,
        maxTradeSize: 0,
      },
    };
  }
}

/**
 * Calculate total loss for today, scoped to one wallet — otherwise one
 * user's losses would trip the daily-loss circuit breaker for everyone.
 */
async function calculateDailyLoss(walletAddress: string): Promise<number> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const trades = await dbService.getTrades(500, false, walletAddress);

    // Filter trades from today
    const todayTrades = trades.filter(
      (t) => t.timestamp >= startOfDay && t.type === "sell"
    );

    // Sum up losses (negative pnlSol)
    const totalLoss = todayTrades
      .filter((t) => (t.pnlSol || 0) < 0)
      .reduce((sum, t) => sum + Math.abs(t.pnlSol || 0), 0);

    return totalLoss;
  } catch (err) {
    log.error(`Failed to calculate daily loss: ${err}`);
    return 0;
  }
}

/**
 * Get current risk status
 */
export async function getRiskStatus(walletAddress: string): Promise<{
  openPositions: number;
  maxOpenPositions: number;
  dailyLossSol: number;
  dailyLossPct: number;
  maxDailyLossPct: number;
  tradingAllowed: boolean;
  portfolioValue: number;
}> {
  const positions = await dbService.getPositions(walletAddress);
  const openPositions = positions.filter((p) => p.netSol > 0).length;

  // Same fix as canExecuteTrade: live wallet balance, not a fake fallback of
  // 100 SOL for a cumulative-invested figure that's ~0 with few/no trades yet.
  const portfolioValue = await getBalanceInSol(walletAddress);

  const dailyLossSol = await calculateDailyLoss(walletAddress);
  const dailyLossPct = (dailyLossSol / portfolioValue) * 100;

  const tradingAllowed =
    (MAX_OPEN_POSITIONS <= 0 || openPositions < MAX_OPEN_POSITIONS) &&
    dailyLossPct < MAX_DAILY_LOSS_PCT;

  return {
    openPositions,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    dailyLossSol,
    dailyLossPct,
    maxDailyLossPct: MAX_DAILY_LOSS_PCT,
    tradingAllowed,
    portfolioValue,
  };
}

export default {
  canExecuteTrade,
  getRiskStatus,
};
