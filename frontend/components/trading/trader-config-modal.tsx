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

type TokenAgeUnit = "seconds" | "minutes" | "hours";
const UNIT_TO_SECONDS: Record<TokenAgeUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

// Pick the largest unit that divides the stored seconds value evenly, so a
// value someone entered as "2 hours" still shows as "2 hours" (not "7200
// seconds") next time they open this modal.
function secondsToValueUnit(totalSeconds: number): {
  value: number;
  unit: TokenAgeUnit;
} {
  if (totalSeconds > 0 && totalSeconds % 3600 === 0) {
    return { value: totalSeconds / 3600, unit: "hours" };
  }
  if (totalSeconds > 0 && totalSeconds % 60 === 0) {
    return { value: totalSeconds / 60, unit: "minutes" };
  }
  return { value: totalSeconds, unit: "seconds" };
}

export function TraderConfigModal({ isOpen, onClose }: TraderConfigModalProps) {
  const { config, updateGlobalSettings, loading } = useTraderConfig();
  const solPriceUsd = useSolPrice();

  const [formData, setFormData] = useState({
    minMarketCapSol: 5,
    maxMarketCapSol: 1000000,
    takeProfitPct: 10,
    stopLossPct: 2,
    maxTokenAgeValue: 24,
    maxTokenAgeUnit: "hours" as TokenAgeUnit,
    minSecondsSinceLaunch: 10,
    maxSecondsSinceLaunch: 60,
    minTokenScore: 30,
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
      // Prefer the new normalized field; fall back to the pre-unit-selector
      // hours-only field for configs saved before this change existed.
      const totalSeconds =
        g.maxTokenAgeSeconds ?? (g.maxTokenAgeHours ?? 24) * 3600;
      const { value, unit } = secondsToValueUnit(totalSeconds);

      setFormData({
        minMarketCapSol: g.minMarketCapSol ?? 5,
        maxMarketCapSol: g.maxMarketCapSol ?? 1000000,
        takeProfitPct: (g.takeProfitPct ?? 0.1) * 100,
        stopLossPct: (g.stopLossPct ?? 0.02) * 100,
        maxTokenAgeValue: value,
        maxTokenAgeUnit: unit,
        minSecondsSinceLaunch: g.minSecondsSinceLaunch ?? 10,
        maxSecondsSinceLaunch: g.maxSecondsSinceLaunch ?? 60,
        minTokenScore: g.minTokenScore ?? 30,
        autoTradeEnabled: g.autoTradeEnabled ?? false,
        maxTradeAmountSol: g.maxTradeAmountSol ?? 1,
        maxTotalTrades: g.maxTotalTrades ?? "",
      });
    }
  }, [config]);

  // Empty/zero/negative/non-finite all block Save rather than silently
  // sending something that would either reject every token or accept all of
  // them unexpectedly.
  const maxTokenAgeSeconds =
    formData.maxTokenAgeValue * UNIT_TO_SECONDS[formData.maxTokenAgeUnit];
  const maxTokenAgeError =
    !Number.isFinite(maxTokenAgeSeconds) || maxTokenAgeSeconds <= 0
      ? "Enter a positive number"
      : maxTokenAgeSeconds > 30 * 24 * 3600
      ? "Must be 30 days or less"
      : null;

  // Same fail-closed reasoning as Max Token Age: empty/negative/inverted
  // values here would either reject every token or accept all of them.
  const launchWindowError =
    !Number.isFinite(formData.minSecondsSinceLaunch) ||
    formData.minSecondsSinceLaunch < 0 ||
    !Number.isFinite(formData.maxSecondsSinceLaunch) ||
    formData.maxSecondsSinceLaunch <= 0
      ? "Enter non-negative numbers"
      : formData.minSecondsSinceLaunch > formData.maxSecondsSinceLaunch
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

  const handleSave = async () => {
    if (maxTokenAgeError || launchWindowError || maxTotalTradesError) return;
    setSaving(true);
    try {
      await updateGlobalSettings({
        minMarketCapSol: formData.minMarketCapSol,
        maxMarketCapSol: formData.maxMarketCapSol,
        takeProfitPct: formData.takeProfitPct / 100,
        stopLossPct: formData.stopLossPct / 100,
        maxTokenAgeSeconds,
        minSecondsSinceLaunch: formData.minSecondsSinceLaunch,
        maxSecondsSinceLaunch: formData.maxSecondsSinceLaunch,
        minTokenScore: formData.minTokenScore,
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
                  Max Token Age
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={formData.maxTokenAgeValue}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxTokenAgeValue: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    step="any"
                  />
                  <select
                    value={formData.maxTokenAgeUnit}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxTokenAgeUnit: e.target.value as TokenAgeUnit,
                      })
                    }
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="seconds">Seconds</option>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                  </select>
                </div>
                {maxTokenAgeError ? (
                  <p className="text-xs text-red-500 mt-1">{maxTokenAgeError}</p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    Only tokens {formData.maxTokenAgeValue}{" "}
                    {formData.maxTokenAgeUnit} old or newer are considered
                  </p>
                )}
              </div>

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
                  <p className="text-xs text-red-500 mt-1">{launchWindowError}</p>
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
                  Min Token Score (0-100)
                </label>
                <input
                  type="number"
                  value={formData.minTokenScore}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      minTokenScore: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="0"
                  max="100"
                  step="5"
                />
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
                !!maxTokenAgeError ||
                !!launchWindowError ||
                !!maxTotalTradesError
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