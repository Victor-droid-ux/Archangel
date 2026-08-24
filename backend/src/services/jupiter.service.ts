// backend/src/services/jupiter.service.ts
// Single point of contact with Jupiter's aggregator API — quotes, swap execution,
// and the "recent tokens" feed used for discovery. Replaces the old Raydium-only
// execution layer and Pump.fun bonding-curve trading entirely.
import axios from "axios";
import crypto from "crypto";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getConnection, loadKeypairFromEnv } from "./solana.service.js";
import { ENV } from "../utils/env.js";
import { quoteCache, tokenDiscoveryCache } from "./cache.service.js";

const LOG = getLogger("jupiter.service");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Several independent pipelines (tokenDiscovery, jupiterDiscovery, autoBuyer,
// tradeValidation, storedTokenChecker) all funnel through this one file and
// can each fire Jupiter calls for multiple tokens in the same instant. The
// previous approach here just checked "has enough time passed since the last
// request" — but that check-then-set isn't atomic across independent async
// call chains: several chains can all read the same stale `lastRequestAt`,
// each conclude they're clear to fire, and burst anyway. This queue instead
// gives every outgoing Jupiter request a single, real dispatch point: one
// FIFO queue, a hard concurrency cap, and a minimum spacing between dispatch
// times, enforced centrally rather than hoped for.
const MAX_CONCURRENT_REQUESTS = Number(
  process.env.JUPITER_MAX_CONCURRENT_REQUESTS ?? 4
);
const MIN_REQUEST_SPACING_MS = Number(
  process.env.JUPITER_MIN_REQUEST_SPACING_MS ?? 150
);

interface QueuedRequest {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const requestQueue: QueuedRequest[] = [];
let activeRequests = 0;
let lastDispatchAt = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

function pumpQueue(): void {
  if (pumpTimer) return; // a pump is already scheduled; it will re-check on fire
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || requestQueue.length === 0) {
    return;
  }

  const wait = lastDispatchAt + MIN_REQUEST_SPACING_MS - Date.now();
  if (wait > 0) {
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpQueue();
    }, wait);
    return;
  }

  const item = requestQueue.shift()!;
  lastDispatchAt = Date.now();
  activeRequests++;
  item.run().then(
    (result) => {
      activeRequests--;
      item.resolve(result);
      pumpQueue();
    },
    (err) => {
      activeRequests--;
      item.reject(err);
      pumpQueue();
    }
  );

  // Concurrency slot may still be free (or spacing may already be clear for
  // the next one) — try to dispatch more right away instead of waiting for
  // this one to settle.
  pumpQueue();
}

function scheduleJupiterRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestQueue.push({
      run: fn,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pumpQueue();
  });
}

