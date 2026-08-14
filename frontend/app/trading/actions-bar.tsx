"use client";

import React, { useState, useCallback } from "react";
import { TrendingUp, TrendingDown, Zap, Loader2 } from "lucide-react";
import { Button } from "@components/ui/button";
import { useWallet } from "@hooks/useWallet";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useTrade } from "@hooks/useTrade";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { toast } from "react-hot-toast";
import { motion } from "framer-motion";

export default function ActionsBar() {
  const { connected } = useWallet();
  const { selectedToken } = useTradingConfigStore();
  const { executeTrade } = useTrade();
  const { updateStats, stats } = useStats();
  const { sendMessage, connected: socketConnected } = useSocket();

  const [loading, setLoading] = useState(false);

  const handleTrade = useCallback(
    async (type: "buy" | "sell") => {
      if (!connected) {
        toast.error("Please connect your wallet first.");
        return;
      }

      setLoading(true);
      toast.loading(`${type === "buy" ? "Buying" : "Selling"}...`, {
        id: "trade-status",
      });

      try {
        if (!selectedToken) {
          toast.error("Please select a token first");
          return;
        }
        const payload = await executeTrade(type, selectedToken);
        if (!payload) throw new Error("No payload");

        toast.dismiss("trade-status");

        toast.success(
          `${
            payload.simulated ? "🧪 Simulated" : "🚀 Live"
          } ${type.toUpperCase()} ${payload.token} (${payload.amount})`
        );

        // Emit to socket feed
        sendMessage("tradeLog", {
          type: payload.type,
          token: payload.token,
          amount: payload.amount,
          pnl: payload.pnl,
          signature: payload.signature,
          time: new Date().toISOString(),
        });

        // Update local stats. payload.amount is lamports (useTrade.ts's
        // trade.amount = amountLamports); totalProfitSol/tradeVolumeSol are
        // SOL-denominated. totalProfitPercent is deliberately not touched
        // here — it's a portfolio-wide ratio (totalProfitSol / tradeVolumeSol,
        // db.service.ts), not a sum of individual trades' own pnl%; the next
        // useStatsSync poll is the authoritative source for it.
        if (typeof payload.pnl === "number") {
          const amountSol = (payload.amount ?? 0) / 1e9;
          updateStats({
            totalProfitSol: stats.totalProfitSol + amountSol * payload.pnl,
            tradeVolumeSol: stats.tradeVolumeSol + amountSol,
          });
        }
      } catch (err: any) {
        toast.dismiss("trade-status");
        toast.error("❌ Trade failed");
        console.error(err);
      }

      setLoading(false);
    },
    [connected, executeTrade, selectedToken, sendMessage, updateStats, stats]
  );

  return (
    <motion.div
      className="bg-base-200 rounded-xl p-5 flex flex-wrap justify-between items-center gap-4 border border-base-300 shadow-sm"
      initial={{ opacity: 1, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2 text-primary">
        <Zap size={18} className="text-yellow-400" />
        <h2 className="text-lg font-semibold">Trading Controls</h2>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        {/* Socket status */}
        <span
          className={`text-xs ${
            socketConnected ? "text-green-400" : "text-red-400"
          }`}
        >
          🔌 {socketConnected ? "Live" : "Offline"}
        </span>

        <Button
          variant="secondary"
          disabled={!connected || loading}
          onClick={() => handleTrade("buy")}
          className="flex items-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingUp />}
          Buy
        </Button>

        <Button
          variant="danger"
          disabled={!connected || loading}
          onClick={() => handleTrade("sell")}
          className="flex items-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingDown />}
          Sell
        </Button>
      </div>
    </motion.div>
  );
}
