"use client";

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { toast } from "react-hot-toast";
import { useWallet } from "@hooks/useWallet";
import { useRiskManagement } from "@hooks/useRiskManagement";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { useSolPrice } from "@hooks/useSolPrice";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { TrendingUp, AlertTriangle, Shield } from "lucide-react";

interface RiskManagementPanelProps {
  onAmountChange?: (amount: number, lamports: number) => void;
}

export const RiskManagementPanel: React.FC<RiskManagementPanelProps> = ({
  onAmountChange,
}) => {
  const { balance } = useWallet();
  const {
    riskPercent,
    riskAmount,
    setRiskPercent,
    setRiskAmount,
    tradeAmountLamports,
    recommendation,
  } = useRiskManagement();

  const { saveConfig, syncConfig, loadConfig, loadConfigFromAPI } =
    useTradingConfigStore();
  const { publicKey, signMessage } = useSolanaWallet();

  // Global, per-wallet auto-trade rules — the real settings the bot's
  // execution engine reads (see multiUserExecution.service.ts), as opposed
  // to the trading-config store above, which is display-only.
  const { config, updateGlobalSettings, loading } = useTraderConfig();
  const solPriceUsd = useSolPrice();

  const [formData, setFormData] = useState({
    minMarketCapSol: 5,
    takeProfitPct: 10,
    stopLossPct: 30,
    minSecondsSinceLaunch: "" as number | "",
    autoTradeEnabled: false,
    maxTradeAmountSol: 1,
    // "" means unlimited (cleared/never set) — distinct from 0, which would
    // read as "take zero trades" rather than "no cap".
    maxTotalTrades: "" as number | "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config?.globalSettings) {
      const g = config.globalSettings;
      setFormData({
        minMarketCapSol: g.minMarketCapSol ?? 5,
        takeProfitPct: (g.takeProfitPct ?? 0.1) * 100,
        stopLossPct: (g.stopLossPct ?? 0.3) * 100,
        minSecondsSinceLaunch: g.minSecondsSinceLaunch ?? "",
        autoTradeEnabled: g.autoTradeEnabled ?? false,
        maxTradeAmountSol: g.maxTradeAmountSol ?? 1,
        maxTotalTrades: g.maxTotalTrades ?? "",
      });
    }
  }, [config]);

  // A minimum launch age is required before auto-trading can start.
  const launchWindowError =
    formData.minSecondsSinceLaunch === "" ||
    !Number.isFinite(Number(formData.minSecondsSinceLaunch)) ||
    Number(formData.minSecondsSinceLaunch) < 0 ||
    Number(formData.minSecondsSinceLaunch) > 30 * 24 * 3600
      ? "Set a minimum launch age between 0 and 30 days"
      : null;

  // Blank ("") means unlimited and is always valid — only a filled-in value
  // needs to be a real positive whole number.
  const maxTotalTradesError =
    formData.maxTotalTrades === ""
      ? null
      : !Number.isFinite(formData.maxTotalTrades) ||
          !Number.isInteger(formData.maxTotalTrades) ||
          formData.maxTotalTrades <= 0
        ? "Enter a positive whole number, or leave blank for unlimited"
        : formData.maxTotalTrades > 100000
          ? "Must be 100000 or less"
          : null;

  const maxTradeAmountError =
    !Number.isFinite(formData.maxTradeAmountSol) ||
    formData.maxTradeAmountSol <= 0
      ? "Enter a finite positive trade amount"
      : null;

  const minMarketCapError =
    !Number.isFinite(formData.minMarketCapSol) || formData.minMarketCapSol < 0
      ? "Enter a finite non-negative minimum market cap"
      : null;

  // Local config first (fast, always available), then reconcile with this
  // wallet's cloud-saved settings once it's connected — cloud wins for a
  // returning wallet since that's the source of truth across devices.
  // Re-runs on every wallet change (not just mount) — otherwise switching
  // from Wallet A to Wallet B in the same browser session would leave A's
  // values in the live store until/unless B happens to have cloud-saved
  // settings that overwrite every field.
  React.useEffect(() => {
    loadConfig?.(publicKey?.toString());
  }, [publicKey, loadConfig]);

  React.useEffect(() => {
    if (publicKey) {
      loadConfigFromAPI?.(publicKey.toString());
    }
  }, [publicKey, loadConfigFromAPI]);

  const handleSave = async () => {
    if (
      launchWindowError ||
      maxTotalTradesError ||
      maxTradeAmountError ||
      minMarketCapError
    )
      return;
    setSaving(true);
    try {
      await updateGlobalSettings({
        minMarketCapSol: formData.minMarketCapSol,
        takeProfitPct: formData.takeProfitPct / 100,
        stopLossPct: formData.stopLossPct / 100,
        minSecondsSinceLaunch: Number(formData.minSecondsSinceLaunch),
        autoTradeEnabled: formData.autoTradeEnabled,
        maxTradeAmountSol: formData.maxTradeAmountSol,
        maxTotalTrades:
          formData.maxTotalTrades === "" ? null : formData.maxTotalTrades,
      });
      saveConfig?.(publicKey?.toString());
      if (publicKey) {
        await syncConfig?.(publicKey.toString(), signMessage);
      }
      toast.success("✅ Settings saved!");
    } catch (err) {
      console.error("Failed to save settings:", err);
      toast.error("❌ Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleLoadCloud = async () => {
    try {
      if (!publicKey) {
        toast.error("⚠️ Please connect your wallet first.");
        return;
      }
      await loadConfigFromAPI?.(publicKey.toString());
      toast.success("☁️ Config loaded from cloud!");
    } catch {
      toast.error("⚠️ Failed to load from cloud.");
    }
  };

  // Notify parent when risk amount changes
  React.useEffect(() => {
    if (onAmountChange && riskAmount > 0) {
      onAmountChange(riskAmount, tradeAmountLamports);
    }
  }, [riskAmount, tradeAmountLamports, onAmountChange]);

  const handlePresetClick = (
    preset: "conservative" | "moderate" | "aggressive"
  ) => {
    if (!recommendation) return;

    const amount = recommendation[preset];
    setRiskAmount(amount);
  };

  const getRiskColor = () => {
    if (riskPercent <= 2) return "text-green-400";
    if (riskPercent <= 5) return "text-yellow-400";
    return "text-red-400";
  };

  const getRiskLevel = () => {
    if (riskPercent <= 2) return "Conservative";
    if (riskPercent <= 5) return "Moderate";
    return "Aggressive";
  };

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4 w-full">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-400" />
          Risk Management & Global Trading Settings
        </CardTitle>
        <p className="text-xs text-gray-500 mt-1">
          These settings apply to all tokens unless overridden.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Risk Input Options */}
          <div className="p-2.5 bg-base-300 rounded-lg grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Risk %
              </label>
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={riskPercent || ""}
                onChange={(e) => setRiskPercent(Number(e.target.value))}
                className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="%"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Fixed (SOL)
              </label>
              <input
                type="number"
                min="0.001"
                max={balance}
                step="0.001"
                value={riskAmount || ""}
                onChange={(e) => setRiskAmount(Number(e.target.value))}
                className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Amount"
              />
            </div>
          </div>

          {/* Market Cap Range */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Min Market Cap (SOL)
            </label>
            <input
              type="number"
              value={formData.minMarketCapSol}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  minMarketCapSol: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              min="0"
              step="1"
            />
            {solPriceUsd != null && (
              <p className="text-xs text-gray-500 mt-0.5">
                ~${(formData.minMarketCapSol * solPriceUsd).toLocaleString()}
              </p>
            )}
            {minMarketCapError && (
              <p className="text-xs text-red-500 mt-0.5">{minMarketCapError}</p>
            )}
          </div>

          {/* Take Profit / Stop Loss */}
          <div className="p-2.5 bg-base-300 rounded-lg grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Take Profit (%)
              </label>
              <input
                type="number"
                value={formData.takeProfitPct}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    takeProfitPct: Number(e.target.value),
                  })
                }
                className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                min="0"
                step="1"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Stop Loss (%)
              </label>
              <input
                type="number"
                value={formData.stopLossPct}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    stopLossPct: Number(e.target.value),
                  })
                }
                className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                min="0"
                step="0.5"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Minimum Launch Age */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Min Launch Age (seconds)
            </label>
            <input
              type="number"
              value={formData.minSecondsSinceLaunch}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  minSecondsSinceLaunch: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              min="0"
              step="1"
              placeholder="Seconds"
            />
            {launchWindowError && (
              <p className="text-xs text-red-500 mt-0.5">{launchWindowError}</p>
            )}
          </div>

          {/* Max Total Trades */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Max Total Trades
            </label>
            <input
              type="number"
              value={formData.maxTotalTrades}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  maxTotalTrades:
                    e.target.value === "" ? "" : Number(e.target.value),
                })
              }
              className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              min="1"
              step="1"
              placeholder="Unlimited"
            />
            {maxTotalTradesError && (
              <p className="text-xs text-red-500 mt-0.5">
                {maxTotalTradesError}
              </p>
            )}
          </div>

          {/* Auto Trade */}
          <div className="p-2.5 bg-base-300 rounded-lg flex items-center justify-between">
            <span className="text-sm text-gray-400">Enable Auto Trading</span>
            <Switch
              checked={formData.autoTradeEnabled}
              onCheckedChange={(value) =>
                setFormData({ ...formData, autoTradeEnabled: value })
              }
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Quick Presets */}
          {recommendation && (
            <div className="p-2.5 bg-base-300 rounded-lg">
              <div className="text-sm text-gray-400 mb-1">Quick Presets</div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handlePresetClick("conservative")}
                  className="px-2 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg transition-colors"
                >
                  Conservative
                  <div className="text-xs opacity-75">
                    {recommendation.conservative.toFixed(3)} SOL
                  </div>
                </button>
                <button
                  onClick={() => handlePresetClick("moderate")}
                  className="px-2 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white text-xs rounded-lg transition-colors"
                >
                  Moderate
                  <div className="text-xs opacity-75">
                    {recommendation.moderate.toFixed(3)} SOL
                  </div>
                </button>
                <button
                  onClick={() => handlePresetClick("aggressive")}
                  className="px-2 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg transition-colors"
                >
                  Aggressive
                  <div className="text-xs opacity-75">
                    {recommendation.aggressive.toFixed(3)} SOL
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Risk Summary */}
          {riskAmount > 0 && (
            <div className="p-2.5 bg-base-300 rounded-lg border border-primary/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-400">Trade Amount</span>
                <span className="text-lg font-bold text-primary">
                  {riskAmount.toFixed(4)} SOL
                </span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-400">Risk Level</span>
                <span className={`text-sm font-semibold ${getRiskColor()}`}>
                  {getRiskLevel()} ({riskPercent.toFixed(2)}%)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Remaining Balance</span>
                <span className="text-sm text-white">
                  {(balance - riskAmount).toFixed(4)} SOL
                </span>
              </div>
            </div>
          )}

          {/* Risk Warning / Info */}
          {riskPercent > 10 ? (
            <div className="flex items-start gap-2 p-2.5 bg-red-900/20 border border-red-500/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-300">
                <strong>High Risk Warning:</strong> Trading more than 10% of
                your balance per trade significantly increases your risk of
                loss.
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 p-2.5 bg-blue-900/20 border border-blue-500/30 rounded-lg">
              <TrendingUp className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-blue-300">
                Set either a percentage of your balance or a fixed amount per
                trade.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" onClick={handleLoadCloud}>
            Load Config from Cloud
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              saving ||
              loading ||
              !!launchWindowError ||
              !!maxTotalTradesError ||
              !!maxTradeAmountError ||
              !!minMarketCapError
            }
          >
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
