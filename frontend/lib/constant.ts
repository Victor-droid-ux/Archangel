// frontend/lib/constant.ts

/**
 * ✅ Global constants for ArchAngel Trading Bot UI
 * Centralized config for environment keys and defaults
 */

// 🔹 Environment-based settings
export const ENV = {
  NODE_ENV: process.env.NODE_ENV || "development",
  API_BASE_URL:
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000/api",
  SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000", // backend socket server
  // Must match the env var names WalletProvider.tsx/useWallet.ts actually
  // read (NEXT_PUBLIC_SOLANA_ENDPOINT, with _RPC_URL as a legacy alias) —
  // this used to check NEXT_PUBLIC_SOLANA_RPC (no _URL), which nothing sets,
  // so it always silently fell through to the public rate-limited endpoint.
  SOLANA_RPC_URL:
    process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
};

// DEFAULT_CONFIG and API_ROUTES used to live here — removed. Neither was
// imported anywhere (useConfig.ts's useTradingConfigStore is the real
// source of trading defaults, and every API call goes through fetcher()/
// ENV.API_BASE_URL directly), and both had drifted from reality: DEFAULT_CONFIG's
// values (slippage 1.5%, stop-loss 5%) disagreed with the store's real
// defaults (1%, 2%), and API_ROUTES only listed 4 of the many endpoints
// that exist now. Dead constants that also happen to be wrong are worse
// than no constants — remove rather than leave as a landmine for whoever
// finds them next and assumes they're current.

// 🔹 App metadata
export const APP_INFO = {
  NAME: "ArchAngel Bot",
  VERSION: "1.0.0",
  AUTHOR: "ArchAngel Labs",
  DESCRIPTION:
    "AI-powered Solana trading bot for automating meme coin strategies.",
};

// 🔹 UI constants
export const UI = {
  REFRESH_INTERVAL: 10000, // ms
  SOCKET_RETRY_DELAY: 3000,
  MAX_TRADE_LOGS: 50,
};
