"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { fetcher, formatNumber, truncateAddress } from "@lib/utils";
import { useWallet } from "@hooks/useWallet";
import { useTrade } from "@hooks/useTrade";
import { ArrowLeft, Loader2, TrendingDown } from "lucide-react";
import { toast } from "react-hot-toast";

interface SellablePosition {
  token: string;
  netSol: number;
  avgBuyPrice?: number;
  custody: "self" | "custodial" | null;
}

interface TokenBalance {
  raw: string;
  uiAmount: number;
  decimals: number;
}

// Same floor used throughout the backend (db.service.ts, monitor.service.ts)
// to treat a near-zero remainder as fully closed rather than a real position.
const DUST_THRESHOLD_SOL = 0.0005;

export default function SellPage() {
  const router = useRouter();
  const { connected, publicKey } = useWallet();
  const { executeTrade, loading: submitting } = useTrade();

  const [positions, setPositions] = useState<SellablePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SellablePosition | null>(null);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const loadPositions = useCallback(async () => {
    if (!publicKey) {
      setPositions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetcher<{ success: boolean; positions: SellablePosition[] }>(
        `/api/positions?wallet=${encodeURIComponent(publicKey)}`
      );
      if (res?.success) {
        // Only positions this wallet can actually sign for itself — a
        // custodial (bot-bought) position needs the server's key, not
        // yours; use "Stop Auto Trade" on the dashboard for those instead.
        setPositions(
          (res.positions || []).filter(
            (p) => p.custody === "self" && p.netSol >= DUST_THRESHOLD_SOL
          )
        );
      }
    } catch (err) {
      console.error("Failed to load positions:", err);
      toast.error("Failed to load your positions.");
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const selectPosition = async (p: SellablePosition) => {
    setSelected(p);
    setBalance(null);
    if (!publicKey) return;
    setBalanceLoading(true);
    try {
      const res = await fetcher<{ success: boolean; data: TokenBalance }>(
        `/api/trade/token-balance?wallet=${encodeURIComponent(
          publicKey
        )}&mint=${encodeURIComponent(p.token)}`
      );
      if (res?.success) setBalance(res.data);
    } catch (err) {
      console.error("Failed to load token balance:", err);
      toast.error("Failed to load your token balance.");
    } finally {
      setBalanceLoading(false);
    }
  };

  const handleSell = async () => {
    if (!selected || !balance) return;
    if (!balance.raw || balance.raw === "0") {
      toast.error("No on-chain balance found for this token.");
      return;
    }
    const trade = await executeTrade("sell", selected.token, balance.raw);
    if (trade) {
      setSelected(null);
      setBalance(null);
      loadPositions();
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={() => router.push("/trading")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-red-400" />
          Sell a Token
        </h1>
      </div>

      {!connected ? (
        <div className="text-center py-10 text-gray-400">
          Connect your wallet to see what you can sell.
        </div>
      ) : selected ? (
        <Card className="p-6 space-y-4 bg-base-200 border border-base-300">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold font-mono">
                {truncateAddress(selected.token)}
              </h2>
              <p className="text-xs text-gray-500">
                Avg buy price: {selected.avgBuyPrice ? formatNumber(selected.avgBuyPrice, 9) : "—"}{" "}
                SOL
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setBalance(null);
              }}
            >
              Back to list
            </Button>
          </div>

          {balanceLoading ? (
            <div className="flex items-center gap-2 text-gray-400 py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your balance...
            </div>
          ) : balance ? (
            <div className="bg-base-300/40 rounded-lg p-4">
              <div className="text-sm text-gray-400">You hold</div>
              <div className="text-lg font-semibold">
                {formatNumber(balance.uiAmount, 4)} tokens
              </div>
              <div className="text-xs text-gray-500">
                ~{formatNumber(selected.netSol, 4)} SOL cost basis
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Balance unavailable.</div>
          )}

          <Button
            variant="danger"
            onClick={handleSell}
            disabled={submitting || !balance || balance.raw === "0"}
            className="w-full"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Sell entire holding"
            )}
          </Button>
          <p className="text-xs text-gray-500">
            Sells 100% of your on-chain balance for this token, signed by your
            own connected wallet.
          </p>
        </Card>
      ) : loading ? (
        <div className="flex items-center gap-2 py-10 justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading your positions...
        </div>
      ) : positions.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          You don't have any manually-bought positions to sell.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {positions.map((p) => (
            <button
              key={p.token}
              onClick={() => selectPosition(p)}
              className="text-left bg-base-200 border border-base-300 rounded-xl p-4 hover:border-primary transition-colors"
            >
              <div className="font-mono text-sm">{truncateAddress(p.token)}</div>
              <div className="mt-2 text-xs text-gray-400">
                Cost basis: {formatNumber(p.netSol, 4)} SOL
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
