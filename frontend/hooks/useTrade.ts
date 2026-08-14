"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import { useWallet } from "@hooks/useWallet";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";

export const useTrade = () => {
  const { publicKey, connected, refreshBalance } = useWallet();
  const wallet = useSolanaWallet();
  const { amount, slippage, takeProfit, stopLoss, selectedToken } =
    useTradingConfigStore();

  const { stats, updateStats } = useStats();
  const { sendMessage } = useSocket();

  const [loading, setLoading] = useState(false);

  const executeTrade = async (type: "buy" | "sell", tokenMint: string) => {
    if (!connected || !publicKey) {
      toast.error("Connect your wallet to trade.");
      return null;
    }

    if (!wallet.signTransaction) {
      toast.error("Wallet does not support transaction signing.");
      return null;
    }

    setLoading(true);
    toast.loading(`${type === "buy" ? "Buying" : "Selling"} ${tokenMint}…`, {
      id: "trade-status",
    });

    try {
      const slippageBps = Math.floor(slippage * 100);
      const inputMint =
        type === "buy"
          ? "So11111111111111111111111111111111111111112"
          : tokenMint;
      const outputMint =
        type === "buy"
          ? tokenMint
          : "So11111111111111111111111111111111111111112";
      const mint = tokenMint || selectedToken;
      if (!mint) throw new Error("Missing token");

      // Step 1: Prepare unsigned transaction
      toast.loading("Preparing transaction...", { id: "trade-status" });
      const prepareRes: any = await fetcher("/api/trade/prepare", {
        method: "POST",
        body: JSON.stringify({
          type,
          inputMint,
          outputMint,
          wallet: publicKey,
          amountLamports: Math.floor(amount * 1e9),
          slippageBps,
        }),
      });

      if (!prepareRes?.success) {
        throw new Error(prepareRes?.message || "Failed to prepare transaction");
      }

      let signedTxBase64: string | undefined;

      if (!prepareRes.data?.transaction) {
        throw new Error("No transaction data received");
      }

      toast.loading("Sign transaction in your wallet...", {
        id: "trade-status",
      });

      const txBuffer = Buffer.from(prepareRes.data.transaction, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);

      const signedTx = await wallet.signTransaction(transaction);
      signedTxBase64 = Buffer.from(signedTx.serialize()).toString("base64");

      // Step 2: Confirm with backend
      toast.loading("Confirming transaction...", { id: "trade-status" });
      const confirmRes: any = await fetcher("/api/trade/confirm", {
        method: "POST",
        body: JSON.stringify({
          signedTransaction: signedTxBase64,
          type,
          token: mint,
          amountLamports: Math.floor(amount * 1e9),
          takeProfit,
          stopLoss,
          wallet: publicKey,
          slippageBps,
        }),
      });

      if (!confirmRes?.success) {
        // A failed confirmation is a real failure — surface it as one instead
        // of fabricating a fake "successful" trade with random price/PnL. This
        // used to silently show a success toast for trades that never happened.
        throw new Error(
          confirmRes?.message || "Trade confirmation failed"
        );
      }

      const d = confirmRes.data;
      const trade: any = {
        simulated: false,
        id: d.id ?? crypto.randomUUID(),
        type,
        token: d.token ?? mint,
        amount: Number(d.amountLamports ?? amount * 1e9),
        price: Number(d.price ?? 0),
        pnl: Number(d.pnl) || 0,
        signature: d.signature ?? null,
        timestamp: d.timestamp ?? new Date().toISOString(),
      };

      // 👉 Broadcast live event properly
      sendMessage("tradeFeed", trade);

      // 📊 Update stats correctly
      const amountSol = trade.amount / 1e9;

      updateStats({
        tradeVolumeSol: stats.tradeVolumeSol + amountSol,
        openTrades:
          type === "buy"
            ? stats.openTrades + 1
            : Math.max(stats.openTrades - 1, 0),
      });

      toast.success(
        `${type === "buy" ? "Bought" : "Sold"} ${trade.token} ${
          trade.simulated ? "(sim)" : ""
        }`,
        { id: "trade-status" }
      );

      // Trigger immediate balance refresh after trade (portfolio hook will update PnL)
      console.log("✅ Trade completed, refreshing wallet balance...");
      setTimeout(() => {
        refreshBalance();
      }, 2000); // Wait 2s for blockchain confirmation

      return trade;
    } catch (err: any) {
      const errorMessage = err.message || "Unknown error";
      const duration = 5000;

      toast.error(`Trade failed: ${errorMessage}`, {
        id: "trade-status",
        duration,
      });

      console.error("Trade error:", err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return { executeTrade, loading };
};
