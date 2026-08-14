// frontend/hooks/useStoredTokenChecker.tsx
import { useState, useEffect } from "react";
import { useSocket } from "./useSocket";

interface StoredTokenCheckerStatus {
  timestamp: string;
  totalChecked: number;
  qualified: number;
  isChecking: boolean;
}

interface QualifiedToken {
  timestamp: string;
  token: {
    mint: string;
    symbol: string;
    name: string;
    poolId: string;
  };
  validation: {
    liquiditySol: number;
    isValid: boolean;
  };
}

export function useStoredTokenChecker() {
  const { lastMessage } = useSocket();
  const [status, setStatus] = useState<StoredTokenCheckerStatus | null>(null);
  const [qualifiedTokens, setQualifiedTokens] = useState<QualifiedToken[]>([]);
  const [totalQualified, setTotalQualified] = useState(0);

  useEffect(() => {
    if (!lastMessage) return;

    // Listen for status updates
    if (lastMessage.event === "storedTokenChecker:status") {
      setStatus(lastMessage.payload);
    }

    // Listen for qualified tokens
    if (lastMessage.event === "storedTokenChecker:qualified") {
      setQualifiedTokens((prev) => [lastMessage.payload, ...prev].slice(0, 50)); // Keep last 50
      setTotalQualified((prev) => prev + 1);
    }
  }, [lastMessage]);

  return {
    status,
    qualifiedTokens,
    totalQualified,
    isActive: status?.isChecking || false,
  };
}
