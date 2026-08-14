"use client";

import React, { useEffect } from "react";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { toast } from "react-hot-toast";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";

export const TradingConfigPanel = () => {
  const {
    amount,
    slippage,
    takeProfit,
    stopLoss,
    autoTrade,
    dexRoute,
    setAmount,
    setSlippage,
    setTakeProfit,
    setStopLoss,
    setAutoTrade,
    setDexRoute,
    saveConfig,
    syncConfig,
    loadConfig,
    loadConfigFromAPI,
  } = useTradingConfigStore();

  const { publicKey } = useSolanaWallet();

  // Local config first (fast, always available), then reconcile with this
  // wallet's cloud-saved settings once it's connected — cloud wins for a
  // returning wallet since that's the source of truth across devices.
  useEffect(() => {
    loadConfig?.();
  }, [loadConfig]);

  useEffect(() => {
    if (publicKey) {
      loadConfigFromAPI?.(publicKey.toString());
    }
  }, [publicKey, loadConfigFromAPI]);

  const handleSave = async () => {
    try {
      saveConfig?.();
      if (publicKey) {
        await syncConfig?.(publicKey.toString());
        toast.success("✅ Configuration saved & synced successfully!");
      } else {
        toast.success("✅ Configuration saved locally.");
      }
    } catch (error) {
      toast.error("❌ Failed to save configuration.");
      console.error(error);
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

  return (
    <div className="bg-base-200 border border-base-300 rounded-xl p-6 space-y-4 shadow-md">
      <h2 className="text-xl font-semibold text-primary mb-2">
        Trading Configuration
      </h2>

      {/* Trade Amount */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Trade Amount (SOL)</label>
        <Input
          type="number"
          min={0}
          step={0.01}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          placeholder="Enter trade amount"
        />
      </div>

      {/* Slippage */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Slippage (%)</label>
        <Input
          type="number"
          min={0.1}
          step={0.1}
          value={slippage}
          onChange={(e) => setSlippage(Number(e.target.value))}
          placeholder="2"
        />
      </div>

      {/* Take Profit */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Take Profit (%)</label>
        <Input
          type="number"
          min={0}
          value={takeProfit}
          onChange={(e) => setTakeProfit(Number(e.target.value))}
          placeholder="10"
        />
      </div>

      {/* Stop Loss */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Stop Loss (%)</label>
        <Input
          type="number"
          min={0}
          value={stopLoss}
          onChange={(e) => setStopLoss(Number(e.target.value))}
          placeholder="5"
        />
      </div>

      {/* DEX Route — Jupiter is the only execution venue */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">DEX Route</label>
        <div className="select select-bordered w-full flex items-center opacity-70">
          Jupiter
        </div>
      </div>

      {/* Auto Trade */}
      <div className="flex items-center justify-between py-2">
        <span className="text-sm font-medium">Enable Auto Trade</span>
        <Switch checked={autoTrade} onCheckedChange={setAutoTrade} />
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col gap-3 mt-4">
        <Button onClick={handleSave} className="w-full">
          Save & Sync Configuration
        </Button>

        <Button variant="outline" onClick={handleLoadCloud} className="w-full">
          Load Config from Cloud
        </Button>
      </div>
    </div>
  );
};

export default TradingConfigPanel;
