// frontend/components/trading/trader-config-modal.tsx
"use client";

import { useState, useEffect } from "react";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { useSolPrice } from "@hooks/useSolPrice";
import {
  X,
  Settings,
  TrendingUp,
  AlertTriangle,
  DollarSign,
} from "lucide-react";

interface TraderConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TraderConfigModal({ isOpen, onClose }: TraderConfigModalProps) {
  const { config, updateGlobalSettings, loading } = useTraderConfig();
  const solPriceUsd = useSolPrice();

  const [formData, setFormData] = useState({
    minMarketCapSol: 5,
    maxMarketCapSol: 1000000,
    minMarketCapUsd: 1000,
    maxMarketCapUsd: 200000000,
    minLiquiditySol: 0.05,
    maxLiquiditySol: 1000000,
    minLiquidityUsd: 0,
    maxLiquidityUsd: 200000000,
    takeProfitPct: 10,
    stopLossPct: 30,
    minSecondsSinceLaunch: "" as number | "",
    maxSecondsSinceLaunch: "" as number | "",
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
        maxMarketCapSol: g.maxMarketCapSol ?? 1000000,
        minMarketCapUsd: g.minMarketCapUsd ?? 1000,
        maxMarketCapUsd: g.maxMarketCapUsd ?? 200000000,
        minLiquiditySol: g.minLiquiditySol ?? 0.05,
        maxLiquiditySol: g.maxLiquiditySol ?? 1000000,
        minLiquidityUsd: g.minLiquidityUsd ?? 0,
        maxLiquidityUsd: g.maxLiquidityUsd ?? 200000000,
        takeProfitPct: (g.takeProfitPct ?? 0.1) * 100,
        stopLossPct: (g.stopLossPct ?? 0.3) * 100,
        minSecondsSinceLaunch: g.minSecondsSinceLaunch ?? "",
        maxSecondsSinceLaunch: g.maxSecondsSinceLaunch ?? "",
        autoTradeEnabled: g.autoTradeEnabled ?? false,
        maxTradeAmountSol: g.maxTradeAmountSol ?? 1,
        maxTotalTrades: g.maxTotalTrades ?? "",
      });
    }
  }, [config]);

  // Same fail-closed reasoning as Max Token Age: empty/negative/inverted
  // values here would either reject every token or accept all of them.
  const launchWindowError =
    formData.minSecondsSinceLaunch === "" ||
    formData.maxSecondsSinceLaunch === "" ||
    !Number.isFinite(Number(formData.minSecondsSinceLaunch)) ||
    Number(formData.minSecondsSinceLaunch) < 0 ||
    !Number.isFinite(Number(formData.maxSecondsSinceLaunch)) ||
    Number(formData.maxSecondsSinceLaunch) <= 0
      ? "Set both launch-window values"
      : Number(formData.minSecondsSinceLaunch) >
          Number(formData.maxSecondsSinceLaunch)
        ? "Min cannot exceed max"
        : formData.maxSecondsSinceLaunch > 30 * 24 * 3600
          ? "Must be 30 days or less"
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

  const metricRanges: Array<[string, number, number]> = [
    ["market cap SOL", formData.minMarketCapSol, formData.maxMarketCapSol],
    ["market cap USD", formData.minMarketCapUsd, formData.maxMarketCapUsd],
    ["liquidity SOL", formData.minLiquiditySol, formData.maxLiquiditySol],
    ["liquidity USD", formData.minLiquidityUsd, formData.maxLiquidityUsd],
  ];
  const metricRangeError = metricRanges.some(
    ([, min, max]) =>
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < 0 ||
      max < 0 ||
      min > max
  )
    ? "Enter finite non-negative values where each minimum does not exceed its maximum"
    : null;

  const handleSave = async () => {
    if (
      launchWindowError ||
      maxTotalTradesError ||
      maxTradeAmountError ||
      metricRangeError
    )
      return;
    setSaving(true);
    try {
      await updateGlobalSettings({
        minMarketCapSol: formData.minMarketCapSol,
        maxMarketCapSol: formData.maxMarketCapSol,
        minMarketCapUsd: formData.minMarketCapUsd,
        maxMarketCapUsd: formData.maxMarketCapUsd,
        minLiquiditySol: formData.minLiquiditySol,
        maxLiquiditySol: formData.maxLiquiditySol,
        minLiquidityUsd: formData.minLiquidityUsd,
        maxLiquidityUsd: formData.maxLiquidityUsd,
        takeProfitPct: formData.takeProfitPct / 100,
        stopLossPct: formData.stopLossPct / 100,
        minSecondsSinceLaunch: Number(formData.minSecondsSinceLaunch),
        maxSecondsSinceLaunch: Number(formData.maxSecondsSinceLaunch),
        autoTradeEnabled: formData.autoTradeEnabled,
        maxTradeAmountSol: formData.maxTradeAmountSol,
        maxTotalTrades:
          formData.maxTotalTrades === "" ? null : formData.maxTotalTrades,
      });
      onClose();
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Settings className="w-6 h-6 text-blue-400" />
            <h2 className="text-2xl font-bold text-white">
              Global Trading Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Market Cap Range */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-green-400" />
              <h3 className="text-lg font-semibold text-white">
                Market Cap Range
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0"
                  step="1"
                />
                {solPriceUsd != null && (
                  <p className="text-xs text-gray-500 mt-1">
                    ~$
                    {(formData.minMarketCapSol * solPriceUsd).toLocaleString()}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Market Cap (SOL)
                </label>
                <input
                  type="number"
                  value={formData.maxMarketCapSol}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      maxMarketCapSol: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0"
                  step="1000"
                />
                {solPriceUsd != null && (
                  <p className="text-xs text-gray-500 mt-1">
                    ~$
                    {(formData.maxMarketCapSol * solPriceUsd).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-blue-400" />
              <h3 className="text-lg font-semibold text-white">
                Launch Liquidity and USD Limits
              </h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  ["Min Market Cap (USD)", "minMarketCapUsd", 0],
                  ["Max Market Cap (USD)", "maxMarketCapUsd", 0],
                  ["Min Liquidity (SOL)", "minLiquiditySol", 0],
                  ["Max Liquidity (SOL)", "maxLiquiditySol", 0],
                  ["Min Liquidity (USD)", "minLiquidityUsd", 0],
                  ["Max Liquidity (USD)", "maxLiquidityUsd", 0],
                ] as const
              ).map(([label, field, min]) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {label}
                  </label>
                  <input
                    type="number"
                    value={formData[field]}
                    min={min}
                    step="any"
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        [field]: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}
            </div>
            {metricRangeError && (
              <p className="text-sm text-red-400">{metricRangeError}</p>
            )}
          </div>

          {/* TP/SL */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-400" />
              <h3 className="text-lg font-semibold text-white">
                Take Profit / Stop Loss
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0"
                  step="1"
                />
                <p className="text-xs text-green-500 mt-1">
                  Exit at +{formData.takeProfitPct}% profit
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0"
                  step="0.5"
                />
                <p className="text-xs text-red-500 mt-1">
                  Exit at -{formData.stopLossPct}% loss
                </p>
              </div>
            </div>
          </div>

          {/* Other Settings */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-purple-400" />
              <h3 className="text-lg font-semibold text-white">
                Other Settings
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Launch Window (seconds since launch)
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={formData.minSecondsSinceLaunch}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        minSecondsSinceLaunch: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    step="1"
                    placeholder="Min"
                  />
                  <span className="text-gray-500">to</span>
                  <input
                    type="number"
                    value={formData.maxSecondsSinceLaunch}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxSecondsSinceLaunch: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    step="1"
                    placeholder="Max"
                  />
                </div>
                {launchWindowError ? (
                  <p className="text-xs text-red-500 mt-1">
                    {launchWindowError}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    Only buy tokens between {formData.minSecondsSinceLaunch}s
                    and {formData.maxSecondsSinceLaunch}s after their pool was
                    created
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Trade Amount (SOL)
                </label>
                <input
                  type="number"
                  value={formData.maxTradeAmountSol}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      maxTradeAmountSol: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0.01"
                  step="0.1"
                />
                {maxTradeAmountError && (
                  <p className="text-xs text-red-500 mt-1">
                    {maxTradeAmountError}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="1"
                  step="1"
                  placeholder="Unlimited"
                />
                {maxTotalTradesError ? (
                  <p className="text-xs text-red-500 mt-1">
                    {maxTotalTradesError}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    {config?.tradesTaken != null
                      ? `${config.tradesTaken} trade${
                          config.tradesTaken === 1 ? "" : "s"
                        } taken so far. `
                      : ""}
                    {formData.maxTotalTrades === ""
                      ? "The bot trades for you with no lifetime limit."
                      : `The bot stops trading for you after ${formData.maxTotalTrades} total trade${
                          formData.maxTotalTrades === 1 ? "" : "s"
                        } — raise this number to continue.`}
                  </p>
                )}
              </div>

              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.autoTradeEnabled}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        autoTradeEnabled: e.target.checked,
                      })
                    }
                    className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">
                    Enable Auto Trading
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-800 bg-gray-800/50">
          <p className="text-sm text-gray-400">
            These settings apply to all tokens unless overridden
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={
                saving ||
                loading ||
                !!launchWindowError ||
                !!maxTotalTradesError ||
                !!maxTradeAmountError ||
                !!metricRangeError
              }
              className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
