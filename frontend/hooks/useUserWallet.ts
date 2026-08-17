// frontend/hooks/useUserWallet.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { fetcher } from "@lib/utils";

interface UserWalletState {
  hotWalletPublicKey: string | null;
  balanceSol: number | null;
  // The minimum balance auto-trade sizing (AUTO_TRADE_PERCENT_OF_BALANCE)
  // needs before it can ever produce a trade that clears the server's own
  // floor (MIN_AUTO_TRADE_SOL) — null until the first successful fetch.
  minBalanceForAutoTradeSol: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The bot-generated custodial trading wallet for the currently connected
 * owner wallet (created on first lookup). Deposits sent to hotWalletPublicKey
 * fund what the bot trades with on this user's behalf.
 */
export function useUserWallet(): UserWalletState {
  const { publicKey } = useSolanaWallet();
  const [hotWalletPublicKey, setHotWalletPublicKey] = useState<string | null>(
    null
  );
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [minBalanceForAutoTradeSol, setMinBalanceForAutoTradeSol] =
    useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setHotWalletPublicKey(null);
      setBalanceSol(null);
      setMinBalanceForAutoTradeSol(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher<{
        success: boolean;
        hotWalletPublicKey: string;
        balanceSol: number;
        minBalanceForAutoTradeSol: number;
      }>(`/api/user-wallet/${publicKey.toBase58()}`);
      if (res?.success) {
        setHotWalletPublicKey(res.hotWalletPublicKey);
        setBalanceSol(res.balanceSol);
        setMinBalanceForAutoTradeSol(res.minBalanceForAutoTradeSol);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to load trading wallet");
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  return {
    hotWalletPublicKey,
    balanceSol,
    minBalanceForAutoTradeSol,
    loading,
    error,
    refresh,
  };
}

export default useUserWallet;
