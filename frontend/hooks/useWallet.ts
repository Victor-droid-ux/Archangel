"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import { useSocket } from "./useSocket";
import { useTradingConfigStore } from "./useConfig";
import { fetcher } from "@lib/utils";

interface WalletState {
  connected: boolean;
  publicKey: string | null;
  balance: number;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  refreshBalance: () => Promise<void>;
}

export const useWallet = (): WalletState => {
  const solanaWallet = useSolanaWallet();
  const [currentSolBalance, setCurrentSolBalance] = useState<number>(0);

  const { identify } = useSocket();
  const { autoTrade, amount } = useTradingConfigStore();

  // Sync connection state from Solana wallet adapter
  const connected = solanaWallet.connected;
  const publicKey = solanaWallet.publicKey?.toString() || null;

  /* -------------------------------------------------
     Connect - Use Solana wallet adapter's connect
  ------------------------------------------------- */
  const connectWallet = useCallback(async () => {
    try {
      console.log("🔍 Checking wallet adapter:", {
        hasWallet: !!solanaWallet.wallet,
        walletName: solanaWallet.wallet?.adapter?.name,
        connected: solanaWallet.connected,
        wallets: solanaWallet.wallets?.length,
      });

      // Check if Phantom is installed in window object
      if (typeof window !== "undefined") {
        console.log("🔍 Window wallet objects:", {
          phantom: !!(window as any).solana?.isPhantom,
          solflare: !!(window as any).solflare,
        });
      }

      // This will trigger the wallet selection modal if no wallet is connected
      await solanaWallet.connect();
      console.log(
        "✅ Wallet connected via adapter:",
        solanaWallet.publicKey?.toString()
      );
    } catch (err) {
      console.error("❌ Wallet connection failed:", err);
      // Check if it's a user rejection or actual error
      if (err instanceof Error && !err.message.includes("User rejected")) {
        alert(
          "No wallet detected. Please install Phantom or Solflare wallet extension and refresh the page."
        );
      }
    }
  }, [solanaWallet]);

  /* -------------------------------------------------
     Disconnect - Use Solana wallet adapter's disconnect
  ------------------------------------------------- */
  const disconnectWallet = useCallback(async () => {
    try {
      await solanaWallet.disconnect();
      setCurrentSolBalance(0);
      console.log("👋 Wallet disconnected by user");
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, [solanaWallet]);

  /* -------------------------------------------------
     Refresh Balance
  ------------------------------------------------- */
  const refreshBalance = useCallback(async () => {
    if (!solanaWallet.publicKey || !connected) {
      console.log("⏭️ Skipping balance refresh - wallet not connected");
      return;
    }

    // Gather all RPC endpoints (primary + fallbacks)
    const rpcEndpoints = [
      process.env.NEXT_PUBLIC_SOLANA_ENDPOINT,
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
      process.env.NEXT_PUBLIC_SOLANA_FALLBACK_1,
      process.env.NEXT_PUBLIC_SOLANA_FALLBACK_2,
      "https://api.mainnet-beta.solana.com",
    ].filter(Boolean);

    let lastError = null;
    for (let i = 0; i < rpcEndpoints.length; i++) {
      const rpcUrl = rpcEndpoints[i];
      if (!rpcUrl) continue; // Skip undefined endpoints
      try {
        console.log(`🔍 Fetching balance from: ${rpcUrl}`);
        const connection = new Connection(String(rpcUrl), "confirmed");
        const balance = await connection.getBalance(solanaWallet.publicKey);
        const balanceSol = balance / 1e9;

        console.log("💰 Balance fetched:", {
          lamports: balance,
          sol: balanceSol,
          wallet: solanaWallet.publicKey.toString().slice(0, 8) + "...",
        });

        setCurrentSolBalance(balanceSol);
        return;
      } catch (err: any) {
        lastError = err;
        // If 429 or rate limit, try next endpoint
        const errMsg = err?.message || String(err);
        if (
          errMsg.includes("429") ||
          errMsg.toLowerCase().includes("rate limit") ||
          errMsg.toLowerCase().includes("too many requests")
        ) {
          console.warn(
            `⚠️ RPC endpoint rate-limited (${rpcUrl}), trying next...`
          );
          continue;
        } else {
          // For other errors, only try next if not last endpoint
          console.warn(`⚠️ Error with endpoint (${rpcUrl}):`, errMsg);
          if (i === rpcEndpoints.length - 1) {
            break;
          }
        }
      }
    }
    // If all endpoints fail
    console.error("❌ Failed to refresh balance on all endpoints:", lastError);
    setCurrentSolBalance(0);
  }, [solanaWallet.publicKey, connected]);

  /* -------------------------------------------------
     On wallet connection, identify with backend
  ------------------------------------------------- */
  useEffect(() => {
    if (connected && solanaWallet.publicKey) {
      refreshBalance();

      // Identify with backend on connection
      identify({
        wallet: solanaWallet.publicKey.toString(),
        balanceSol: currentSolBalance,
        autoMode: autoTrade,
        manualAmountSol: amount,
      });

      // "Sign up" this wallet — generates its custodial trading wallet on
      // first sight (userWallet.service.ts's getOrCreateUserWallet is
      // idempotent, safe to call every time). This used to only happen if
      // the user visited Settings; firing it here means connecting a
      // wallet ANYWHERE in the app is what makes it a real user, not
      // landing on one specific page.
      fetcher(`/api/user-wallet/${solanaWallet.publicKey.toString()}`).catch(
        (err) => console.error("Failed to provision trading wallet:", err)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, solanaWallet.publicKey]);

  /* -------------------------------------------------
     Auto-refresh balance every 10 seconds
  ------------------------------------------------- */
  useEffect(() => {
    if (!connected || !solanaWallet.publicKey) return;

    const interval = setInterval(() => {
      refreshBalance();
    }, 10000); // Refresh every 10 seconds

    return () => clearInterval(interval);
  }, [connected, solanaWallet.publicKey, refreshBalance]);

  return {
    connected,
    publicKey,
    balance: currentSolBalance,
    connectWallet,
    disconnectWallet,
    refreshBalance,
  };
};
