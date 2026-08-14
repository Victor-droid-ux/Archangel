// frontend/hooks/useWatchlist.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetcher } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";

export interface WatchlistPriceAlert {
  targetPrice: number;
  condition: "above" | "below";
  triggered?: boolean;
}

export interface WatchlistToken {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  addedAt: string;
  userId?: string;
  priceAlert?: WatchlistPriceAlert;
  notes?: string;
}

export function useWatchlist() {
  const [tokens, setTokens] = useState<WatchlistToken[]>([]);
  const [loading, setLoading] = useState(true);
  const { lastMessage } = useSocket();

  const load = useCallback(async () => {
    try {
      const res = await fetcher<{ success: boolean; tokens: WatchlistToken[] }>(
        "/api/watchlist"
      );
      if (res?.success) setTokens(res.tokens || []);
    } catch (err) {
      console.warn("Failed to load watchlist:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Real-time sync — watchlist.route.ts broadcasts watchlist:update after
  // every add/remove so every open tab stays in sync without polling.
  useEffect(() => {
    if (lastMessage?.event === "watchlist:update") {
      setTokens(lastMessage.payload || []);
    }
    // Setting an alert only broadcasts priceAlert:set, not a fresh list —
    // re-fetch so other tabs pick up the new alert too.
    if (lastMessage?.event === "priceAlert:set") {
      load();
    }
  }, [lastMessage, load]);

  const addToken = useCallback(
    async (mint: string, symbol?: string, name?: string) => {
      const res = await fetcher<{ success: boolean; error?: string }>(
        "/api/watchlist",
        {
          method: "POST",
          body: JSON.stringify({ mint, symbol, name }),
        }
      );
      if (res?.success) await load();
      return res;
    },
    [load]
  );

  const removeToken = useCallback(
    async (mint: string) => {
      const res = await fetcher<{ success: boolean }>(
        `/api/watchlist/${mint}`,
        { method: "DELETE" }
      );
      if (res?.success) await load();
      return res;
    },
    [load]
  );

  const setPriceAlert = useCallback(
    async (mint: string, targetPrice: number, condition: "above" | "below") => {
      const res = await fetcher<{ success: boolean }>(
        `/api/watchlist/${mint}/alert`,
        {
          method: "PATCH",
          body: JSON.stringify({ targetPrice, condition }),
        }
      );
      if (res?.success) await load();
      return res;
    },
    [load]
  );

  return { tokens, loading, addToken, removeToken, setPriceAlert, refresh: load };
}

export default useWatchlist;
