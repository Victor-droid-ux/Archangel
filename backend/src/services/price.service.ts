// backend/src/services/price.service.ts
import axios, { AxiosInstance } from "axios";
import { getLogger } from "../utils/logger.js";
import { tokenPriceCache, tokenMetadataCache } from "./cache.service.js";

const log = getLogger("price.service");

/* ----------------------------- CONFIG ----------------------------- */
// Helius DAS endpoint for token metadata and price lookups (primary data source)
const HELIUS_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

// Birdeye for price data
const BIRDEYE_BASE_URL =
  process.env.BIRDEYE_BASE_URL || "https://public-api.birdeye.so";
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || null;

const birdeyeClient: AxiosInstance = axios.create({
  baseURL: BIRDEYE_BASE_URL,
  timeout: 10_000,
  headers: {
    accept: "application/json",
    ...(BIRDEYE_API_KEY ? { "X-API-KEY": BIRDEYE_API_KEY } : {}),
    "x-chain": "solana",
  },
});

const MAX_TOKENS_TO_FETCH = 100;

// Common token list - can be extended or fetched from Jupiter's token API
const KNOWN_TOKENS = [
  {
    address: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
  },
  {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  {
    address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
  },
  {
    address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    symbol: "ETH",
    name: "Wrapped Ethereum",
    decimals: 8,
  },
];

/* ----------------------------- HELPERS ----------------------------- */
async function retry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 300) {
  let lastErr: any;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/* ----------------------------- PUBLIC API ----------------------------- */

/**
 * Fetch token list - returns known tokens
 * Can be extended to fetch from Raydium or other sources
 */
export async function fetchTokenList() {
  // Return known tokens - this can be extended to fetch from an API
  log.info({ count: KNOWN_TOKENS.length }, "Using known token list");
  return { tokens: KNOWN_TOKENS };
}

/**
 * Fetch single token price from Birdeye
 */
async function fetchBirdeyePrice(mint: string): Promise<{
  price: number | null;
  liquidity?: number;
  marketCap?: number;
}> {
  // Check cache first
  const cacheKey = `price:${mint}`;
  const cached = tokenPriceCache.get<any>(cacheKey);
  if (cached) {
    return cached;
  }

  if (!BIRDEYE_API_KEY) {
    log.warn("BIRDEYE_API_KEY not set - cannot fetch prices");
    return { price: null };
  }

  try {
    const res = await retry(
      () =>
        birdeyeClient.get("/defi/price", {
          params: {
            address: mint,
            address_type: "token",
            include_liquidity: true,
          },
        }),
      1,
      300
    );

    const data = res.data?.data || res.data;
    const rawPrice =
      data?.value ?? data?.price ?? data?.priceUsd ?? data?.price_usd;
    const rawLiq = data?.liquidity ?? data?.liquidityUsd ?? data?.liquidity_usd;
    const rawMc = data?.marketCap ?? data?.market_cap;

    const price =
      rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : null;
    const liquidity =
      rawLiq !== undefined && rawLiq !== null ? Number(rawLiq) : undefined;
    const marketCap =
      rawMc !== undefined && rawMc !== null ? Number(rawMc) : undefined;

    if (price == null || Number.isNaN(price)) {
      return { price: null };
    }

    const result: { price: number; liquidity?: number; marketCap?: number } = {
      price,
    };
    if (liquidity !== undefined) result.liquidity = liquidity;
    if (marketCap !== undefined) result.marketCap = marketCap;

    // Cache the result
    tokenPriceCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    log.warn({ mint, err: err?.message }, "Birdeye price fetch failed");
    return { price: null };
  }
}

/**
 * Fetch multiple token prices using Birdeye
 */
async function fetchBirdeyePrices(mints: string[]) {
  if (!BIRDEYE_API_KEY) {
    log.warn("BIRDEYE_API_KEY not set - cannot fetch prices");
    return {};
  }

  try {
    // Birdeye multi-price endpoint
    const res = await retry(
      () =>
        birdeyeClient.get("/defi/multi_price", {
          params: {
            list_address: mints.join(","),
          },
        }),
      2,
      400
    );

    const data = res.data?.data || res.data;
    const out: Record<
      string,
      { price: number; liquidity?: number; marketCap?: number; source: string }
    > = {};

    if (data && typeof data === "object") {
      for (const [mint, priceData] of Object.entries(data)) {
        const info: any = priceData;
        const rawPrice = info?.value ?? info?.price;
        const rawLiq = info?.liquidity ?? info?.liquidityUsd;
        const rawMc = info?.marketCap ?? info?.market_cap;

        const price =
          rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : null;

        if (price != null && !Number.isNaN(price)) {
          const entry: any = { price, source: "birdeye" };

          if (rawLiq !== undefined && rawLiq !== null) {
            entry.liquidity = Number(rawLiq);
          }
          if (rawMc !== undefined && rawMc !== null) {
            entry.marketCap = Number(rawMc);
          }

          out[mint] = entry;
        }
      }
    }

    return out;
  } catch (err: any) {
    log.warn({ err: err?.message }, "Birdeye multi-price fetch failed");
    return {};
  }
}

/**
 * Fetch token prices for multiple mints
 * Uses Birdeye as the primary source
 */
export async function fetchPricesForMints(mints: string[]) {
  try {
    if (!mints || mints.length === 0) return {};

    log.info({ mints: mints.length }, "Fetching token prices from Birdeye");

    // Check cache for all mints first
    const prices: Record<string, any> = {};
    const uncachedMints: string[] = [];

    for (const mint of mints) {
      const cacheKey = `price:${mint}`;
      const cached = tokenPriceCache.get<any>(cacheKey);
      if (cached) {
        prices[mint] = cached;
      } else {
        uncachedMints.push(mint);
      }
    }

    if (uncachedMints.length === 0) {
      log.info("All prices retrieved from cache");
      return prices;
    }

    log.info(
      {
        cached: mints.length - uncachedMints.length,
        uncached: uncachedMints.length,
      },
      "Cache stats"
    );

    // Fetch all uncached prices from Birdeye
    const birdeyePrices = await fetchBirdeyePrices(uncachedMints);

    // Merge with cached prices and cache new results
    for (const [mint, priceData] of Object.entries(birdeyePrices)) {
      prices[mint] = priceData;
      const cacheKey = `price:${mint}`;
      tokenPriceCache.set(cacheKey, priceData);
    }

    // Fill in missing prices one by one (rate-limited)
    const missing = uncachedMints.filter((m) => !prices[m]);
    const MAX_INDIVIDUAL_FETCH = 20;

    if (missing.length > 0) {
      log.info(
        {
          missing: missing.length,
          fetching: Math.min(missing.length, MAX_INDIVIDUAL_FETCH),
        },
        "Fetching missing prices individually"
      );

      for (const mint of missing.slice(0, MAX_INDIVIDUAL_FETCH)) {
        const { price, liquidity, marketCap } = await fetchBirdeyePrice(mint);
        if (price != null) {
          const entry: any = { price, source: "birdeye" };
          if (liquidity !== undefined) entry.liquidity = liquidity;
          if (marketCap !== undefined) entry.marketCap = marketCap;
          prices[mint] = entry;
        }
      }
    }

    log.info(
      { tokensFound: Object.keys(prices).length },
      "✅ Fetched token prices from Birdeye"
    );
    return prices;
  } catch (err: any) {
    log.error({ err: err?.message }, "fetchPricesForMints failed");
    return {};
  }
}

/**
 * Fetch token prices merged with metadata
 */
export async function fetchTokenPrices() {
  try {
    const tokenList = await fetchTokenList();

    if (!tokenList || !Array.isArray(tokenList.tokens)) {
      log.warn("fetchTokenPrices: Invalid token list - returning empty array");
      return [];
    }

    const tokens = tokenList.tokens.slice(0, MAX_TOKENS_TO_FETCH);
    log.info(
      { tokenCount: tokens.length, total: tokenList.tokens.length },
      "Fetching prices for top tokens"
    );

    const mints = tokens.map((t: any) => t.address);
    const pricesMap = await fetchPricesForMints(mints);

    const merged = tokens.map((t: any) => {
      const priceInfo = pricesMap[t.address];
      const price = priceInfo?.price ?? null;
      const marketCap = priceInfo?.marketCap ?? t.extensions?.marketCap ?? null;
      const liquidity = priceInfo?.liquidity ?? t.extensions?.liquidity ?? null;

      return {
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoURI: t.logoURI,
        tags: t.tags,
        extensions: t.extensions,
        price,
        marketCap,
        liquidity,
        priceSource: priceInfo?.source ?? null,
      };
    });

    return merged;
  } catch (err: any) {
    log.warn("fetchTokenPrices failed", err?.message ?? err);
    return [];
  }
}
