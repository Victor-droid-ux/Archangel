// frontend/hooks/usePnLData.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetcher } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";

export interface PortfolioPnL {
  totalInvestedSol: number;
  totalReturnedSol: number;
  unrealizedPnlSol: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  winningTrades: number;
  losingTrades: number;
  totalTrades: number;
  winRate: number;
  averageWinSol: number;
  averageLossSol: number;
  largestWinSol: number;
  largestLossSol: number;
  openPositionsValue: number;
  closedPositionsValue: number;
  roi: number;
}

export interface TokenPnL {
  token: string;
  symbol?: string;
  totalBought: number;
  totalSold: number;
  remainingTokens: number;
  averageBuyPrice: number;
  currentValue?: number;
  pnlSol: number;
  pnlPercent: number;
  trades: number;
  status: "open" | "closed";
}

export interface PnLHistoryPoint {
  date: string;
  realizedPnlSol: number;
  tradeCount: number;
  winRate: number;
}

const POLL_MS = 30000; // matches pnlBroadcaster.service.ts's own interval

export function usePnLData(historyDays = 30) {
  const { lastMessage, connected, sendMessage } = useSocket();
  const [portfolio, setPortfolio] = useState<PortfolioPnL | null>(null);
  const [tokenPnL, setTokenPnL] = useState<TokenPnL[]>([]);
  const [history, setHistory] = useState<PnLHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [portfolioRes, tokensRes, historyRes] = await Promise.all([
        fetcher(`/api/pnl/portfolio`),
        fetcher(`/api/pnl/tokens`),
        fetcher(`/api/pnl/history?days=${historyDays}`),
      ]);
      if (portfolioRes?.success) setPortfolio(portfolioRes.data);
      if (tokensRes?.success) setTokenPnL(tokensRes.data || []);
      if (historyRes?.success) setHistory(historyRes.data || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to load P&L data");
    } finally {
      setLoading(false);
    }
  }, [historyDays]);

  // Initial load + periodic refresh (covers getPnLHistory, which has no
  // real-time socket push — it's a daily aggregate, not worth pushing live)
  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Live updates without waiting for the next poll tick. Portfolio P&L is a
  // real broadcast (pnlBroadcaster.service.ts, every 30s to everyone); token
  // P&L is request/response only (socket.route.ts's pnl:tokens:request), so
  // ask for a fresh copy whenever the socket (re)connects.
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "portfolio:pnl:update") {
      setPortfolio(lastMessage.payload);
    }
    if (lastMessage.event === "pnl:tokens:update") {
      setTokenPnL(lastMessage.payload || []);
    }
  }, [lastMessage]);

  useEffect(() => {
    if (connected) sendMessage("pnl:tokens:request");
  }, [connected, sendMessage]);

  return { portfolio, tokenPnL, history, loading, error, refresh: load };
}

export default usePnLData;
