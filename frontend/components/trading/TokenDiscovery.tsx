"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatNumber, formatPrice } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";
import { useJupiterEvents } from "@hooks/useJupiterEvents";
import {
  Loader2,
  CheckCircle,
  XCircle,
  TrendingUp,
  ShoppingCart,
} from "lucide-react";

type TokenItem = {
  symbol: string;
  name?: string;
  mint?: string;
  price: number;
  pnl?: number;
  liquidity?: number;
  marketCap?: number;
};

type TokensResponse = {
  success: boolean;
  tokens: TokenItem[];
};

export const TokenDiscovery: React.FC = () => {
  const router = useRouter();
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(true);

  const { lastMessage, connected } = useSocket();
  const {
    validationsPassed,
    validationsFailed,
    pipelineFailed,
    pipelineSuccess,
    latestValidated,
    latestPipelineSuccess,
    latestPipelineFailed,
  } = useJupiterEvents();

  // Manual buys skip all validation, so any token that failed auto-buy
  // criteria is still available for the user to buy at their own discretion.
  const manualBuyTokens = validationsFailed;

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetcher<TokensResponse>("/api/tokens");
      if (res?.success && Array.isArray(res.tokens)) {
        setTokens(res.tokens);
      }
    } catch (err) {
      console.warn("❌ Failed to load tokens:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
    const interval = setInterval(loadTokens, 10000);
    return () => clearInterval(interval);
  }, [loadTokens]);

  // 🔄 Live updates from websocket
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.event !== "token_prices") return;
    const payload = lastMessage.payload;
    if (!Array.isArray(payload?.tokens)) return;

    setTokens(payload.tokens);
  }, [lastMessage]);

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4 flex flex-col max-h-[900px]">
      <CardHeader className="flex items-center justify-between flex-shrink-0">
        <CardTitle className="text-lg font-semibold text-primary">
          New Token Discovery
        </CardTitle>

        <div
          className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}
        >
          {connected ? "Live" : "Offline"}
        </div>
      </CardHeader>

      <CardContent className="overflow-y-auto flex-1 pr-2">
        {/* Live Activity Feed */}
        <div className="mb-4 space-y-2 max-h-[300px] overflow-y-auto pr-2">
          {/* Show latest pipeline success (validation pipeline passed + bought) */}
          {latestPipelineSuccess && (
            <div className="flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-400">🚀 Pipeline Success:</span>
              <code className="text-gray-300">
                {latestPipelineSuccess.mint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                (
                {latestPipelineSuccess.tokensReceived != null
                  ? latestPipelineSuccess.tokensReceived.toFixed(0)
                  : "?"}{" "}
                tokens @{" "}
                {latestPipelineSuccess.actualPrice != null
                  ? latestPipelineSuccess.actualPrice.toFixed(6)
                  : "?"}{" "}
                SOL)
              </span>
              <a
                href={`https://solscan.io/tx/${latestPipelineSuccess.signature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Tx
              </a>
            </div>
          )}

          {/* Show latest pipeline failed */}
          {latestPipelineFailed && (
            <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs">
              <XCircle className="w-4 h-4 text-red-400" />
              <span className="text-red-400">
                ❌ Stage {latestPipelineFailed.failedStage} Failed:
              </span>
              <code className="text-gray-300">
                {latestPipelineFailed.mint.slice(0, 8)}...
              </code>
              <span className="text-orange-300 text-xs">
                {latestPipelineFailed.failedStageName} -{" "}
                {latestPipelineFailed.reason}
              </span>
            </div>
          )}

          {/* Show latest validation passed (auto-buy eligible) */}
          {latestValidated && (
            <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-400">✅ Auto-Buy Eligible:</span>
              <code className="text-gray-300">
                {latestValidated.mint.slice(0, 8)}...
              </code>
            </div>
          )}

          {/* Show latest validation failure (still available for manual buy) */}
          {validationsFailed[0] && (
            <div className="flex items-center gap-2 p-2 bg-orange-500/10 border border-orange-500/20 rounded text-xs">
              <TrendingUp className="w-4 h-4 text-orange-400" />
              <span className="text-orange-400">📊 Manual Buy Available:</span>
              <code className="text-gray-300">
                {validationsFailed[0].mint.slice(0, 8)}...
              </code>
              <span className="text-xs text-orange-300">
                - {validationsFailed[0].reason}
              </span>
            </div>
          )}
        </div>

        {/* Tokens that failed the bot's own validation are listed for
            visibility (why the bot passed on them) but are intentionally
            not buyable from here — the manual Buy flow (/trading/buy) only
            ever offers tokens that cleared the same safety checks the bot
            itself requires, on purpose (see trade.route.ts's buy-time
            re-validation). A "buy anyway" path here used to exist but
            always signed with the operator's own wallet regardless of who
            was connected — a real fund-misattribution bug, not a shortcut
            worth keeping. */}
        {manualBuyTokens.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4" />
              Failed Auto-Buy Validation ({manualBuyTokens.length})
            </h3>
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
              {manualBuyTokens.slice(0, 20).map((token) => (
                <div
                  key={token.mint}
                  className="flex items-center justify-between p-3 bg-orange-500/5 border border-orange-500/20 rounded"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-gray-300">
                        {token.mint.slice(0, 12)}...
                      </code>
                    </div>
                    <div className="text-xs text-orange-300 mt-1">
                      {token.reason}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token List */}
        {loading ? (
          <div className="flex items-center gap-2 py-6">
            <Loader2 className="animate-spin" />
            <span className="text-sm text-gray-400">Loading tokens...</span>
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-gray-400 py-4">
            No tokens tracked yet. Validated pools will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-base-300">
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-base-200 z-10">
                  <tr className="text-left text-gray-400 border-b border-base-300">
                    <th className="py-2 px-4">Token</th>
                    <th className="py-2 px-4 text-right">Price (SOL)</th>
                    <th className="py-2 px-4 text-right">Liquidity</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr
                      key={t.mint || t.symbol}
                      onClick={() =>
                        t.mint && router.push(`/trading/buy?mint=${t.mint}`)
                      }
                      className={`border-b border-base-300 hover:bg-base-300/20 transition ${
                        t.mint ? "cursor-pointer" : ""
                      }`}
                      title={t.mint ? "Buy this token" : undefined}
                    >
                      <td className="py-2 px-4 font-medium">
                        {t.name ?? t.symbol}{" "}
                        <span className="text-xs opacity-60">({t.symbol})</span>
                      </td>

                      <td className="py-2 px-4 text-right">
                        {formatPrice(t.price ?? 0)}
                      </td>

                      <td className="py-2 px-4 text-right">
                        {t.liquidity ? formatNumber(t.liquidity) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TokenDiscovery;