const DEFAULT_RETRIES = Number(process.env.JUPITER_MAX_RETRIES ?? 4);
const RETRY_BACKOFF_BASE_MS = Number(
  process.env.JUPITER_RETRY_BACKOFF_BASE_MS ?? 1000
);

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempt = 0,
  retries = DEFAULT_RETRIES
): Promise<T> {
  try {
    return await scheduleJupiterRequest(fn);
  } catch (err: any) {
    if (err?.response?.status === 429 && attempt < retries) {
      // Exponential backoff (1s, 2s, 4s, 8s, ...) plus a little jitter so a
      // batch of requests that all got 429'd together don't all retry in
      // lockstep and immediately collide again.
      const backoffMs =
        RETRY_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      LOG.warn(
        `Jupiter ${label} 429 — retrying in ${backoffMs}ms (attempt ${
          attempt + 1
        }/${retries})`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return withRetry(fn, label, attempt + 1, retries);
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
    signer,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number | string;
    userPublicKey: string;
    slippageBps?: number;
    // Per-user custodial trading: the wallet that actually signs must match
    // userPublicKey (Jupiter builds the transaction's token accounts/fee
    // payer around userPublicKey, so a mismatched signer would fail on-chain
    // or worse, sign a transaction moving a DIFFERENT wallet's funds).
    // Defaults to the single admin/operator keypair for every existing
    // caller that doesn't pass one — unchanged behavior for them.
    signer?: Keypair;
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
      const actualSigner = signer ?? loadKeypairFromEnv();
      // The transaction was built around userPublicKey (token accounts, fee
      // payer). Signing it with any other keypair would either fail on-chain
      // or, worse, succeed while moving funds/paying fees from the wrong
      // wallet — so this must never be silently mismatched.
      if (actualSigner.publicKey.toBase58() !== userPublicKey) {
        return {
          success: false,
          error: "Signer does not match userPublicKey — refusing to sign",
        };
      }
      tx.sign([actualSigner]);

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

  /**
   * Same lookup as getTokenInfo(), but for many mints in one request.
   * /tokens/v2/search accepts a comma-separated query and returns matches
   * for all of them together — anything validating a whole batch of tokens
   * at once (discovery's per-cycle batch, a stored-token sweep) should use
   * this instead of one getTokenInfo() call per mint; that's what was
   * turning a 4-30 token batch into 4-30 separate rate-limited requests.
   * Chunked at 100 mints per call per Jupiter's documented query limit.
   */
  async getTokenInfoBatch(
    mints: string[]
  ): Promise<Map<string, JupiterRecentToken>> {
    const result = new Map<string, JupiterRecentToken>();
    const uniqueMints = [...new Set(mints)];
    if (uniqueMints.length === 0) return result;

    const CHUNK_SIZE = 100;
    for (let i = 0; i < uniqueMints.length; i += CHUNK_SIZE) {
      const chunk = uniqueMints.slice(i, i + CHUNK_SIZE);
      try {
        const { data } = await withRetry(
          () =>
            axios.get(`${this.baseUrl}/tokens/v2/search`, {
              params: { query: chunk.join(",") },
              headers: this.headers(),
              timeout: 10000,
            }),
          "getTokenInfoBatch"
        );

        if (Array.isArray(data)) {
          for (const raw of data) {
            const mapped = mapRecentToken(raw);
            result.set(mapped.mint, mapped);
          }
        }
      } catch (err: any) {
        LOG.warn(
          { err: err?.message ?? String(err), count: chunk.length },
          "Jupiter batch token info lookup failed"
        );
        // Leave this chunk's mints unresolved (absent from the map) rather
        // than failing the whole batch — callers already treat a missing
        // entry the same as getTokenInfo() returning null.
      }
    }

    return result;
  }
}

const jupiterService = new JupiterService();
export default jupiterService;

// Minimum size for the reference-liquidity probe below — small enough not
// to matter for a real buy, large enough that price-impact stops rounding
// to zero in Jupiter's response even on a fairly thin pool.
const MIN_REFERENCE_PROBE_USD = 25;

/**
 * Liquidity for a token, resolved defensively.
 *
 * getTokenInfo()'s /tokens/v2/search catalog and getQuote()'s /swap/v1/quote
 * are two independent Jupiter systems on different update cadences — a
 * brand-new token can have a real, routable pool (quote succeeds) while the
 * search catalog hasn't indexed it yet (tokenInfo is null, or its liquidity
 * field is 0). Treating that catalog gap as "$0 liquidity" rejects a token
 * Jupiter can actually fill.
 *
 * Prefers the catalog figure when it's present (cheap, no extra request).
 * When it's missing or zero, falls back to a price-impact-implied estimate
 * from one real reference-sized quote — the same routing engine the actual
 * trade will use — instead of assuming zero. If even that reference-sized
 * quote can't route, that IS genuine evidence of thin liquidity, not an API
 * miss, so it's reported as $0 rather than "unavailable".
 */
export async function resolveLiquidityUsd(
  tokenMint: string,
  minLiquidityUsdHint: number,
  tokenInfo: JupiterRecentToken | null,
  solPriceUsd: number
): Promise<{
  liquidityUSD: number;
  source: "metadata" | "impact-estimate" | "unavailable";
}> {
  if (tokenInfo?.liquidity) {
    return { liquidityUSD: tokenInfo.liquidity, source: "metadata" };
  }
  if (solPriceUsd <= 0) {
    return { liquidityUSD: 0, source: "unavailable" };
  }

  const referenceAmountUsd = Math.max(
    minLiquidityUsdHint * 0.05,
    MIN_REFERENCE_PROBE_USD
  );
  const referenceLamports = Math.round(
    (referenceAmountUsd / solPriceUsd) * 1e9
  );
  const referenceQuote = await jupiterService.getQuote(
    SOL_MINT,
    tokenMint,
    referenceLamports,
    500
  );

  if (!referenceQuote) {
    return { liquidityUSD: 0, source: "impact-estimate" };
  }

  const impact = referenceQuote.priceImpactPct;
  if (!Number.isFinite(impact) || impact < 0) {
    return { liquidityUSD: 0, source: "unavailable" };
  }
  if (impact === 0) {
    // Immeasurably small impact from moving referenceAmountUsd — the pool is
    // at least comfortably deeper than that reference size.
    return { liquidityUSD: referenceAmountUsd * 20, source: "impact-estimate" };
  }

  // Constant-product approximation: for a small trade relative to pool
  // depth, price impact ≈ amountIn / reserveIn. Jupiter's own "liquidity"
  // figure is the combined USD value of both sides of the pool, so double
  // the implied one-sided reserve to match that convention.
  const estimated = (2 * referenceAmountUsd) / impact;
  return { liquidityUSD: estimated, source: "impact-estimate" };
}

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
  signer?: Keypair;
}) => jupiterService.executeSwap(params);

export const getRecentJupiterTokens = (limit?: number) =>
  jupiterService.getRecentTokens(limit);

export const getJupiterTokenInfo = (mint: string) => jupiterService.getTokenInfo(mint);
export const getJupiterTokenInfoBatch = (mints: string[]) =>
  jupiterService.getTokenInfoBatch(mints);

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