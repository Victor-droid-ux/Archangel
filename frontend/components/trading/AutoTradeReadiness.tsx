// frontend/components/trading/AutoTradeReadiness.tsx
//
// A persistent status indicator for "will the bot actually trade for me
// right now" — distinct from AccountNotifications.tsx's transient popups.
// Whether a wallet is funded above the sizing floor and has auto-trade
// enabled is a continuous state, not a discrete event, so it's shown as an
// always-visible card/pill rather than a toast that would either miss the
// moment or spam on every discovery tick.
"use client";

import React, { useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useUserWallet } from "@hooks/useUserWallet";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { formatNumber } from "@lib/utils";
import { Button } from "@components/ui/button";
import { TraderConfigModal } from "@components/trading/trader-config-modal";

interface AutoTradeReadinessProps {
  // Full card (Settings page) vs a single-line pill (trading dashboard
  // header) — same underlying status, different amount of real estate.
  compact?: boolean;
}

export function AutoTradeReadiness({ compact = false }: AutoTradeReadinessProps) {
  const { connected } = useSolanaWallet();
  const { balanceSol, minBalanceForAutoTradeSol, loading: walletLoading } =
    useUserWallet();
  const { config, loading: configLoading } = useTraderConfig();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!connected) return null;

  const loading = walletLoading || configLoading;
  if (loading && balanceSol == null) {
    return compact ? null : (
      <div className="flex items-center gap-2 text-sm text-base-content/50 py-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking auto-trade
        readiness...
      </div>
    );
  }

  const autoTradeEnabled = config?.globalSettings?.autoTradeEnabled ?? false;
  const balance = balanceSol ?? 0;
  const minBalance = minBalanceForAutoTradeSol ?? 0;
  const funded = balance >= minBalance;
  const ready = autoTradeEnabled && funded;

  if (ready) {
    return compact ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-400 bg-green-900/20 border border-green-500/30 rounded-full px-3 py-1">
        <CheckCircle2 className="w-3.5 h-3.5" /> Auto-trade ready
      </span>
    ) : (
      <div className="flex items-center gap-2 text-sm text-green-400 bg-green-900/20 border border-green-500/30 rounded-lg px-4 py-3">
        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
        Auto-trade is on and your wallet is funded — the bot can trade for
        you.
      </div>
    );
  }

  const missing: string[] = [];
  if (!funded) {
    missing.push(
      `fund your wallet with ~${formatNumber(
        Math.max(minBalance - balance, 0),
        3
      )} more SOL (needs ${formatNumber(minBalance, 2)} SOL total)`
    );
  }
  if (!autoTradeEnabled) {
    missing.push("enable auto-trade in Trading Settings");
  }
  const reasonText = `The bot won't trade for you yet — ${missing.join(" and ")}.`;

  if (compact) {
    return (
      <button
        onClick={() => setSettingsOpen(true)}
        title={reasonText}
        className="inline-flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-full px-3 py-1 hover:bg-yellow-900/30 transition-colors"
      >
        <AlertTriangle className="w-3.5 h-3.5" /> Auto-trade not active
        <TraderConfigModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap text-sm text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-lg px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{reasonText}</span>
      </div>
      {!autoTradeEnabled && (
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
          Open Trading Settings
        </Button>
      )}
      <TraderConfigModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export default AutoTradeReadiness;
