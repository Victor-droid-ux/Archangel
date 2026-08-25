"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { Settings as SettingsIcon } from "lucide-react";
import TradingConfigPanel from "@components/trading/trading-config";
import { TraderConfigModal } from "@components/trading/trader-config-modal";
import { DepositPanel } from "@components/trading/DepositPanel";
import { AutoTradeReadiness } from "@components/trading/AutoTradeReadiness";
import { Button } from "@components/ui/button";

// Content must never depend on this animation actually running to become
// visible — opacity starts at 1 so a stalled/skipped animation (reduced
// motion, a slow device, rAF throttling) just means no slide-in, not a
// blank section.
const fadeIn = (delay = 0) => ({
  initial: { opacity: 1, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay },
});

export default function SettingsPage() {
  const [isGlobalConfigOpen, setIsGlobalConfigOpen] = useState(false);

  return (
    <div className="space-y-10 max-w-2xl mx-auto">
      <motion.div {...fadeIn(0.1)}>
        <div className="kicker mb-1">Configuration</div>
        <h1 className="text-3xl font-bold text-white mb-1">Settings</h1>
        <p className="text-base-content/50 text-sm">
          Manual-trade defaults live here; auto-trade strategy rules are global,
          per wallet — edit those separately below.
        </p>
      </motion.div>

      <motion.div {...fadeIn(0.2)}>
        <DepositPanel />
      </motion.div>

      <motion.div {...fadeIn(0.22)}>
        <AutoTradeReadiness />
      </motion.div>

      <motion.div {...fadeIn(0.25)}>
        <TradingConfigPanel />
      </motion.div>

      <motion.div
        {...fadeIn(0.3)}
        className="bg-base-200 border border-white/[0.07] rounded-2xl shadow-elevated p-6 flex items-center justify-between gap-4 flex-wrap"
      >
        <div>
          <h2 className="font-display text-lg font-semibold text-white">
            Global Auto-Trade Rules
          </h2>
          <p className="text-sm text-base-content/50 mt-1">
            Market cap range, launch window, take-profit/stop-loss, and
            auto-trading eligibility applied across all tokens.
          </p>
        </div>
        <Button variant="primary" onClick={() => setIsGlobalConfigOpen(true)}>
          <SettingsIcon className="w-4 h-4" />
          Configure
        </Button>
      </motion.div>

      <TraderConfigModal
        isOpen={isGlobalConfigOpen}
        onClose={() => setIsGlobalConfigOpen(false)}
      />
    </div>
  );
}
