"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { useWallet } from "@hooks/useWallet";
import { useRiskManagement } from "@hooks/useRiskManagement";
import { TrendingUp, AlertTriangle, Shield } from "lucide-react";

interface RiskManagementPanelProps {
  onAmountChange?: (amount: number, lamports: number) => void;
}

export const RiskManagementPanel: React.FC<RiskManagementPanelProps> = ({
  onAmountChange,
}) => {
  const { balance, connected } = useWallet();
  const {
    riskPercent,
    riskAmount,
    setRiskPercent,
    setRiskAmount,
    tradeAmountLamports,
    recommendation,
  } = useRiskManagement();

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
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-400" />
          Risk Management
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Wallet Balance Display */}
        <div className="p-3 bg-base-300 rounded-lg">
          <div className="text-sm text-gray-400 mb-1">Wallet Balance</div>
          <div className="text-2xl font-bold text-primary">
            {connected ? (
              `${balance.toFixed(4)} SOL`
            ) : (
              <span className="text-gray-500 text-base">Connect Wallet</span>
            )}
          </div>
        </div>

        {/* Risk Input Options */}
        <div className="space-y-3">
          <div>
            <label className="text-sm text-gray-400 mb-2 block">
              Risk Percentage
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={riskPercent || ""}
                onChange={(e) => setRiskPercent(Number(e.target.value))}
                className="flex-1 px-3 py-2 bg-base-300 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Enter %"
              />
              <span className="flex items-center px-3 bg-base-300 rounded-lg text-gray-400">
                %
              </span>
            </div>
          </div>

          <div className="text-center text-gray-500 text-sm">OR</div>

          <div>
            <label className="text-sm text-gray-400 mb-2 block">
              Fixed Amount
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0.001"
                max={balance}
                step="0.001"
                value={riskAmount || ""}
                onChange={(e) => setRiskAmount(Number(e.target.value))}
                className="flex-1 px-3 py-2 bg-base-300 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Enter amount"
              />
              <span className="flex items-center px-3 bg-base-300 rounded-lg text-gray-400">
                SOL
              </span>
            </div>
          </div>
        </div>

        {/* Quick Presets */}
        {recommendation && (
          <div>
            <div className="text-sm text-gray-400 mb-2">Quick Presets</div>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => handlePresetClick("conservative")}
                className="px-3 py-2 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg transition-colors"
              >
                Conservative
                <div className="text-xs opacity-75">
                  {recommendation.conservative.toFixed(3)} SOL
                </div>
              </button>
              <button
                onClick={() => handlePresetClick("moderate")}
                className="px-3 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-xs rounded-lg transition-colors"
              >
                Moderate
                <div className="text-xs opacity-75">
                  {recommendation.moderate.toFixed(3)} SOL
                </div>
              </button>
              <button
                onClick={() => handlePresetClick("aggressive")}
                className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg transition-colors"
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
          <div className="p-3 bg-base-300 rounded-lg border border-primary/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Trade Amount</span>
              <span className="text-lg font-bold text-primary">
                {riskAmount.toFixed(4)} SOL
              </span>
            </div>
            <div className="flex items-center justify-between mb-2">
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

        {/* Risk Warning */}
        {riskPercent > 10 && (
          <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-500/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-red-300">
              <strong>High Risk Warning:</strong> Trading more than 10% of your
              balance per trade significantly increases your risk of loss.
              Consider reducing your position size.
            </div>
          </div>
        )}

        {/* Info */}
        <div className="flex items-start gap-2 p-3 bg-blue-900/20 border border-blue-500/30 rounded-lg">
          <TrendingUp className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-300">
            Risk management helps you control position sizing. Set either a
            percentage of your balance or a fixed amount per trade.
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
