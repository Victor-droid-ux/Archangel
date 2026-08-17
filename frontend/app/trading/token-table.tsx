"use client";

import React, { useEffect } from "react";
import useSWR from "swr";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatPrice } from "@lib/utils";
import { Loader2 } from "lucide-react";
import { useSocket } from "@hooks/useSocket";

// Shared type from backend socket payload (see tokenPrice.service.ts's
// TokenInfo — the field is priceChange24h, there is no "pnl" field)
interface TokenWithPrice {
  symbol: string;
  mint: string;
  price: number | null;
  priceChange24h: number | null;
  liquidity: number | null;
  marketCap: number | null;
}

// API response type
interface TokenApiResponse {
  success: boolean;
  tokens: TokenWithPrice[];
}

export default function TokenTable() {
  const { data, mutate, isLoading, error } = useSWR<TokenApiResponse>(
    "/api/tokens",
    fetcher,
    {
      refreshInterval: 10000,
    }
  );

  const { lastMessage, connected } = useSocket();

  /** SOCKET — realtime token refresh */
  useEffect(() => {
    if (!lastMessage?.event) return;
    if (lastMessage.event !== "token_prices") return; // Correct event name

    mutate(); // 🔄 Update SWR cache live
  }, [lastMessage, mutate]);

  if (isLoading)
    return (
      <Card className="bg-base-200 p-6 text-center">
        <Loader2 className="animate-spin text-primary mx-auto" />
        <p className="text-gray-400 text-sm mt-2">Loading tokens…</p>
      </Card>
    );

  if (error || !data?.tokens)
    return (
      <Card className="bg-base-200 p-4 text-center text-red-400">
        Failed to load tokens
      </Card>
    );

  const tokens = data.tokens ?? [];

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex justify-between items-center">
          <span>Active Tokens</span>
          <span
            className={`text-xs ${
              connected ? "text-green-400" : "text-red-400"
            }`}
          >
            {connected ? "🟢 Live" : "⚫ Offline"}
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent>
        <div className="overflow-hidden rounded-lg border border-base-300">
          <div className="max-h-[400px] overflow-y-auto">
            <table className="table w-full text-sm">
              <thead className="sticky top-0 bg-base-200 z-10">
                <tr className="text-gray-400 border-b border-base-300">
                  <th className="text-left py-2 px-4">Token</th>
                  <th className="text-right py-2 px-4">Price</th>
                  <th className="text-right py-2 px-4">24h</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr
                    key={t.mint}
                    className="border-b border-base-300 hover:bg-base-300/20 cursor-pointer"
                    onClick={() => (window.location.href = `/trading/${t.mint}`)}
                  >
                    <td className="py-2 px-4 font-medium">{t.symbol}</td>

                    <td className="py-2 px-4 text-right">
                      {t.price !== null ? formatPrice(t.price) : "—"}
                    </td>

                    <td
                      className={`py-2 px-4 text-right ${
                        (t.priceChange24h || 0) >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {t.priceChange24h != null
                        ? `${t.priceChange24h > 0 ? "+" : ""}${t.priceChange24h.toFixed(2)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
