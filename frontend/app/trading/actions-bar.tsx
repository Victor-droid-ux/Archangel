"use client";

import React, { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Zap, Loader2, Ban } from "lucide-react";
import { Button } from "@components/ui/button";
import { useWallet } from "@hooks/useWallet";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";
import { signWalletAuth } from "@lib/walletAuth";
import { toast } from "react-hot-toast";
import { motion } from "framer-motion";

export default function ActionsBar() {
  const router = useRouter();
  const { connected, publicKey } = useWallet();
  const { signMessage } = useSolanaWallet();
  const { connected: socketConnected } = useSocket();

  const [stopping, setStopping] = useState(false);

  const handleStopAutoTrade = useCallback(async () => {
    if (!connected || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }
    const confirmed = window.confirm(
      "This disables auto-trading for your wallet and sells every position the bot has bought for you. This cannot be undone. Continue?"
    );
    if (!confirmed) return;

    setStopping(true);
    toast.loading("Stopping auto-trade and selling bot-bought positions...", {
      id: "stop-auto-trade",
    });
    try {
      const auth = await signWalletAuth(signMessage, publicKey);
      const res = await fetcher<{
        success: boolean;
        disabledAutoTrade: boolean;
        sold: { token: string }[];
        failed: { token: string; error: string }[];
        error?: string;
      }>(`/api/user-wallet/${publicKey}/stop-auto-trade`, {
        method: "POST",
        body: JSON.stringify(auth),
      });

      if (!res?.success) {
        throw new Error(res?.error || "Failed to stop auto-trade");
      }

      toast.dismiss("stop-auto-trade");
      if (res.sold.length === 0 && res.failed.length === 0) {
        toast.success("Auto-trade disabled. You had no bot-bought positions to sell.");
      } else if (res.failed.length === 0) {
        toast.success(`Auto-trade disabled. Sold ${res.sold.length} position(s).`);
      } else {
        // Auto-trade is already off at this point regardless — only the
        // sell-off is partial. List exactly which tokens didn't sell (not
        // just a count) so the user knows what's still open, and that
        // clicking the button again will retry just those.
        const failedList = res.failed
          .map((f) => `${f.token.slice(0, 8)}… (${f.error})`)
          .join("\n");
        toast.success(
          `Auto-trade disabled. Sold ${res.sold.length} position(s).`
        );
        toast.error(
          `${res.failed.length} position(s) failed to sell:\n${failedList}\n\nClick Stop Auto Trade again to retry.`,
          { duration: 10000 }
        );
        console.warn("Stop auto-trade: some sells failed", res.failed);
      }
    } catch (err: any) {
      toast.dismiss("stop-auto-trade");
      toast.error(err?.message || "Failed to stop auto-trade");
      console.error(err);
    } finally {
      setStopping(false);
    }
  }, [connected, publicKey, signMessage]);

  return (
    <motion.div
      className="bg-base-200 rounded-xl p-5 flex flex-wrap justify-between items-center gap-4 border border-base-300 shadow-sm"
      initial={{ opacity: 1, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2 text-primary">
        <Zap size={18} className="text-yellow-400" />
        <h2 className="text-lg font-semibold">Trading Controls</h2>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        {/* Socket status */}
        <span
          className={`text-xs ${
            socketConnected ? "text-green-400" : "text-red-400"
          }`}
        >
          🔌 {socketConnected ? "Live" : "Offline"}
        </span>

        <Button
          variant="secondary"
          disabled={!connected}
          onClick={() => router.push("/trading/buy")}
          className="flex items-center gap-2"
        >
          <TrendingUp />
          Buy
        </Button>

        <Button
          variant="danger"
          disabled={!connected}
          onClick={() => router.push("/trading/sell")}
          className="flex items-center gap-2"
        >
          <TrendingDown />
          Sell
        </Button>

        <Button
          variant="outline"
          disabled={!connected || stopping}
          onClick={handleStopAutoTrade}
          className="flex items-center gap-2"
          title="Sell everything the bot has bought for you and turn off auto-trade"
        >
          {stopping ? <Loader2 className="animate-spin" /> : <Ban />}
          Stop Auto Trade
        </Button>
      </div>
    </motion.div>
  );
}
