// frontend/hooks/useConfig.ts
import { create } from "zustand";
import { fetcher } from "@lib/utils";

interface TradingConfig {
  amount: number;
  slippage: number;
  takeProfit: number;
  stopLoss: number;
  autoTrade: boolean;
  selectedToken?: string;
  setSelectedToken: (token: string) => void;
  dexRoute: string;
  setAmount: (value: number) => void;
  setSlippage: (value: number) => void;
  setTakeProfit: (value: number) => void;
  setStopLoss: (value: number) => void;
  setAutoTrade: (value: boolean) => void;
  setDexRoute: (value: string) => void;
  saveConfig: () => void;
  loadConfig: () => void;
  syncConfig: (wallet: string) => Promise<void>;
  loadConfigFromAPI: (wallet: string) => Promise<void>;
}

export const useTradingConfigStore = create<TradingConfig>((set, get) => ({
  amount: 0.1,
  slippage: 1,
  takeProfit: 10,
  stopLoss: 2,
  autoTrade: false,
  dexRoute: "Jupiter",
  selectedToken: undefined, // No default - user must select from discovered tokens

  setAmount: (value) => set({ amount: value }),
  setSlippage: (value) => set({ slippage: value }),
  setTakeProfit: (value) => set({ takeProfit: value }),
  setStopLoss: (value) => set({ stopLoss: value }),
  setAutoTrade: (value) => set({ autoTrade: value }),
  setDexRoute: (value) => set({ dexRoute: value }),
  setSelectedToken: (token: string) => set({ selectedToken: token }),

  saveConfig: () => {
    const config = get();
    localStorage.setItem("tradingConfig", JSON.stringify(config));
    console.log("✅ Trading config saved locally:", config);
  },

  loadConfig: () => {
    const saved = localStorage.getItem("tradingConfig");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Migration: Clear old BONK default
        if (parsed.selectedToken === "BONK") {
          parsed.selectedToken = undefined;
        }
        set(parsed);
        console.log("🔁 Loaded saved trading config:", parsed);
      } catch (err) {
        console.error("⚠️ Failed to parse saved config:", err);
      }
    }
  },

  // Persist the data fields (not the store's functions) to the backend for
  // this wallet — real persistence now, see db.service.ts's userSettings
  // collection / user.route.ts (previously a stub that 400'd because wallet
  // was never sent).
  syncConfig: async (wallet: string) => {
    if (!wallet) {
      console.warn("⚠️ No wallet provided to sync config");
      return;
    }
    try {
      const {
        amount,
        slippage,
        takeProfit,
        stopLoss,
        autoTrade,
        dexRoute,
        selectedToken,
      } = get();
      await fetcher("/api/user/settings", {
        method: "POST",
        body: JSON.stringify({
          wallet,
          amount,
          slippage,
          takeProfit,
          stopLoss,
          autoTrade,
          dexRoute,
          selectedToken,
        }),
      });
      console.log("☁️ Synced config to backend");
    } catch (err) {
      console.error("❌ Config sync failed:", err);
    }
  },

  // Load this wallet's saved settings from the backend
  loadConfigFromAPI: async (wallet: string) => {
    try {
      if (!wallet) {
        console.warn("⚠️ No wallet provided to load config");
        return;
      }
      const data = await fetcher<any>(`/api/user/settings?wallet=${wallet}`);
      if (data.success && data.data) {
        const {
          amount,
          slippage,
          takeProfit,
          stopLoss,
          autoTrade,
          dexRoute,
          selectedToken,
        } = data.data;
        set({
          ...(amount != null && { amount }),
          ...(slippage != null && { slippage }),
          ...(takeProfit != null && { takeProfit }),
          ...(stopLoss != null && { stopLoss }),
          ...(autoTrade != null && { autoTrade }),
          ...(dexRoute != null && { dexRoute }),
          ...(selectedToken != null && { selectedToken }),
        });
        console.log("☁️ Loaded config from backend:", data.data);
      }
    } catch (err) {
      console.error("⚠️ Failed to load config from backend:", err);
    }
  },
}));

// Export alias for convenience
export const useConfig = useTradingConfigStore;
