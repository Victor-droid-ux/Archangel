"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";
import { fetcher } from "@lib/utils";

interface JupiterLiquidityMetrics {
  exists: boolean;
  liquiditySOL: number;
  liquidityUSD: number;
  mcapUSD: number;
  holderCount: number;
  poolAddress?: string;
  meetsMinimumLiquidity: boolean;
}

interface SafetyChecks {
  canSell: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  firstThreeCandlesValid: boolean;
  lpRemovable: boolean;
  allChecksPassed: boolean;
}

export interface TradeValidationResult {
  mint: string;
  approved: boolean;
  jupiterMetrics: JupiterLiquidityMetrics;
  condition1Passed: boolean;
  safetyChecks: SafetyChecks;
  condition2Passed: boolean;
  recommendation: "BUY" | "IGNORE";
  reason: string;
  timestamp: number;
}

export function useValidation(tokenMint?: string) {
  const { socket, connected } = useSocket();
  const [validation, setValidation] = useState<TradeValidationResult | null>(
    null
  );
  const [isValidating, setIsValidating] = useState(false);

  useEffect(() => {
    if (!socket || !connected) return;

    // Listen for validation results from auto-buyer
    const handleValidationResult = (result: TradeValidationResult) => {
      // If we're watching a specific token, filter for it
      if (!tokenMint || result.mint === tokenMint) {
        setValidation(result);
        setIsValidating(false);
      }
    };

    socket.on("validationResult", handleValidationResult);

    return () => {
      socket.off("validationResult", handleValidationResult);
    };
  }, [socket, connected, tokenMint]);

  const validateToken = async (mint: string) => {
    setIsValidating(true);
    try {
      // A bare fetch() here resolves against the Next.js app's own origin,
      // not the Express backend — fetcher() applies the same
      // NEXT_PUBLIC_BACKEND_URL prefix every other API call in the app uses.
      const data = await fetcher("/api/trade/validate", {
        method: "POST",
        body: JSON.stringify({ tokenMint: mint }),
      });
      if (data.success && data.validation) {
        setValidation(data.validation);
      }
    } catch (error) {
      console.error("Validation error:", error);
    } finally {
      setIsValidating(false);
    }
  };

  return {
    validation,
    isValidating,
    validateToken,
  };
}
