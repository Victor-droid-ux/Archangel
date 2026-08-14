// components/trading/TrancheProgress.tsx
"use client";

import React from "react";
import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";

interface TrancheProgressProps {
  token: string;
  firstTrancheEntry?: number;
  secondTrancheEntry?: number;
  remainingPct?: number;
  soldAt40?: boolean;
  soldAt80?: boolean;
  soldAt150?: boolean;
  currentPnl?: number;
  trailingActivated?: boolean;
  highestPnlPct?: number;
}

export const TrancheProgress: React.FC<TrancheProgressProps> = ({
  token,
  firstTrancheEntry,
  secondTrancheEntry,
  remainingPct = 100,
  soldAt40,
  soldAt80,
  soldAt150,
  currentPnl = 0,
  trailingActivated,
  highestPnlPct,
}) => {
  const tranchesComplete = !!firstTrancheEntry && !!secondTrancheEntry;
  const tranchesPending = !!firstTrancheEntry && !secondTrancheEntry;

  // Calculate profit tier progress
  const profitPct = currentPnl * 100;
  const nextTier = !soldAt40
    ? { level: 40, label: "Tier 1" }
    : !soldAt80
    ? { level: 80, label: "Tier 2" }
    : !soldAt150
    ? { level: 150, label: "Tier 3" }
    : null;

  const progressToNextTier = nextTier
    ? Math.min((profitPct / nextTier.level) * 100, 100)
    : 100;

  return (
    <div className="bg-base-300 rounded-lg p-3 space-y-3">
      {/* Tranche Status */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-400">
          Position Entry
        </div>
        <div className="flex items-center gap-2">
          {tranchesComplete && (
            <span className="text-xs text-green-400 flex items-center gap-1">
              <TrendingUp size={14} /> 2 Tranches Complete
            </span>
          )}
          {tranchesPending && (
            <span className="text-xs text-yellow-400 flex items-center gap-1">
              <AlertTriangle size={14} /> Waiting for Tranche 2
            </span>
          )}
          {!firstTrancheEntry && (
            <span className="text-xs text-slate-500">No entry yet</span>
          )}
        </div>
      </div>

      {/* Tranche Progress Bar */}
      {(tranchesComplete || tranchesPending) && (
        <div className="relative h-2 bg-base-100 rounded-full overflow-hidden">
          <motion.div
            initial={{ width: "0%" }}
            animate={{ width: tranchesComplete ? "100%" : "60%" }}
            transition={{ duration: 0.5 }}
            className={`h-full ${
              tranchesComplete ? "bg-green-500" : "bg-yellow-500"
            }`}
          />
          <div className="absolute inset-0 flex">
            <div className="w-[60%] border-r-2 border-base-300"></div>
          </div>
        </div>
      )}

      {/* Position Remaining */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-400">
          Position Size
        </div>
        <div className="text-sm font-bold">
          <span
            className={
              remainingPct === 100
                ? "text-white"
                : remainingPct >= 40
                ? "text-blue-400"
                : remainingPct > 0
                ? "text-yellow-400"
                : "text-slate-500"
            }
          >
            {remainingPct}%
          </span>
        </div>
      </div>

      {/* Profit Tiers */}
      {remainingPct > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Profit Tiers</span>
            {nextTier && (
              <span className="text-slate-300">
                Next: {nextTier.label} (+{nextTier.level}%)
              </span>
            )}
          </div>

          {/* Tier Progress Bar */}
          {nextTier && (
            <div className="relative h-2 bg-base-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: "0%" }}
                animate={{ width: `${progressToNextTier}%` }}
                transition={{ duration: 0.5 }}
                className={`h-full ${
                  profitPct >= nextTier.level
                    ? "bg-green-500"
                    : profitPct >= 0
                    ? "bg-blue-500"
                    : "bg-red-500"
                }`}
              />
            </div>
          )}

          {/* Tier Badges */}
          <div className="flex gap-2">
            <div
              className={`text-xs px-2 py-1 rounded ${
                soldAt40
                  ? "bg-green-900/50 text-green-300"
                  : "bg-slate-800/50 text-slate-500"
              }`}
            >
              Tier 1: +40%
            </div>
            <div
              className={`text-xs px-2 py-1 rounded ${
                soldAt80
                  ? "bg-green-900/50 text-green-300"
                  : "bg-slate-800/50 text-slate-500"
              }`}
            >
              Tier 2: +80%
            </div>
            <div
              className={`text-xs px-2 py-1 rounded ${
                soldAt150
                  ? "bg-green-900/50 text-green-300"
                  : "bg-slate-800/50 text-slate-500"
              }`}
            >
              Tier 3: +150%
            </div>
          </div>
        </div>
      )}

      {/* Trailing Stop Indicator */}
      {trailingActivated && remainingPct <= 10 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-blue-900/30 border border-blue-500/50 rounded p-2"
        >
          <div className="flex items-center gap-2 text-xs">
            <TrendingDown size={14} className="text-blue-400" />
            <span className="text-blue-300 font-semibold">
              Trailing Stop Active (Final 10%)
            </span>
          </div>
          {highestPnlPct !== undefined && (
            <div className="text-xs text-slate-400 mt-1">
              Peak: +{(highestPnlPct * 100).toFixed(1)}% | Current: +
              {profitPct.toFixed(1)}%
            </div>
          )}
        </motion.div>
      )}

      {/* Fully Exited */}
      {remainingPct === 0 && (
        <div className="text-center text-xs text-slate-500 py-2">
          Position Fully Exited
        </div>
      )}
    </div>
  );
};
