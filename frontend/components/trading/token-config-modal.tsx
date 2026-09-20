// frontend/components/trading/token-config-modal.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { useTrade } from "@hooks/useTrade";
import { useWallet } from "@hooks/useWallet";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useSolPrice } from "@hooks/useSolPrice";
import {
  decimalToPercent,
  percentToDecimal,
  validateTakeProfitStopLoss,
} from "@lib/globalSettings";
import {
  X,
  Target,
  TrendingUp,
  AlertCircle,
  ShoppingCart,
  TrendingDown,
} from "lucide-react";
import { toast } from "react-hot-toast";

interface TokenConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: {
    mint: string;
    symbol: string;
    name?: string;
    currentMarketCapSol?: number;
    priceSol?: number;
  };
}

export function TokenConfigModal({
  isOpen,
  onClose,
  token,
}: TokenConfigModalProps) {
  const { config, setTokenConfig, removeTokenConfig, getEffectiveConfig } =
    useTraderConfig();
  const { executeTrade, loading: tradeLoading } = useTrade();
  const { connected, balance: connectedBalance } = useWallet();
  const solanaWallet = useSolanaWallet();
  const solPriceUsd = useSolPrice();

  // Use Solana wallet adapter connection status as fallback
  const isWalletConnected = connected || solanaWallet.connected;

  // Until the wallet's real settings load, show the backend's own defaults
  // (10% take profit / 30% stop loss). The form used to start at a 2% stop
  // loss, which the backend deliberately moved away from — a tight stop like
  // that stops a volatile new token out almost immediately.
  const [formData, setFormData] = useState({
    triggerMarketCapSol: 0,
    takeProfitPct: 10,
    stopLossPct: 30,
    useCustomConfig: false,
  });
  // Manual Buy/Sell Now spends from the connected wallet, so it needs its own
  // amount — it can't borrow one from the auto-trade settings (those split the
  // TRADING wallet's balance across open positions and have no SOL amount).
  const [tradeAmountSol, setTradeAmountSol] = useState(0.1);

  const [effectiveConfig, setEffectiveConfig] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  // True once the user has edited take profit / stop loss, so the effective
  // config arriving late doesn't overwrite their typing.
  const exitEdited = useRef(false);

  useEffect(() => {
    if (!(isOpen && token.mint)) return;
    let cancelled = false;
    exitEdited.current = false;

    // Load existing token config
    const tokenConfig = config?.tokenSpecificSettings?.[token.mint];
    setFormData((prev) => ({
      ...prev,
      triggerMarketCapSol:
        tokenConfig?.triggerMarketCapSol ?? token.currentMarketCapSol ?? 0,
      useCustomConfig: !!tokenConfig,
    }));

    // Load effective config (what will actually be used: token > global >
    // defaults) and start the fields from THAT, not from hard-coded numbers.
    getEffectiveConfig(token.mint).then((cfg: any) => {
      if (cancelled) return;
      setEffectiveConfig(cfg);
      if (cfg && !exitEdited.current) {
        setFormData((prev) => ({
          ...prev,
          takeProfitPct: decimalToPercent(cfg.takeProfitPct),
          stopLossPct: decimalToPercent(cfg.stopLossPct),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, token.mint]);

  const exitErrors = formData.useCustomConfig
    ? validateTakeProfitStopLoss(formData.takeProfitPct, formData.stopLossPct)
    : {};

  /** Saves the per-token settings. Resolves true only if they were saved. */
  const handleSave = async (): Promise<boolean> => {
    if (
      formData.useCustomConfig &&
      (exitErrors.takeProfitPct || exitErrors.stopLossPct)
    ) {
      toast.error(
        exitErrors.takeProfitPct ||
          exitErrors.stopLossPct ||
          "Invalid exit settings"
      );
      return false;
    }
    setSaving(true);
    try {
      if (!formData.useCustomConfig) {
        // Remove custom config, use global defaults
        await removeTokenConfig(token.mint);
      } else {
        // Save custom config
        await setTokenConfig(token.mint, {
          triggerMarketCapSol: formData.triggerMarketCapSol || undefined,
          takeProfitPct: percentToDecimal(formData.takeProfitPct),
          stopLossPct: percentToDecimal(formData.stopLossPct),
        });
      }
      toast.success("Configuration saved!");
      return true;
    } catch (err: any) {
      console.error("Failed to save token config:", err);
      toast.error(err?.message || "Failed to save configuration");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleTrade = async (type: "buy" | "sell") => {
    if (!isWalletConnected) {
      toast.error("Please connect your wallet first");
      return;
    }

    if (!Number.isFinite(tradeAmountSol) || tradeAmountSol <= 0) {
      toast.error("Enter an amount in SOL greater than 0.");
      return;
    }
    if (type === "buy" && tradeAmountSol > connectedBalance) {
      toast.error(
        `Your connected wallet has ${connectedBalance.toFixed(4)} SOL — not enough for a ${tradeAmountSol} SOL buy.`
      );
      return;
    }

    try {
      // Check if trigger MC condition is met (only for buy)
      if (type === "buy" && formData.triggerMarketCapSol > 0) {
        const currentMC = token.currentMarketCapSol ?? 0;
        if (currentMC < formData.triggerMarketCapSol) {
          toast.error(
            `Market cap (${currentMC.toFixed(
              2
            )} SOL) has not reached trigger (${
              formData.triggerMarketCapSol
            } SOL)`
          );
          return;
        }
      }

      // Save config first if custom config is enabled — and don't trade on
      // settings that failed to save.
      if (formData.useCustomConfig) {
        const saved = await handleSave();
        if (!saved) return;
      }

      const amountLamports = Math.floor(tradeAmountSol * 1e9);
      const result = await executeTrade(type, token.mint, amountLamports);

      if (result) {
        toast.success(`${type === "buy" ? "Bought" : "Sold"} ${token.symbol}`);
        onClose();
      }
    } catch (error) {
      console.error("Trade error:", error);
      toast.error(`Failed to execute ${type} trade`);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        // Close if clicking the backdrop
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg max-w-lg w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Wallet Not Connected Warning */}
        {!isWalletConnected && (
          <div className="bg-yellow-900/30 border-b border-yellow-700/50 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-yellow-200 font-semibold text-sm">
                Wallet Not Connected
              </p>
              <p className="text-yellow-300/80 text-xs mt-1">
                Please connect your wallet to enable Buy, Sell, and Auto-Trade
                buttons. Look for the &quot;Connect Wallet&quot; button in the
                top navigation.
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Target className="w-6 h-6 text-purple-400" />
            <div>
              <h2 className="text-xl font-bold text-white">Configure Trade</h2>
              <p className="text-sm text-gray-400">{token.symbol}</p>
            </div>
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
          {/* Current Info */}
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400">Current MC</p>
                <p className="text-white font-semibold">
                  {token.currentMarketCapSol?.toFixed(2) ?? "N/A"} SOL
                </p>
                {solPriceUsd != null && (
                  <p className="text-xs text-gray-500">
                    ~$
                    {(
                      (token.currentMarketCapSol ?? 0) * solPriceUsd
                    ).toLocaleString()}
                  </p>
                )}
              </div>
              <div>
                <p className="text-gray-400">Current Price</p>
                <p className="text-white font-semibold">
                  {token.priceSol?.toFixed(6) ?? "N/A"} SOL
                </p>
              </div>
            </div>
          </div>

          {/* Use Custom Config Toggle */}
          <div className="flex items-center justify-between bg-blue-900/20 border border-blue-800 rounded-lg p-4">
            <div>
              <p className="text-white font-medium">Custom Configuration</p>
              <p className="text-sm text-gray-400">
                Override global settings for this token
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...formData,
                  useCustomConfig: !formData.useCustomConfig,
                })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-gray-900 ${
                formData.useCustomConfig ? "bg-primary" : "bg-gray-700"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  formData.useCustomConfig ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {formData.useCustomConfig && (
            <>
              {/* Trigger Market Cap */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-green-400" />
                  <label className="text-sm font-medium text-gray-300">
                    Trigger Market Cap (SOL) - Optional
                  </label>
                </div>
                <input
                  type="number"
                  value={formData.triggerMarketCapSol}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      triggerMarketCapSol: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="Enter MC to trigger trade"
                  min="0"
                  step="1"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Trade will trigger when MC reaches this value. Leave 0 to
                  trade immediately.
                </p>
                {formData.triggerMarketCapSol > 0 && solPriceUsd != null && (
                  <p className="text-xs text-blue-400 mt-1">
                    ~$
                    {(
                      formData.triggerMarketCapSol * solPriceUsd
                    ).toLocaleString()}
                  </p>
                )}
              </div>

              {/* TP/SL */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Take Profit (%)
                  </label>
                  <input
                    type="number"
                    value={formData.takeProfitPct}
                    onChange={(e) => {
                      exitEdited.current = true;
                      setFormData({
                        ...formData,
                        takeProfitPct: Number(e.target.value),
                      });
                    }}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    max="100"
                    step="1"
                  />
                  {exitErrors.takeProfitPct ? (
                    <p className="text-xs text-red-500 mt-1">
                      {exitErrors.takeProfitPct}
                    </p>
                  ) : (
                    <p className="text-xs text-green-500 mt-1">
                      Exit at +{formData.takeProfitPct}%
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Stop Loss (%)
                  </label>
                  <input
                    type="number"
                    value={formData.stopLossPct}
                    onChange={(e) => {
                      exitEdited.current = true;
                      setFormData({
                        ...formData,
                        stopLossPct: Number(e.target.value),
                      });
                    }}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    max="100"
                    step="0.5"
                  />
                  {exitErrors.stopLossPct ? (
                    <p className="text-xs text-red-500 mt-1">
                      {exitErrors.stopLossPct}
                    </p>
                  ) : (
                    <p className="text-xs text-red-500 mt-1">
                      Exit at -{formData.stopLossPct}%
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Effective Config Preview */}
          {effectiveConfig && (
            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-blue-400" />
                <p className="text-sm font-medium text-gray-300">
                  {formData.useCustomConfig
                    ? "Will Use Custom Settings"
                    : "Will Use Global Settings"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
                <div>
                  TP:{" "}
                  {formData.useCustomConfig
                    ? formData.takeProfitPct
                    : (effectiveConfig.takeProfitPct * 100).toFixed(1)}
                  %
                </div>
                <div>
                  SL:{" "}
                  {formData.useCustomConfig
                    ? formData.stopLossPct
                    : (effectiveConfig.stopLossPct * 100).toFixed(1)}
                  %
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 p-6 border-t border-gray-800 bg-gray-800/50">
          {/* Manual trade amount — spent from the connected wallet */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Amount for Buy / Sell Now (SOL)
            </label>
            <input
              type="number"
              value={tradeAmountSol}
              onChange={(e) => setTradeAmountSol(Number(e.target.value))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
              min="0"
              step="0.01"
            />
            <p className="text-xs text-gray-500 mt-1">
              Manual trades use your connected wallet
              {isWalletConnected ? ` (${connectedBalance.toFixed(4)} SOL)` : ""}
              . Auto-trades use the trading wallet and are sized by Max Open
              Positions in Trading Settings.
            </p>
          </div>

          {/* Trade Action Buttons */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTrade("buy");
              }}
              disabled={saving || tradeLoading || !isWalletConnected}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <ShoppingCart className="w-4 h-4" />
              {tradeLoading ? "Buying..." : "Buy Now"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTrade("sell");
              }}
              disabled={saving || tradeLoading || !isWalletConnected}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <TrendingDown className="w-4 h-4" />
              {tradeLoading ? "Selling..." : "Sell Now"}
            </button>
          </div>

          {/* Save / Close */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
              }}
              disabled={saving || tradeLoading}
              className="flex-1 px-6 py-3 bg-primary hover:bg-primary-hover text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? "Saving..." : "Save Config"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              className="px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors cursor-pointer"
              disabled={saving || tradeLoading}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
