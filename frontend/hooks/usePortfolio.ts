// hooks/usePortfolio.ts
"use client";

import { useEffect } from "react";
import { useWallet } from "./useWallet";
import { useStats } from "./useStats";
import { useSocket } from "./useSocket";

/**
 * Syncs the wallet's live SOL balance into stats.portfolioValue.
 *
 * This deliberately does NOT touch totalProfitSol/totalProfitPercent.
 * "current balance − balance when the wallet first connected" is not P&L —
 * topping up the wallet or withdrawing SOL mid-session would show up as a
 * fake profit/loss under that math. Real P&L is trade-based (db.service.ts's
 * getStats()/getPortfolioPnL(), synced into the same stats store by
 * useStatsSync.ts) and must stay the only writer of those two fields, or the
 * dashboard flickers between two disagreeing numbers.
 */
export const usePortfolio = () => {
  const { connected, balance, publicKey } = useWallet();
  const { stats, updateStats } = useStats();
  const { lastMessage } = useSocket();

  // Live balance updates from backend
  useEffect(() => {
    if (!lastMessage || !connected) return;
    if (lastMessage.event !== "wallet:balance") return;

    const balanceData = lastMessage.payload;
    if (!balanceData || balanceData.wallet !== publicKey) return;

    updateStats({ portfolioValue: balanceData.balance });
  }, [lastMessage, connected, publicKey, updateStats]);

  // Local balance polling fallback (useWallet's own 10s refresh)
  useEffect(() => {
    if (!connected || !publicKey) {
      updateStats({ portfolioValue: 0 });
      return;
    }
    if (balance > 0) {
      updateStats({ portfolioValue: balance });
    }
  }, [balance, connected, publicKey, updateStats]);

  return {
    portfolioValue: stats.portfolioValue,
    totalProfitSol: stats.totalProfitSol,
    totalProfitPercent: stats.totalProfitPercent,
  };
};
