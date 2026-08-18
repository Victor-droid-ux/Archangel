"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";

// Import wallet adapter CSS
import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Use mainnet-beta
  const network = WalletAdapterNetwork.Mainnet;

  // Use custom RPC or fallback to public
  const endpoint = useMemo(
    () =>
      process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      clusterApiUrl(network),
    [network]
  );

  // Phantom and Solflare both now self-register via the browser's Wallet
  // Standard, independent of this app — manually instantiating
  // PhantomWalletAdapter/SolflareWalletAdapter here created a SECOND,
  // competing registration of the same wallet, which is what was actually
  // causing connect() to hang forever on "Connecting..." (confirmed via
  // Phantom's own console warning: "Phantom was registered as a Standard
  // Wallet. The Wallet Adapter for Phantom can be removed from your app.",
  // plus ObjectMultiplex "orphaned data" stream errors from the two
  // instances fighting over the same extension). An empty array is the
  // current recommended pattern — @solana/wallet-adapter-react auto-detects
  // every Standard Wallet the browser has injected.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
