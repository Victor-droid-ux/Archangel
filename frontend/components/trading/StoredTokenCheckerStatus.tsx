// frontend/components/trading/StoredTokenCheckerStatus.tsx
"use client";

import React from "react";
import { Card } from "@components/ui/card";
import { useStoredTokenChecker } from "@hooks/useStoredTokenChecker";
import { Clock, CheckCircle, Database } from "lucide-react";

export function StoredTokenCheckerStatus() {
  const { status, qualifiedTokens, totalQualified, isActive } =
    useStoredTokenChecker();

  if (!status) {
    return (
      <Card className="p-3 bg-gray-900/50 border-gray-700">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Database className="h-4 w-4" />
          <span>Stored Token Checker: Initializing...</span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-3 bg-gray-900/50 border-gray-700">
      <div className="space-y-2">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-gray-200">
              Stored Token Checker
            </span>
          </div>
          <div className="flex items-center gap-1">
            {isActive && (
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs text-primary">Checking...</span>
              </div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-800/50 rounded p-2">
            <div className="flex items-center gap-1.5 text-gray-400 text-xs mb-1">
              <Clock className="h-3 w-3" />
              <span>Checked</span>
            </div>
            <div className="text-lg font-semibold text-gray-200">
              {status.totalChecked}
            </div>
          </div>

          <div className="bg-gray-800/50 rounded p-2">
            <div className="flex items-center gap-1.5 text-gray-400 text-xs mb-1">
              <CheckCircle className="h-3 w-3" />
              <span>Qualified</span>
            </div>
            <div className="text-lg font-semibold text-green-400">
              {status.qualified}
            </div>
          </div>

          <div className="bg-gray-800/50 rounded p-2">
            <div className="flex items-center gap-1.5 text-gray-400 text-xs mb-1">
              <CheckCircle className="h-3 w-3" />
              <span>Total</span>
            </div>
            <div className="text-lg font-semibold text-primary">
              {totalQualified}
            </div>
          </div>
        </div>

        {/* Recent Qualified Tokens */}
        {qualifiedTokens.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-xs text-gray-400 font-medium">
              Recent Qualifications:
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {qualifiedTokens.slice(0, 5).map((token, idx) => (
                <div
                  key={`${token.token.mint}-${idx}`}
                  className="bg-gray-800/30 rounded p-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-200">
                      {token.token.symbol}
                    </span>
                    <span className="text-green-400">
                      {token.validation.liquiditySol.toFixed(2)} SOL
                    </span>
                  </div>
                  <div className="text-gray-500 text-[10px] mt-0.5">
                    {token.token.mint.slice(0, 8)}...
                    {token.token.mint.slice(-4)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
