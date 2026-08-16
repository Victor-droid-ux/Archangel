// frontend/hooks/useTraderConfig.ts
"use client";
import { useEffect, useState } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { socket } from "@lib/socket";
import { useWallet } from "./useWallet";
import { ENV } from "@lib/constant";
import { signWalletAuth } from "@lib/walletAuth";

export interface TraderConfig {
  walletAddress: string;
  globalSettings: {
    minMarketCapSol?: number;
    maxMarketCapSol?: number;
    minMarketCapUsd?: number;
    maxMarketCapUsd?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    /** @deprecated use maxTokenAgeSeconds */
    maxTokenAgeHours?: number;
    maxTokenAgeSeconds?: number;
    minSecondsSinceLaunch?: number;
    maxSecondsSinceLaunch?: number;
    minTokenScore?: number;
    autoTradeEnabled?: boolean;
    maxTradeAmountSol?: number;
    // null explicitly clears a previously-set cap (unlimited); undefined
    // just means "not included in this update".
    maxTotalTrades?: number | null;
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
  // How many trades this wallet has taken so far — added by the GET route
  // alongside the stored config, not itself a stored field.
  tradesTaken?: number;
}

export function useTraderConfig() {
  const { publicKey } = useWallet();
  const { signMessage } = useSolanaWallet();
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
      const auth = await signWalletAuth(signMessage, walletAddress);
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/global`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...settings, ...auth }),
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
      const auth = await signWalletAuth(signMessage, walletAddress);
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...tokenConfig, ...auth }),
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
      const auth = await signWalletAuth(signMessage, walletAddress);
      const qs = new URLSearchParams({
        walletAuthTimestamp: String(auth.walletAuthTimestamp),
        walletAuthSignature: auth.walletAuthSignature,
      });
      const response = await fetch(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}?${qs}`,
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
