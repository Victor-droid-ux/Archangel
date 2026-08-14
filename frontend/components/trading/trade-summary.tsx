"use client";

import React from "react";
import { motion } from "framer-motion";
import CountUp from "react-countup";
import { TrendingUp, TrendingDown, Briefcase } from "lucide-react";
import { Card } from "@components/ui/card";
import { useStats } from "@hooks/useStats";

export default function TradeSummary() {
  const { stats, loading } = useStats();

  const profitPositive = stats.totalProfitSol >= 0;

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6"
      initial={{ opacity: 1, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
    >
      {/* Portfolio Value */}
      <Card className="bg-base-200 border p-4 text-center">
        <div className="flex justify-center items-center gap-2">
          <Briefcase size={20} className="text-primary" />
          <h3 className="text-sm font-semibold uppercase">Portfolio Value</h3>
        </div>

        <p className="text-2xl font-bold text-white">
          <CountUp
            end={stats.portfolioValue || 0}
            duration={1.4}
            separator=","
            decimals={4}
          />{" "}
          SOL
        </p>
      </Card>

      {/* Total Profit */}
      <Card
        className={`border p-4 text-center ${
          profitPositive
            ? "bg-green-950/30 border-green-700/40"
            : "bg-red-950/30 border-red-700/40"
        }`}
      >
        <div className="flex justify-center items-center gap-2">
          {profitPositive ? (
            <TrendingUp size={20} className="text-green-400" />
          ) : (
            <TrendingDown size={20} className="text-red-400" />
          )}
          <h3 className="text-sm font-semibold uppercase">Total Profit</h3>
        </div>

        <p
          className={`text-2xl font-bold ${
            profitPositive ? "text-green-400" : "text-red-400"
          }`}
        >
          <CountUp
            end={stats.totalProfitSol || 0}
            duration={1.4}
            separator=","
            decimals={4}
          />{" "}
          SOL
        </p>
      </Card>

      {/* Open Trades */}
      <Card className="bg-base-200 border p-4 text-center">
        <div className="flex justify-center items-center gap-2">
          <TrendingUp size={20} className="text-info" />
          <h3 className="text-sm font-semibold uppercase">Open Trades</h3>
        </div>

        <p className="text-2xl font-bold text-white">
          <CountUp end={stats.openTrades || 0} duration={1.4} />
        </p>
      </Card>
    </motion.div>
  );
}
