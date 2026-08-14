// frontend/hooks/useTraderConfig.ts
"use client";
import { useEffect, useState } from "react";
import { socket } from "@lib/socket";
import { useWallet } from "./useWallet";
import { ENV } from "@lib/constant";

export interface TraderConfig {
  walletAddress: string;
  globalSettings: {
    minMarketCapSol?: number;
    maxMarketCapSol?: number;
    minMarketCapUsd?: number;
    maxMarketCapUsd?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    maxTokenAgeHours?: number;
    minTokenScore?: number;
    autoTradeEnabled?: boolean;
    maxTradeAmountSol?: number;
  };
  tokenSpecificSettings: {
    [mint: string]: {
      minMarketCapSol?: number;
      maxMarketCapSol?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      entryPriceSol?: number;
      triggerMarketCapSol?: number;
      autoTrade?: boolean;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

export function useTraderConfig() {
  const { publicKey } = useWallet();
  const [config, setConfig] = useState<TraderConfig | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch config when wallet connects
  useEffect(() => {
    if (!publicKey) {
      setConfig(null);
      return;
    }

    const walletAddress = publicKey;

    setLoading(true);
    fetch(`${ENV.API_BASE_URL}/trader-config/${walletAddress}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setConfig(data.config);
        }
      })
      .catch((err) => console.error("Failed to fetch trader config:", err))
      .finally(() => setLoading(false));

    // Listen for config updates. Named handler + matching off() below: this
    // hook is used by two separate modals (trader-config-modal.tsx,
    // token-config-modal.tsx), and an unqualified socket.off("traderConfig:updated")
    // would strip the other modal's still-mounted listener too.
    const handleConfigUpdate = (updatedConfig: TraderConfig) => {
      if (updatedConfig.walletAddress === walletAddress) {
        setConfig(updatedConfig);
      }
    };
    socket.on("traderConfig:updated", handleConfigUpdate);

    return () => {
      socket.off("traderConfig:updated", handleConfigUpdate);
    };
  }, [publicKey]);

  // Update global settings
  const updateGlobalSettings = async (
    settings: TraderConfig["globalSettings"]
  ) => {
    if (!publicKey) return null;

    const walletAddress = publicKey;

    try {
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/global`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        }
      );

      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
        return data.config;
      }
      return null;
    } catch (err) {
      console.error("Failed to update global settings:", err);
      return null;
    }
  };

  // Set token-specific configuration
  const setTokenConfig = async (
    mint: string,
    tokenConfig: TraderConfig["tokenSpecificSettings"][string]
  ) => {
    if (!publicKey) return null;

    const walletAddress = publicKey;

    try {
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tokenConfig),
        }
      );

      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
        return data.config;
      }
      return null;
    } catch (err) {
      console.error("Failed to set token config:", err);
      return null;
    }
  };

  // Remove token-specific configuration
  const removeTokenConfig = async (mint: string) => {
    if (!publicKey) return null;

    const walletAddress = publicKey;

    try {
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
        return data.config;
      }
      return null;
    } catch (err) {
      console.error("Failed to remove token config:", err);
      return null;
    }
  };

  // Get effective config for a token
  const getEffectiveConfig = async (mint: string) => {
    if (!publicKey) return null;

    const walletAddress = publicKey;

    try {
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/effective/${mint}`
      );

      const data = await response.json();
      if (data.success) {
        return data.config;
      }
      return null;
    } catch (err) {
      console.error("Failed to get effective config:", err);
      return null;
    }
  };

  return {
    config,
    loading,
    updateGlobalSettings,
    setTokenConfig,
    removeTokenConfig,
    getEffectiveConfig,
  };
}
