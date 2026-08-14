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
    takeProfitPct: 10,
    stopLossPct: 2,
    maxTokenAgeHours: 24,
    minTokenScore: 30,
    autoTradeEnabled: false,
    maxTradeAmountSol: 1,
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config?.globalSettings) {
      setFormData({
        minMarketCapSol: config.globalSettings.minMarketCapSol ?? 5,
        maxMarketCapSol: config.globalSettings.maxMarketCapSol ?? 1000000,
        takeProfitPct: (config.globalSettings.takeProfitPct ?? 0.1) * 100,
        stopLossPct: (config.globalSettings.stopLossPct ?? 0.02) * 100,
        maxTokenAgeHours: config.globalSettings.maxTokenAgeHours ?? 24,
        minTokenScore: config.globalSettings.minTokenScore ?? 30,
        autoTradeEnabled: config.globalSettings.autoTradeEnabled ?? false,
        maxTradeAmountSol: config.globalSettings.maxTradeAmountSol ?? 1,
      });
    }
  }, [config]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateGlobalSettings({
        minMarketCapSol: formData.minMarketCapSol,
        maxMarketCapSol: formData.maxMarketCapSol,
        takeProfitPct: formData.takeProfitPct / 100,
        stopLossPct: formData.stopLossPct / 100,
        maxTokenAgeHours: formData.maxTokenAgeHours,
        minTokenScore: formData.minTokenScore,
        autoTradeEnabled: formData.autoTradeEnabled,
        maxTradeAmountSol: formData.maxTradeAmountSol,
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
                  Max Token Age (hours)
                </label>
                <input
                  type="number"
                  value={formData.maxTokenAgeHours}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      maxTokenAgeHours: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  min="1"
                  step="1"
                />
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
              disabled={saving || loading}
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