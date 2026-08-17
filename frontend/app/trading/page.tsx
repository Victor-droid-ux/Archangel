"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Card } from "@components/ui/card";
import TradingConfigPanel from "@components/trading/trading-config";
import LiveFeed from "@components/trading/live-feed";
import TokenTable from "@app/trading/token-table";
import StatsPanel from "@app/trading/stats-panel";
import ActionsBar from "@app/trading/actions-bar";
// import { SocialFilter } from "@app/trading/social-filter"; // Disabled - backend endpoint exists (GET /api/social/twitter) but only returns hardcoded placeholder data; no real Twitter/sentiment integration exists yet, and this component's field names (count/sentiment) don't even match that stub's shape (trending/lastUpdated)
import PerformanceChart from "@components/trading/performance-chart";
import PortfolioPnLPanel from "@components/trading/PortfolioPnLPanel";
import LivePnL from "@components/trading/LivePnL";
import { NewTokens } from "@app/trading/new-tokens";
import TradeSummary from "@components/trading/trade-summary"; // ✅ imported from ui version
import TradeHistory from "@components/trading/trade-history";
import { useStatsSync } from "@hooks/useStatsSync";
import { TraderConfigModal } from "@components/trading/trader-config-modal";
import { RiskManagementPanel } from "@components/trading/risk-management-panel";
import { ValidationStatus } from "@components/trading/ValidationStatus";
import { useValidation } from "@hooks/useValidation";
import { useConfig } from "@hooks/useConfig";
import { Settings } from "lucide-react";
import { useSocket } from "@hooks/useSocket";
import { toast } from "react-hot-toast";
import { EmergencyAlert } from "@components/trading/EmergencyAlert";
import { StoredTokenCheckerStatus } from "@components/trading/StoredTokenCheckerStatus";
import { WatchlistPanel } from "@components/trading/WatchlistPanel";
import { Button } from "@components/ui/button";

// Content must never depend on this animation actually running to become
// visible — opacity starts at 1 so a stalled/skipped animation (reduced
// motion, a slow device, rAF throttling) just means no slide-in, not a
// blank section. (Confirmed this actually happens: a headless render check
// caught the header motion.div permanently stuck at opacity:0/translateY(20px)
// seconds after a clean, error-free load — whatever the exact cause, primary
// dashboard content must not be able to fail invisible.)
const fadeIn = (delay = 0) => ({
  initial: { opacity: 1, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay },
});

export default function TradingDashboard() {
  // Fetch/poll real trading stats (Total Profit, Trade Volume, Open Trades,
  // Win Rate) and trade history — without this, StatsPanel and TradeHistory
  // never receive data and their loading state never clears.
  useStatsSync();

  // Initialize socket connection for pool monitoring notifications
  const { lastMessage } = useSocket();

  // Get selected token for validation
  const { selectedToken, setAmount } = useConfig();

  // Initialize validation hook
  const { validation } = useValidation(selectedToken);

  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  // Listen for pool monitoring events
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.event === "poolAvailable") {
      const { tokenMint, message } = lastMessage.payload;
      const shortMint = tokenMint.slice(0, 8) + "...";
      toast.success(`🎉 ${message || `Pool available for ${shortMint}!`}`, {
        duration: 8000,
        position: "top-right",
      });
    }

    if (lastMessage.event === "poolMonitorTimeout") {
      const { tokenMint, message } = lastMessage.payload;
      const shortMint = tokenMint.slice(0, 8) + "...";
      toast.error(
        `⏱️ ${
          message ||
          `Monitoring timeout for ${shortMint}. Pool not available after 10 minutes.`
        }`,
        {
          duration: 6000,
          position: "top-right",
        }
      );
    }

    if (lastMessage.event === "priceAlert:triggered") {
      const { symbol, mint, currentPrice, targetPrice, condition } =
        lastMessage.payload;
      const label = symbol || (mint ? `${mint.slice(0, 8)}...` : "Token");
      toast(
        `🔔 ${label} is now ${condition} $${targetPrice} (current: $${currentPrice})`,
        { duration: 8000, position: "top-right" }
      );
    }
  }, [lastMessage]);

  return (
    <div className="space-y-10">
      {/* Emergency Alert Notifications */}
      <EmergencyAlert />

      {/* ========================== HEADER ========================== */}
      <motion.div {...fadeIn(0.1)}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="kicker mb-1">Command Center</div>
            <h1 className="text-3xl font-bold text-white mb-1">
              Trading Dashboard
            </h1>
            <p className="text-base-content/50 text-sm">
              Track trades, monitor profit, and manage your Solana trading setup
              in real time.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => setIsConfigModalOpen(true)}
            suppressHydrationWarning
          >
            <Settings className="w-4 h-4" />
            Trading Settings
          </Button>
        </div>
      </motion.div>

      {/* Trader Config Modal */}
      <TraderConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
      />

      {/* ========================== SUMMARY (Animated) ========================== */}
      <motion.div {...fadeIn(0.2)}>
        <TradeSummary />
      </motion.div>

      {/* ========================== GRID LAYOUT ========================== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT COLUMN */}
        <motion.div {...fadeIn(0.3)} className="space-y-6">
          <Card className="p-4">
            <TradingConfigPanel />
          </Card>

          {/* Validation Status Panel - NEW */}
          {selectedToken && <ValidationStatus validation={validation} />}

          {/* Stored Token Checker Status */}
          <StoredTokenCheckerStatus />

          {/* Risk Management Panel — feeds its computed position size into
              the trade-amount used by Buy/Sell (actions-bar.tsx) and manual
              buy; previously computed a number nobody downstream ever read. */}
          <RiskManagementPanel onAmountChange={setAmount} />

          <WatchlistPanel />

          {/* Social Filter temporarily disabled - backend endpoint not implemented */}
          {/* <Card className="p-4">
            <SocialFilter />
          </Card> */}
        </motion.div>

        {/* CENTER COLUMN */}
        <motion.div {...fadeIn(0.4)} className="space-y-6">
          <Card className="p-4">
            <StatsPanel />
          </Card>

          <Card className="p-4">
            <TokenTable />
          </Card>

          <Card className="p-4">
            <LiveFeed />
          </Card>
        </motion.div>

        {/* RIGHT COLUMN */}
        <motion.div {...fadeIn(0.5)} className="space-y-6">
          <Card className="p-4">
            <NewTokens />
          </Card>

          <Card className="p-4">
            <PerformanceChart />
          </Card>
          <Card className="p-4">
            <TradeHistory />
          </Card>
        </motion.div>
      </div>

      {/* ========================== PORTFOLIO P&L ========================== */}
      <motion.div
        {...fadeIn(0.55)}
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        <div className="lg:col-span-2">
          <PortfolioPnLPanel />
        </div>
        <LivePnL />
      </motion.div>

      {/* ========================== MANUAL ACTIONS ========================== */}
      <motion.div {...fadeIn(0.6)}>
        <ActionsBar />
      </motion.div>
    </div>
  );
}
