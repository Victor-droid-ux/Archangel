import axios from "axios";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("birdeye.service");

interface BirdeyeMarketHealth {
  isHealthy: boolean;
  priceImpact: number;
  fdv: number;
  liquidity: number;
  volume5m: number;
  hasSoftRugged: boolean;
  hasSuspiciousSells: boolean;
  isBotActivity: boolean;
  reasons: string[];
}

interface BirdeyePnLData {
  currentPrice: number;
  priceImpact: number;
  unrealizedPnL: number;
  percentChange: number;
  liquidityMovement: number;
  trendDirection: "up" | "down" | "stable";
}

interface BirdeyePriceHistoryPoint {
  timestamp: number; // unix seconds
  price: number;
}

class BirdeyeService {
  private apiKey: string;
  private baseUrl: string;
  // Free-tier Birdeye keys have a low shared rate limit, and several discovery
  // pipelines can call this service concurrently — serialize requests with a
  // minimum spacing instead of letting them all fire at once and 429.
  private lastRequestAt = 0;
  private readonly MIN_REQUEST_SPACING_MS = 1100;

  constructor() {
    this.apiKey = process.env.BIRDEYE_API_KEY || "";
    this.baseUrl =
      process.env.BIRDEYE_BASE_URL || "https://public-api.birdeye.so";
  }

