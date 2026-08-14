"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import { useWallet } from "@hooks/useWallet";
import { fetcher } from "@lib/utils";

interface ManualBuyParams {
  tokenMint: string;
  amountSol: number;
  slippage?: number;
}

interface ManualBuyResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  pricePerToken?: number;
  error?: string;
}

export const useManualBuy = () => {
  const { publicKey, connected } = useWallet();
  const [loading, setLoading] = useState(false);

  /**
   * Execute manual buy with NO VALIDATIONS
   * User assumes all risk - no liquidity, authority, tax, or price impact checks
   */
  const executeManualBuy = async (
    params: ManualBuyParams
  ): Promise<ManualBuyResult | null> => {
    if (!connected || !publicKey) {
      toast.error("Connect your wallet to trade.");
      return null;
    }

    const { tokenMint, amountSol, slippage } = params;

    setLoading(true);
    toast.loading(`⚠️ Manual buy: ${amountSol} SOL (NO SAFETY CHECKS)`, {
      id: "manual-buy",
    });

    try {
      const response = await fetcher("/api/trade/manual-buy", {
        method: "POST",
        body: JSON.stringify({
          tokenMint,
          amountSol,
          slippage,
          wallet: publicKey,
        }),
      });

      if (!response.success) {
        throw new Error(response.message || "Manual buy failed");
      }

      const result = response.data;

      toast.success(
        `✅ Manual buy successful!\n${
          result.tokensReceived?.toFixed(4) || "N/A"
        } tokens`,
        { id: "manual-buy", duration: 5000 }
      );

      return result;
    } catch (error: any) {
      const errorMsg = error.message || "Manual buy failed";
      toast.error(`❌ ${errorMsg}`, { id: "manual-buy", duration: 5000 });
      return { success: false, error: errorMsg };
    } finally {
      setLoading(false);
    }
  };

  return {
    executeManualBuy,
    loading,
  };
};
