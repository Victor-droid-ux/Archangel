"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";

export interface JupiterTokenDetectedEvent {
  mint: string;
  symbol?: string;
  liquidityUSD: number;
  timestamp: string;
}

export interface JupiterTokenSkippedEvent {
  mint: string;
  reason: string;
  liquidityUSD?: number;
  timestamp: string;
}

export interface JupiterValidationEvent {
  mint: string;
  reason?: string;
  failedFilters?: string[];
  passedFilters?: string[];
  timestamp: string;
}

export interface PipelineFailedEvent {
  mint: string;
  failedStage: number;
  failedStageName: string;
  reason: string;
  results: any[];
  timestamp: string;
}

export interface PipelineSuccessEvent {
  mint: string;
  signature?: string;
  // Backend sources these via optional chaining off executionResult
  // (jupiterDiscovery.service.ts / storedTokenChecker.service.ts), so they
  // can genuinely be undefined even though this event otherwise means "success".
  tokensReceived?: number;
  actualPrice?: number;
  results: any[];
  timestamp: string;
}

export interface PnLUpdate {
  tokenMint: string;
  wallet: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  unrealizedPnL: number;
  percentChange: number;
  priceImpact: number;
  liquidityMovement: number;
  trendDirection: "up" | "down" | "stable";
  timestamp: number;
}

export function useJupiterEvents() {
  const { lastMessage, connected } = useSocket();
  const [tokensDetected, setTokensDetected] = useState<
    JupiterTokenDetectedEvent[]
  >([]);
  const [tokensSkipped, setTokensSkipped] = useState<
    JupiterTokenSkippedEvent[]
  >([]);
  const [validationsPassed, setValidationsPassed] = useState<
    JupiterValidationEvent[]
  >([]);
  const [validationsFailed, setValidationsFailed] = useState<
    JupiterValidationEvent[]
  >([]);
  const [pipelineFailed, setPipelineFailed] = useState<PipelineFailedEvent[]>(
    []
  );
  const [pipelineSuccess, setPipelineSuccess] = useState<
    PipelineSuccessEvent[]
  >([]);
  const [pnlUpdates, setPnlUpdates] = useState<Map<string, PnLUpdate>>(
    new Map()
  );

  useEffect(() => {
    if (!lastMessage) return;

    switch (lastMessage.event) {
      case "jupiter:token_detected":
        setTokensDetected((prev) => [lastMessage.payload, ...prev].slice(0, 50));
        break;

      case "jupiter:token_skipped":
        setTokensSkipped((prev) => [lastMessage.payload, ...prev].slice(0, 100));
        break;

      case "jupiter:validation_passed":
        setValidationsPassed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 20)
        );
        break;

      case "jupiter:validation_failed":
        setValidationsFailed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 50)
        );
        break;

      case "jupiter:pipeline_failed":
        setPipelineFailed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 50)
        );
        break;

      case "jupiter:pipeline_success":
        setPipelineSuccess((prev) =>
          [lastMessage.payload, ...prev].slice(0, 20)
        );
        break;

      case "pnl:update":
        setPnlUpdates((prev) => {
          const updated = new Map(prev);
          updated.set(lastMessage.payload.tokenMint, lastMessage.payload);
          return updated;
        });
        break;
    }
  }, [lastMessage]);

  return {
    connected,
    tokensDetected,
    tokensSkipped,
    validationsPassed,
    validationsFailed,
    pipelineFailed,
    pipelineSuccess,
    pnlUpdates,
    latestValidated: validationsPassed[0],
    latestPipelineSuccess: pipelineSuccess[0],
    latestPipelineFailed: pipelineFailed[0],
    totalTokensSkipped: tokensSkipped.length,
    skipReasons: tokensSkipped.reduce((acc, skip) => {
      acc[skip.reason] = (acc[skip.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
}
