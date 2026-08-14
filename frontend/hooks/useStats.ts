// hooks/useStats.ts
"use client";

import { create } from "zustand";

export type TradeHistoryItem = {
  id: string;
  type: "buy" | "sell" | "info";
  token: string;
  amount: number;
  pnl: number;
  timestamp: number;
};
export interface DashboardStats {
  portfolioValue: number;
  totalProfitSol: number;
  totalProfitPercent: number;
  openTrades: number;
  tradeVolumeSol: number;
  winRate: number;
}

interface StatsState {
  stats: DashboardStats;
  tradeHistory: TradeHistoryItem[];
  loading: boolean;
  setLoading: (loading: boolean) => void;
  addTrade: (t: TradeHistoryItem) => void;
  setTradeHistory: (trades: TradeHistoryItem[]) => void;
  updateStats: (
    updates:
      | Partial<DashboardStats>
      | ((prev: DashboardStats) => Partial<DashboardStats>)
  ) => void;
}

export const useStats = create<StatsState>((set) => ({
  loading: true,

  stats: {
    portfolioValue: 0,
    totalProfitSol: 0,
    totalProfitPercent: 0,
    openTrades: 0,
    tradeVolumeSol: 0,
    winRate: 0,
  },

  tradeHistory: [],

  setLoading: (loading) => set({ loading }),

  addTrade: (t) =>
    set((state) => ({
      tradeHistory: [t, ...state.tradeHistory].slice(0, 200),
    })),

  // Bulk-replace, used once on mount to backfill from /api/trade/history —
  // addTrade prepends one at a time, which would double-count or misorder a
  // full history batch.
  setTradeHistory: (trades) => set({ tradeHistory: trades.slice(0, 200) }),

  updateStats: (updates) =>
    set((state) => {
      const partial =
        typeof updates === "function" ? updates(state.stats) : updates;

      return { stats: { ...state.stats, ...partial } };
    }),
}));
