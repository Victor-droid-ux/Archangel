// frontend/hooks/useStatsSync.ts
"use client";

import { useEffect } from "react";
import { toast } from "react-hot-toast";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";

/**
 * Hybrid stats sync:
 *  - Polls /api/stats every 10s
 *  - Listens for socket "stats:update"
 *  - Writes into Zustand store
 */
export const useStatsSync = () => {
  const { updateStats, setLoading } = useStats();
  const { lastMessage } = useSocket();

  // 0️⃣ One-time backfill of recent real trades — the trade history/live
  // feed are otherwise purely socket-event-driven, so a freshly-loaded
  // dashboard shows nothing for trades/positions that happened before the
  // page was opened (e.g. positions the bot already held on page load).
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetcher<{ success: boolean; trades: any[] }>(
          "/api/trade/history?limit=100"
        );
        if (!mounted || !res?.success || !Array.isArray(res.trades)) return;
        const historical = res.trades.map((t) => ({
          id: t.id,
          type: t.type as "buy" | "sell",
          token: t.token,
          amount: t.amountLamports,
          pnl: t.pnl ?? 0,
          timestamp: new Date(t.timestamp).getTime(),
        }));
        // Merge rather than replace — a live trade may have already arrived
        // (via live-feed.tsx's addTrade) while this fetch was in flight.
        const existing = useStats.getState().tradeHistory;
        const existingIds = new Set(existing.map((t) => t.id));
        useStats
          .getState()
          .setTradeHistory([
            ...existing,
            ...historical.filter((t) => !existingIds.has(t.id)),
          ]);
      } catch (err) {
        console.error("❌ Failed to backfill trade history:", err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // 1️⃣ Poll backend periodically
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await fetcher("/api/stats");

        updateStats((prev) => ({
          portfolioValue: Number(data.portfolioValue ?? prev.portfolioValue),
          totalProfitSol: Number(data.totalProfitSol ?? prev.totalProfitSol),
          totalProfitPercent: Number(
            data.totalProfitPercent ?? prev.totalProfitPercent
          ),
          openTrades: Number(data.openTrades ?? prev.openTrades),
          tradeVolumeSol: Number(data.tradeVolumeSol ?? prev.tradeVolumeSol),
          winRate: Number(data.winRate ?? prev.winRate),
        }));
      } catch (err) {
        console.error("❌ Failed to fetch stats:", err);
        toast.error("Unable to load dashboard stats.");
      } finally {
        // Loading state must clear even on failure, otherwise the panels
        // gated on it (StatsPanel, TradeHistory) show a spinner forever.
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [updateStats, setLoading]);

  // 2️⃣ Live updates from socket
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event !== "stats:update") return;

    const s = lastMessage.payload;
    if (!s) return;

    updateStats((prev) => ({
      portfolioValue: Number(s.portfolioValue ?? prev.portfolioValue),
      totalProfitSol: Number(s.totalProfitSol ?? prev.totalProfitSol),
      totalProfitPercent: Number(
        s.totalProfitPercent ?? prev.totalProfitPercent
      ),
      openTrades: Number(s.openTrades ?? prev.openTrades),
      tradeVolumeSol: Number(s.tradeVolumeSol ?? prev.tradeVolumeSol),
      winRate: Number(s.winRate ?? prev.winRate),
    }));
  }, [lastMessage, updateStats]);
};
