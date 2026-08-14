"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet } from "./useWallet";
import { fetcher } from "@lib/utils";

interface RiskCalculation {
  balance: number;
  riskPercent: number;
  riskAmount: number;
  amountLamports: number;
  recommendation: {
    conservative: number;
    moderate: number;
    aggressive: number;
  };
}

interface UseRiskManagementReturn {
  riskPercent: number;
  riskAmount: number;
  setRiskPercent: (percent: number) => void;
  setRiskAmount: (amount: number) => void;
  calculateRisk: () => Promise<RiskCalculation | null>;
  tradeAmountLamports: number;
  isCalculating: boolean;
  recommendation: RiskCalculation["recommendation"] | null;
}

export const useRiskManagement = (): UseRiskManagementReturn => {
  const { balance } = useWallet();
  const [riskPercent, setRiskPercentState] = useState<number>(1); // Default 1%
  const [riskAmount, setRiskAmountState] = useState<number>(0);
  const [tradeAmountLamports, setTradeAmountLamports] = useState<number>(0);
  const [isCalculating, setIsCalculating] = useState(false);
  const [recommendation, setRecommendation] = useState<
    RiskCalculation["recommendation"] | null
  >(null);

  // Calculate risk from backend
  const calculateRisk =
    useCallback(async (): Promise<RiskCalculation | null> => {
      if (balance <= 0) {
        console.warn("Cannot calculate risk: balance is 0");
        return null;
      }

      setIsCalculating(true);

      try {
        const result = await fetcher("/api/trade/calculate-risk", {
          method: "POST",
          body: JSON.stringify({
            balance,
            riskPercent: riskPercent > 0 ? riskPercent : undefined,
            riskAmount: riskAmount > 0 ? riskAmount : undefined,
          }),
        });

        if (result.success && result.data) {
          const calc: RiskCalculation = result.data;

          // Update state with calculated values
          setRiskPercentState(calc.riskPercent);
          setRiskAmountState(calc.riskAmount);
          setTradeAmountLamports(calc.amountLamports);
          setRecommendation(calc.recommendation);

          console.log("✅ Risk calculated:", {
            percent: calc.riskPercent,
            amount: calc.riskAmount,
            lamports: calc.amountLamports,
          });

          return calc;
        }

        return null;
      } catch (err) {
        console.error("Failed to calculate risk:", err);
        return null;
      } finally {
        setIsCalculating(false);
      }
    }, [balance, riskPercent, riskAmount]);

  // Auto-calculate when balance or risk parameters change
  useEffect(() => {
    if (balance > 0) {
      calculateRisk();
    }
  }, [balance, riskPercent, riskAmount, calculateRisk]);

  // Setters with validation
  const setRiskPercent = useCallback((percent: number) => {
    const validated = Math.max(0.1, Math.min(100, percent));
    setRiskPercentState(validated);
    // Clear risk amount when setting percent
    setRiskAmountState(0);
  }, []);

  const setRiskAmount = useCallback((amount: number) => {
    const validated = Math.max(0, amount);
    setRiskAmountState(validated);
    // Clear risk percent when setting amount
    setRiskPercentState(0);
  }, []);

  return {
    riskPercent,
    riskAmount,
    setRiskPercent,
    setRiskAmount,
    calculateRisk,
    tradeAmountLamports,
    isCalculating,
    recommendation,
  };
};
