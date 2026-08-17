"use client";

import React, { useEffect, useState, useRef } from "react";
import {
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
  Settings2,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { useSocket } from "@hooks/useSocket";
import { fetcher, formatNumber, formatPrice } from "@lib/utils";
import { TokenConfigModal } from "@components/trading/token-config-modal";

interface Token {
  symbol: string;
  mint: string;
  price?: number;
  priceSol?: number;
  pnl?: number;
  priceChange24h?: number;
  liquidity?: number;
  marketCap?: number;
  marketCapSol?: number;
  name?: string;
  holderCount?: number; // Number of unique holders (0-5 for newly launched)
  // Lifecycle validation fields (Jupiter-only)
  lifecycleStage?: string;
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
}

export const NewTokens = () => {
  const [tokens, setTokens] = useState<Token[]>([]);
  const prev = useRef<Record<string, Token>>({});
  const [flash, setFlash] = useState<Record<string, "up" | "down">>({});
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [lifecycleSummary, setLifecycleSummary] = useState<any>(null);

  const { lastMessage } = useSocket();

  // initial load
  useEffect(() => {
    fetcher("/api/tokens").then((res) => setTokens(res.tokens || []));
  }, []);

  // socket updates
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event !== "tokenFeed") return;

    const incoming = lastMessage.payload.tokens;
    if (!Array.isArray(incoming)) return;

    const flashMap: Record<string, "up" | "down"> = {};

    for (const t of incoming) {
      const prevTok = prev.current[t.symbol];
      const currentPrice = t.price || t.priceSol || 0;
      const prevPrice = prevTok ? prevTok.price || prevTok.priceSol || 0 : 0;

      if (prevTok && currentPrice && prevPrice) {
        if (currentPrice > prevPrice) flashMap[t.symbol] = "up";
        else if (currentPrice < prevPrice) flashMap[t.symbol] = "down";
      }

      prev.current[t.symbol] = t;
    }

    setFlash(flashMap);
    setTimeout(() => setFlash({}), 700);

    setTokens(incoming);

    // Store lifecycle summary if available
    if (lastMessage.payload.lifecycleSummary) {
      setLifecycleSummary(lastMessage.payload.lifecycleSummary);
    }
  }, [lastMessage]);

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex gap-2 text-primary">
          <Sparkles size={18} /> New Tokens
        </CardTitle>
        {lifecycleSummary && (
          <div className="mt-2 text-xs text-gray-400 flex gap-4 flex-wrap">
            <span>Total: {lifecycleSummary.total}</span>
            <span className="text-green-400">
              ✅ Tradable on Jupiter: {lifecycleSummary.tradableCount}
            </span>
            <span className="text-red-400">
              ⚠️ Zero Liquidity: {lifecycleSummary.zeroLiquidity}
            </span>
            <span className="text-yellow-400">
              ❓ Unknown: {lifecycleSummary.unknown}
            </span>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-base-200 z-10">
              <tr className="border-b border-base-300 text-gray-400">
                <th className="text-left py-2 px-4">Token</th>
                <th className="text-right py-2 px-4">Holders</th>
                <th className="text-right py-2 px-4">Price</th>
                <th className="text-right py-2 px-4">24h</th>
                <th className="text-right py-2 px-4">Liquidity</th>
                <th className="text-right py-2 px-4">MCap</th>
                <th className="text-center py-2 px-4">Action</th>
              </tr>
            </thead>

            <tbody>
              {tokens.map((t) => (
                <tr
                  key={t.mint}
                  className="border-b border-base-300 hover:bg-base-300/20 cursor-pointer"
                  onClick={() => (window.location.href = `/trading/${t.mint}`)}
                  tabIndex={0}
                  role="button"
                  aria-label={`View details for ${t.symbol}`}
                >
                  <td className="py-2 px-4 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{t.symbol}</span>
                      {t.holderCount !== undefined && t.holderCount <= 5 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/15 text-primary">
                          ✨ NEW
                        </span>
                      )}
                      {t.lifecycleValidated && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            t.isTradable
                              ? "bg-success/15 text-success"
                              : "bg-danger/15 text-danger"
                          }`}
                          title={`Stage: ${t.lifecycleStage}`}
                        >
                          {t.isTradable ? "✅ Tradable" : "⚠️ Not Tradable"}
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="py-2 px-4 text-right">
                    {t.holderCount !== undefined ? (
                      <span
                        className={`font-semibold ${
                          t.holderCount <= 2
                            ? "text-green-400"
                            : t.holderCount <= 5
                              ? "text-yellow-400"
                              : "text-gray-400"
                        }`}
                      >
                        {t.holderCount}
                      </span>
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </td>

                  <td
                    className={`py-2 px-4 text-right ${
                      flash[t.symbol] === "up"
                        ? "bg-green-500/30"
                        : flash[t.symbol] === "down"
                          ? "bg-red-500/30"
                          : ""
                    }`}
                  >
                    {t.price
                      ? formatPrice(t.price)
                      : t.priceSol
                        ? `${t.priceSol.toFixed(8)} SOL`
                        : "-"}
                  </td>

                  <td
                    className={`py-2 px-4 text-right ${
                      (t.pnl || t.priceChange24h || 0) >= 0
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                  >
                    {t.pnl != null
                      ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}%`
                      : t.priceChange24h != null
                        ? `${
                            t.priceChange24h >= 0 ? "+" : ""
                          }${t.priceChange24h.toFixed(2)}%`
                        : "-"}
                  </td>

                  <td className="py-2 px-4 text-right">
                    {t.liquidity ? `$${formatNumber(t.liquidity)}` : "-"}
                  </td>
                  <td className="py-2 px-4 text-right">
                    {t.marketCap
                      ? `$${formatNumber(t.marketCap)}`
                      : t.marketCapSol
                        ? `${t.marketCapSol.toFixed(2)} SOL`
                        : "-"}
                  </td>

                  <td className="py-2 px-4 text-center">
                    <button
                      onClick={() => {
                        setSelectedToken(t);
                        setIsConfigModalOpen(true);
                      }}
                      disabled={t.lifecycleValidated && !t.isTradable}
                      className={`inline-flex items-center gap-1 px-3 py-1 text-xs rounded-lg transition-colors ${
                        t.lifecycleValidated && !t.isTradable
                          ? "bg-base-300 cursor-not-allowed opacity-50"
                          : "bg-primary hover:bg-primary-hover text-white"
                      }`}
                      title={
                        t.lifecycleValidated && !t.isTradable
                          ? `Not tradable - ${t.lifecycleStage}`
                          : "Configure trade for this token"
                      }
                    >
                      <Settings2 className="w-3 h-3" />
                      {t.lifecycleValidated && !t.isTradable
                        ? "Unavailable"
                        : "Configure"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>

      {/* Token Config Modal */}
      {selectedToken && (
        <TokenConfigModal
          isOpen={isConfigModalOpen}
          onClose={() => {
            setIsConfigModalOpen(false);
            setSelectedToken(null);
          }}
          token={{
            mint: selectedToken.mint,
            symbol: selectedToken.symbol,
            name: selectedToken.name,
            currentMarketCapSol: selectedToken.marketCapSol,
            priceSol: selectedToken.priceSol,
          }}
        />
      )}
    </Card>
  );
};