  /**
   * Runs an axios call through a shared rate gate, retrying with backoff on 429.
   */
  private async throttledRequest<T>(
    fn: () => Promise<T>,
    retries = 2,
  ): Promise<T> {
    const wait = this.lastRequestAt + this.MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();

    try {
      return await fn();
    } catch (err: any) {
      if (err?.response?.status === 429 && retries > 0) {
        const backoffMs = 1500 * (3 - retries);
        LOG.warn(`Birdeye 429 — retrying in ${backoffMs}ms (${retries} left)`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.throttledRequest(fn, retries - 1);
      }
      throw err;
    }
  }

  /**
   * Stage 4: BIRDEYE MARKET HEALTH CHECK
   * Ensure token is tradeable and worth entering
   */
  async checkMarketHealth(
    tokenMint: string,
    buyAmountSol: number,
  ): Promise<BirdeyeMarketHealth> {
    LOG.info(
      `📊 Running Birdeye market health check for ${tokenMint.slice(0, 8)}...`,
    );

    try {
      const response = await this.throttledRequest(() =>
        axios.get(`${this.baseUrl}/defi/token_overview`, {
          params: { address: tokenMint },
          headers: {
            "X-API-KEY": this.apiKey,
            "x-chain": "solana",
          },
          timeout: 10000,
        }),
      );

      const data = response.data?.data;

      if (!data) {
        // A 200 with no `data` for this mint means Birdeye's indexer hasn't
        // picked up this token yet — expected for anything genuinely
        // seconds-old, not a signal about the token itself. Treated as
        // neutral (pass) rather than failed: there's nothing here to
        // actually evaluate, so every other check below (price impact, FDV,
        // volume, soft-rug/wash-trading heuristics) is skipped rather than
        // computed against zeros, which would produce false readings (e.g.
        // calculatePriceImpact(0, buyAmountSol) reads as 100% impact).
        // This is distinct from the catch block below (a genuine API/network
        // failure) which still fails closed — an indexing gap and an
        // inability to verify are different situations.
        LOG.info(
          `ℹ️ No Birdeye data yet for ${tokenMint.slice(0, 8)} — treating as neutral (not yet indexed, not unhealthy)`,
        );
        return {
          isHealthy: true,
          priceImpact: 0,
          fdv: 0,
          liquidity: 0,
          volume5m: 0,
          hasSoftRugged: false,
          hasSuspiciousSells: false,
          isBotActivity: false,
          reasons: [
            "No Birdeye data yet (not yet indexed) — skipped, not failed",
          ],
        };
      }

      const reasons: string[] = [];
      let isHealthy = true;

      // Calculate price impact for buy size
      const priceImpact = this.calculatePriceImpact(
        data.liquidity,
        buyAmountSol,
      );
      const maxPriceImpactPct = Number(
        process.env.PIPELINE_MAX_PRICE_IMPACT_PCT ?? 30,
      );
      if (priceImpact > maxPriceImpactPct) {
        reasons.push(`Price impact too high: ${priceImpact.toFixed(2)}%`);
        isHealthy = false;
      }

      // FDV-to-liquidity ratio — an actual ratio (not two independently-ANDed
      // absolute thresholds, which only caught extreme combinations, e.g. it
      // would miss a $2M FDV token with 0.5 SOL liquidity: FDV under the old
      // hardcoded 3M bar even though the ratio is just as bad). This now uses
      // PIPELINE_MAX_FDV_TO_LP_RATIO, which was already defined in .env but
      // never actually read anywhere in the code.
      const fdv = data.fdv || 0;
      const liquidity = data.liquidity || 0;
      const maxFdvToLpRatio = Number(
        process.env.PIPELINE_MAX_FDV_TO_LP_RATIO ?? 1_500_000,
      );
      const fdvToLpRatio = liquidity > 0 ? fdv / liquidity : Infinity;
      if (fdvToLpRatio > maxFdvToLpRatio) {
        reasons.push(
          `FDV/LP ratio too high: ${fdv} / ${liquidity} SOL = ${fdvToLpRatio.toFixed(0)} > ${maxFdvToLpRatio}`,
        );
        isHealthy = false;
      }

      // Check volume (Birdeye's real field is v5mUSD, not volume5m — verified
      // against a live API response on 2026-08-12)
      const volume5m = data.v5mUSD || 0;
      const minVolume5m = Number(process.env.PIPELINE_MIN_VOLUME_5M_SOL ?? 1);
      if (volume5m < minVolume5m) {
        reasons.push(
          `Volume too low: $${volume5m.toFixed(2)} in last 5 minutes`,
        );
        isHealthy = false;
      }

      // Check for soft rug
      const hasSoftRugged = this.detectSoftRug(data);
      if (hasSoftRugged) {
        reasons.push("Soft rug detected");
        isHealthy = false;
      }

      // Check for suspicious sells
      const hasSuspiciousSells = this.detectSuspiciousSells(data);
      if (hasSuspiciousSells) {
        reasons.push("Suspicious massive sells detected");
        isHealthy = false;
      }

      // Check for bot activity
      const isBotActivity = this.detectBotActivity(data);
      if (isBotActivity) {
        reasons.push("Bot-only wash trading detected");
        isHealthy = false;
      }

      if (isHealthy) {
        LOG.info(`✅ Market health check PASSED for ${tokenMint.slice(0, 8)}`);
      } else {
        LOG.warn(
          `❌ Market health check FAILED for ${tokenMint.slice(
            0,
            8,
          )}: ${reasons.join(", ")}`,
        );
      }

      return {
        isHealthy,
        priceImpact,
        fdv,
        liquidity,
        volume5m,
        hasSoftRugged,
        hasSuspiciousSells,
        isBotActivity,
        reasons,
      };
    } catch (error: any) {
      LOG.error(`Error checking market health: ${error.message}`);
      return {
        isHealthy: false,
        priceImpact: 100,
        fdv: 0,
        liquidity: 0,
        volume5m: 0,
        hasSoftRugged: false,
        hasSuspiciousSells: false,
        isBotActivity: false,
        reasons: [`API Error: ${error.message}`],
      };
    }
  }

  /**
   * Stage 7: LIVE P&L TRACKING
   * Pull real-time data from Birdeye
   */
  async getPnLData(
    tokenMint: string,
    entryPrice: number,
  ): Promise<BirdeyePnLData> {
    // No try/catch fallback here on purpose: this feeds a live, real-money
    // PnL display (LivePnL.tsx via pnlTracker.service.ts). A caught error used
    // to return { unrealizedPnL: 0, percentChange: 0 } — a fabricated "flat"
    // reading indistinguishable from a genuinely unchanged position, which is
    // actively misleading on exactly the API hiccups it was meant to survive.
    // Letting the error propagate makes the caller (pnlTracker's poll loop)
    // skip that tick's broadcast instead, leaving the last real value on
    // screen rather than overwriting it with a fake one.
    //
    // /defi/price verified against a live response on 2026-08-13: it only
    // returns { value, updateUnixTime, priceChange24h, priceInNative } — no
    // priceImpact/liquidityChange fields exist on this endpoint, so those two
    // outputs below are structurally unavailable here (not a bug, just not
    // what this endpoint reports; priceImpact would need a quote, not a price
    // lookup, and Birdeye doesn't expose liquidity delta on this call).
    const response = await this.throttledRequest(() =>
      axios.get(`${this.baseUrl}/defi/price`, {
        params: { address: tokenMint },
        headers: {
          "X-API-KEY": this.apiKey,
        },
        timeout: 5000,
      }),
    );

    const data = response.data?.data;

    if (!data) {
      throw new Error("No price data from Birdeye");
    }

    const currentPrice = data.value || 0;
    const percentChange = ((currentPrice - entryPrice) / entryPrice) * 100;
    const unrealizedPnL = currentPrice - entryPrice;

    let trendDirection: "up" | "down" | "stable" = "stable";
    if (percentChange > 2) trendDirection = "up";
    else if (percentChange < -2) trendDirection = "down";

    return {
      currentPrice,
      priceImpact: 0,
      unrealizedPnL,
      percentChange,
      liquidityMovement: 0,
      trendDirection,
    };
  }

  async getCurrentPrice(tokenMint: string): Promise<number | null> {
    try {
      const response = await this.throttledRequest(() =>
        axios.get(`${this.baseUrl}/defi/price`, {
          params: { address: tokenMint },
          headers: { "X-API-KEY": this.apiKey },
          timeout: 5000,
        }),
      );
      const price = Number(response.data?.data?.value);
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch (err: any) {
      LOG.debug(
        { tokenMint, err: err?.message },
        "Birdeye price fallback failed",
      );
      return null;
    }
  }

  /**
   * Historical price series, used by strategies (momentum, breakout, mean-reversion)
   * to evaluate tokens that already have an established trading history rather than
   * ones picked up at the moment of first pool creation.
   */
  async getPriceHistory(
    tokenMint: string,
    options: { intervalMinutes?: number; lookbackMinutes?: number } = {},
  ): Promise<BirdeyePriceHistoryPoint[]> {
    const { intervalMinutes = 15, lookbackMinutes = 6 * 60 } = options;
    const typeByMinutes: Record<number, string> = {
      1: "1m",
      5: "5m",
      15: "15m",
      30: "30m",
      60: "1H",
      240: "4H",
      1440: "1D",
    };
    const type = typeByMinutes[intervalMinutes] || "15m";
    const timeTo = Math.floor(Date.now() / 1000);
    const timeFrom = timeTo - lookbackMinutes * 60;

    try {
      const response = await this.throttledRequest(() =>
        axios.get(`${this.baseUrl}/defi/history_price`, {
          params: {
            address: tokenMint,
            address_type: "token",
            type,
            time_from: timeFrom,
            time_to: timeTo,
          },
          headers: {
            "X-API-KEY": this.apiKey,
            "x-chain": "solana",
          },
          timeout: 8000,
        }),
      );

      const items = response.data?.data?.items;
      if (!Array.isArray(items)) return [];

      return items
        .filter(
          (it: any) =>
            typeof it?.value === "number" && typeof it?.unixTime === "number",
        )
        .map((it: any) => ({ timestamp: it.unixTime, price: it.value }));
    } catch (error: any) {
      LOG.debug(
        `Price history unavailable for ${tokenMint.slice(0, 8)}: ${error.message}`,
      );
      return [];
    }
  }

  // Helper methods
  private calculatePriceImpact(liquidity: number, tradeSize: number): number {
    if (liquidity === 0) return 100;
    return (tradeSize / liquidity) * 100;
  }

  // Note: token_overview has no liquidity-history/delta field (verified against
  // a live response on 2026-08-13), so "soft rug" can't be detected via LP
  // removal directly. Proxy instead via a sharp, sustained price crash combined
  // with traders visibly fleeing (unique wallet count dropping fast) — the
  // observable symptom of a rug even without a direct liquidity-delta signal.
  private detectSoftRug(data: any): boolean {
    const priceChange5m = Number(data?.priceChange5mPercent ?? 0);
    const priceChange30m = Number(data?.priceChange30mPercent ?? 0);
    const priceCollapsed = priceChange5m <= -30 && priceChange30m <= -40;

    // uniqueWallet5mChangePercent is sparse/often absent on tokens this
    // fresh — requiring it unconditionally meant this check could never fire
    // on exactly the population it's meant to protect (brand-new tokens with
    // no wallet-flight history yet). Treat it as confirming evidence when
    // the field is actually present, not a hard requirement.
    if (data?.uniqueWallet5mChangePercent == null) {
      return priceCollapsed;
    }
    const walletChange5m = Number(data.uniqueWallet5mChangePercent);
    return priceCollapsed && walletChange5m <= -50;
  }

  // A handful of large sells (few trades, large sell-side volume) is a
  // whale/insider-dump signature, distinct from broad organic sell pressure
  // spread across many traders/trades.
  private detectSuspiciousSells(data: any): boolean {
    const sellCount5m = Number(data?.sell5m ?? 0);
    const vBuy5m = Number(data?.vBuy5mUSD ?? 0);
    const vSell5m = Number(data?.vSell5mUSD ?? 0);
    if (vBuy5m <= 0 || vSell5m <= 0) return false;
    const sellToBuyRatio = vSell5m / vBuy5m;
    return sellCount5m > 0 && sellCount5m <= 3 && sellToBuyRatio >= 5;
  }

  // Wash trading / bot round-tripping shows as a high trade count from very
  // few distinct wallets — real organic activity has a much lower
  // trades-per-unique-wallet ratio.
  private detectBotActivity(data: any): boolean {
    const trade5m = Number(data?.trade5m ?? 0);
    const uniqueWallet5m = Number(data?.uniqueWallet5m ?? 0);
    if (uniqueWallet5m <= 0 || trade5m < 20) return false; // not enough activity to judge
    return trade5m / uniqueWallet5m >= 10;
  }
}

export default new BirdeyeService();
export { BirdeyeMarketHealth, BirdeyePnLData, BirdeyePriceHistoryPoint };
