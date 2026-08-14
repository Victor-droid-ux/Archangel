// backend/src/services/jupiter.service.ts
// Single point of contact with Jupiter's aggregator API — quotes, swap execution,
// and the "recent tokens" feed used for discovery. Replaces the old Raydium-only
// execution layer and Pump.fun bonding-curve trading entirely.
import axios from "axios";
import crypto from "crypto";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getConnection, loadKeypairFromEnv } from "./solana.service.js";
import { ENV } from "../utils/env.js";
import { quoteCache, tokenDiscoveryCache } from "./cache.service.js";

const LOG = getLogger("jupiter.service");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Several independent pipelines (tokenDiscovery, jupiterDiscovery, autoBuyer,
// validationPipeline, storedTokenChecker) all funnel through this one file and
// can each fire Jupiter calls for multiple tokens in the same instant — a real
// API key raises the rate limit but doesn't remove it, and that burst pattern
// was still tripping 429s even with a valid key. Space requests out first
// (like birdeye.service.ts's throttledRequest) to avoid the burst in the first
// place, then retry with backoff on whatever 429 still gets through.
let lastRequestAt = 0;
const MIN_REQUEST_SPACING_MS = Number(
  process.env.JUPITER_MIN_REQUEST_SPACING_MS ?? 150
);

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 2
): Promise<T> {
  const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();

  try {
    return await fn();
  } catch (err: any) {
    if (err?.response?.status === 429 && retries > 0) {
      const backoffMs = 1200 * (3 - retries);
      LOG.warn(`Jupiter ${label} 429 — retrying in ${backoffMs}ms (${retries} left)`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return withRetry(fn, label, retries - 1);
    }
    throw err;
  }
}

let cachedSolPriceUsd: { price: number; fetchedAt: number } | null = null;

/**
 * Real-time SOL/USD price via a Jupiter quote (cached briefly so every caller
 * doesn't spam a fresh quote). Shared by anything that needs to convert Jupiter's
 * USD-denominated liquidity/mcap figures into SOL.
 */
export async function getSolPriceUsd(): Promise<number> {
  if (cachedSolPriceUsd && Date.now() - cachedSolPriceUsd.fetchedAt < 30000) {
    return cachedSolPriceUsd.price;
  }
  try {
    const { data } = await withRetry(
      () =>
        axios.get(
          `${process.env.JUPITER_API_URL || "https://lite-api.jup.ag"}/swap/v1/quote`,
          {
            params: { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 1e9, slippageBps: 100 },
            timeout: 8000,
          }
        ),
      "getSolPriceUsd"
    );
    if (data?.outAmount) {
      const price = Number(data.outAmount) / 1e6; // USDC has 6 decimals
      cachedSolPriceUsd = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (err: any) {
    LOG.warn(
      { err: err?.message ?? String(err) },
      "Failed to fetch live SOL price, using fallback"
    );
  }
  return cachedSolPriceUsd?.price ?? 150; // conservative fallback
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  otherAmountThreshold: number;
  priceImpactPct: number;
  slippageBps: number;
  raw: any; // full quote response, required verbatim as the `quoteResponse` body for /swap
}

export interface JupiterSwapResult {
  success: boolean;
  signature?: string;
  simulated?: boolean;
  error?: string;
}

export interface JupiterRecentToken {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  liquidity: number;
  mcap: number;
  usdPrice: number;
  circSupply: number;
  totalSupply: number;
  priceChange1h: number | null;
  priceChange24h: number | null;
  volume24h: number; // buyVolume + sellVolume from stats24h
  holderCount: number;
  organicScore: number;
  organicScoreLabel: string;
  buyVolume5m: number;
  numBuys5m: number;
  isVerified: boolean;
  tags: string[];
  launchpad: string | null; // e.g. "pump.fun" — informational only, not a discovery filter
  firstPoolId: string | null;
  firstPoolCreatedAt: number; // ms epoch
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  devAddress: string | null; // token creator/dev wallet, per Jupiter's `dev` field
}

// Maps a raw /tokens/v2 API record to our shape. Field names verified against live
// responses on 2026-08-12 — see audit.mintAuthorityDisabled/freezeAuthorityDisabled
// (booleans, not addresses), stats24h.priceChange/buyVolume/sellVolume (present on
// established tokens, often absent on genuinely brand-new ones with no trade history yet).
function mapRecentToken(t: any): JupiterRecentToken {
  const stats24h = t.stats24h ?? {};
  const stats1h = t.stats1h ?? {};
  return {
    mint: t.id,
    name: t.name ?? "Unknown",
    symbol: t.symbol ?? "UNKNOWN",
    decimals: Number(t.decimals ?? 9),
    liquidity: Number(t.liquidity ?? 0),
    mcap: Number(t.mcap ?? t.fdv ?? 0),
    usdPrice: Number(t.usdPrice ?? 0),
    circSupply: Number(t.circSupply ?? 0),
    totalSupply: Number(t.totalSupply ?? 0),
    priceChange1h: stats1h.priceChange != null ? Number(stats1h.priceChange) : null,
    priceChange24h: stats24h.priceChange != null ? Number(stats24h.priceChange) : null,
    volume24h: Number(stats24h.buyVolume ?? 0) + Number(stats24h.sellVolume ?? 0),
    holderCount: Number(t.holderCount ?? 0),
    organicScore: Number(t.organicScore ?? 0),
    organicScoreLabel: t.organicScoreLabel ?? "unknown",
    buyVolume5m: Number(t.stats5m?.buyVolume ?? 0),
    numBuys5m: Number(t.stats5m?.numBuys ?? 0),
    isVerified: Boolean(t.isVerified),
    tags: Array.isArray(t.tags) ? t.tags : [],
    launchpad: t.launchpad ?? null,
    firstPoolId: t.firstPool?.id ?? null,
    firstPoolCreatedAt: t.firstPool?.createdAt
      ? new Date(t.firstPool.createdAt).getTime()
      : 0,
    mintAuthorityDisabled: Boolean(t.audit?.mintAuthorityDisabled),
    freezeAuthorityDisabled: Boolean(t.audit?.freezeAuthorityDisabled),
    devAddress: typeof t.dev === "string" ? t.dev : null,
  };
}

class JupiterService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = process.env.JUPITER_API_URL || "https://lite-api.jup.ag";
    this.apiKey = process.env.JUPITER_API_KEY || "";
  }

  private headers() {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  /**
   * GET /swap/v1/quote
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number | string | bigint,
    slippageBps = 500
  ): Promise<JupiterQuote | null> {
    try {
      const amountStr = String(amountLamports);
      const cacheKey = `jupiter:quote:${inputMint}:${outputMint}:${amountStr}:${slippageBps}`;
      const cached = quoteCache.get<JupiterQuote>(cacheKey);
      if (cached) return cached;

      const { data } = await withRetry(
        () =>
          axios.get(`${this.baseUrl}/swap/v1/quote`, {
            params: {
              inputMint,
              outputMint,
              amount: amountStr,
              slippageBps,
              restrictIntermediateTokens: true,
            },
            headers: this.headers(),
            timeout: 8000,
          }),
        "getQuote"
      );

      if (!data || !data.outAmount) {
        LOG.warn(
          { inputMint, outputMint },
          "Jupiter quote returned no route/outAmount"
        );
        return null;
      }

      const quote: JupiterQuote = {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inAmount: Number(data.inAmount),
        outAmount: Number(data.outAmount),
        otherAmountThreshold: Number(data.otherAmountThreshold ?? data.outAmount),
        priceImpactPct: Number(data.priceImpactPct ?? 0),
        slippageBps: Number(data.slippageBps ?? slippageBps),
        raw: data,
      };

      quoteCache.set(cacheKey, quote);
      return quote;
    } catch (err: any) {
      LOG.warn(
        { inputMint, outputMint, err: err?.message ?? String(err) },
        "Jupiter quote request failed"
      );
      return null;
    }
  }

  /**
   * POST /swap/v1/swap — builds the unsigned swap transaction for a given quote.
   * Public: also used to prepare a transaction for client-side (frontend wallet) signing.
   */
  async buildSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string
  ): Promise<{ swapTransaction: string; lastValidBlockHeight: number } | null> {
    try {
      const priorityFeeLamports = Math.max(
        Math.round(ENV.JUPITER_PRIORITY_FEE > 0 ? ENV.JUPITER_PRIORITY_FEE * 1e9 : 0),
        1
      );

      const { data } = await withRetry(
        () =>
          axios.post(
            `${this.baseUrl}/swap/v1/swap`,
            {
              quoteResponse: quote.raw,
              userPublicKey,
              wrapAndUnwrapSol: true,
              dynamicComputeUnitLimit: true,
              prioritizationFeeLamports: priorityFeeLamports || "auto",
            },
            { headers: this.headers(), timeout: 15000 }
          ),
        "buildSwapTransaction"
      );

      if (!data?.swapTransaction) {
        LOG.warn("Jupiter /swap returned no swapTransaction");
        return null;
      }

      return {
        swapTransaction: data.swapTransaction,
        lastValidBlockHeight: data.lastValidBlockHeight,
      };
    } catch (err: any) {
      LOG.error(
        { err: err?.response?.data ?? err?.message ?? String(err) },
        "Failed to build Jupiter swap transaction"
      );
      return null;
    }
  }

  private async sendRaw(
    connection: Connection,
    tx: VersionedTransaction
  ): Promise<string> {
    const raw = tx.serialize();

    if (ENV.JITO_MEV_RELAY_ENABLED && ENV.JITO_MEV_RELAY_URL) {
      try {
        const base64Tx = Buffer.from(raw).toString("base64");
        const response = await axios.post(
          ENV.JITO_MEV_RELAY_URL,
          { transaction: base64Tx },
          { headers: { "Content-Type": "application/json" }, timeout: 10000 }
        );
        const signature = response.data?.result || response.data?.signature;
        if (signature) {
          LOG.info({ signature }, "Sent via Jito relay");
          return signature;
        }
        LOG.warn("Jito relay returned no signature, falling back to RPC");
      } catch (err: any) {
        LOG.warn(
          { err: err?.message ?? String(err) },
          "Jito relay send failed, falling back to RPC"
        );
      }
    }

    return connection.sendRawTransaction(raw, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
  }

  /**
   * Get a quote, build the swap transaction, sign, and send (or simulate).
   * Mirrors the old executeRaydiumSwap interface for drop-in compatibility with callers.
   */
  async executeSwap({
    inputMint,
    outputMint,
    amount,
    userPublicKey,
    slippageBps = 500,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number | string;
    userPublicKey: string;
    slippageBps?: number;
  }): Promise<JupiterSwapResult> {
    try {
      const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);
      if (!quote) {
        return { success: false, error: "No Jupiter route/quote available" };
      }

      const built = await this.buildSwapTransaction(quote, userPublicKey);
      if (!built) {
        return { success: false, error: "Failed to build Jupiter swap transaction" };
      }

      const tx = VersionedTransaction.deserialize(
        Buffer.from(built.swapTransaction, "base64")
      );

      const useReal = process.env.USE_REAL_SWAP === "true";
      const connection = getConnection();
      const signer = loadKeypairFromEnv();
      tx.sign([signer]);

      if (!useReal) {
        const { value } = await connection.simulateTransaction(tx, {
          commitment: "confirmed",
          sigVerify: false,
        });
        if (value.err) {
          return {
            success: false,
            error: `Simulation failed: ${JSON.stringify(value.err)}`,
          };
        }
        return {
          success: true,
          signature: `sim-${crypto.randomUUID()}`,
          simulated: true,
        };
      }

      const signature = await this.sendRaw(connection, tx);
      await connection.confirmTransaction(
        {
          signature,
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "confirmed"
      );

      LOG.info({ signature }, "Jupiter swap confirmed");
      return { success: true, signature, simulated: false };
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      LOG.error({ err: errorMsg }, "Jupiter swap execution failed");
      return { success: false, error: errorMsg };
    }
  }

  /**
   * GET /tokens/v2/recent — recently-tradable tokens, the sole discovery source.
   * "Recent" is measured from the token's first pool creation time, per Jupiter's docs.
   */
  async getRecentTokens(limit = 100): Promise<JupiterRecentToken[]> {
    try {
      // Cached briefly so independent pollers (main discovery + on-chain-style
      // watcher + stored-token re-checks) don't each hit Jupiter separately.
      const cacheKey = `jupiter:recent:${limit}`;
      const cached = tokenDiscoveryCache.get<JupiterRecentToken[]>(cacheKey);
      if (cached) return cached;

      const { data } = await withRetry(
        () =>
          axios.get(`${this.baseUrl}/tokens/v2/recent`, {
            params: { limit },
            headers: this.headers(),
            timeout: 8000,
          }),
        "getRecentTokens"
      );

      if (!Array.isArray(data)) return [];

      const tokens = data.map(mapRecentToken);
      tokenDiscoveryCache.set(cacheKey, tokens);
      return tokens;
    } catch (err: any) {
      LOG.warn(
        { err: err?.message ?? String(err) },
        "Failed to fetch Jupiter recent tokens"
      );
      return [];
    }
  }

  /**
   * GET /tokens/v2 lookup by mint — used to re-check a single token's metadata/audit.
   */
  async getTokenInfo(mint: string): Promise<JupiterRecentToken | null> {
    try {
      const { data } = await withRetry(
        () =>
          axios.get(`${this.baseUrl}/tokens/v2/search`, {
            params: { query: mint },
            headers: this.headers(),
            timeout: 8000,
          }),
        "getTokenInfo"
      );

      const t = Array.isArray(data) ? data.find((x: any) => x.id === mint) : null;
      if (!t) return null;

      return mapRecentToken(t);
    } catch (err: any) {
      LOG.debug(
        { mint, err: err?.message ?? String(err) },
        "Jupiter token info lookup failed"
      );
      return null;
    }
  }
}

const jupiterService = new JupiterService();
export default jupiterService;

// Named convenience exports matching the old raydium.service.ts call-site shape,
// so downstream files can migrate with a mostly mechanical import swap.
export const getJupiterQuote = (
  inputMint: string,
  outputMint: string,
  amountLamports: number | string | bigint,
  slippageBps?: number
) => jupiterService.getQuote(inputMint, outputMint, amountLamports, slippageBps);

export const executeJupiterSwap = (params: {
  inputMint: string;
  outputMint: string;
  amount: number | string;
  userPublicKey: string;
  slippageBps?: number;
}) => jupiterService.executeSwap(params);

export const getRecentJupiterTokens = (limit?: number) =>
  jupiterService.getRecentTokens(limit);

export const getJupiterTokenInfo = (mint: string) => jupiterService.getTokenInfo(mint);

/**
 * Build an unsigned swap transaction for client-side (frontend wallet) signing.
 * Mirrors the old raydium.service.ts buildRaydiumSwapPayload interface.
 */
export const buildJupiterSwapPayload = async (
  quote: JupiterQuote,
  userPublicKey: string
) => {
  const built = await jupiterService.buildSwapTransaction(quote, userPublicKey);
  if (!built) throw new Error("Failed to build Jupiter swap transaction");
  return { swapTransaction: built.swapTransaction };
};
