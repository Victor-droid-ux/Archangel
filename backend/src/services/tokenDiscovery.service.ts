import { getLogger } from "../utils/logger.js";
import { registerAutoBuyCandidate } from "./autoBuyer.service.js";
import { Server } from "socket.io";
import jupiterService, {
  JupiterRecentToken,
  getSolPriceUsd,
} from "./jupiter.service.js";
import dbService from "./db.service.js";
import { getRuntimeConfig } from "../routes/config.route.js";
import {
  validateTokenBatch,
  TokenLifecycleStage,
  type TokenLifecycleResult,
} from "./tokenLifecycle.service.js";
import { addTrackedToken } from "./tokenPrice.service.js";

const log = getLogger("tokenDiscovery");

// Known stablecoins/wrapped tokens — never treat these as "new token" candidates
const EXCLUDED_TOKENS = new Set([
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // Wrapped ETH
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
]);

/**
 * Calculate token score (0-100) from Jupiter's own token metadata.
 */
function calculateTokenScore(t: JupiterRecentToken): number {
  let score = 0;

  // Liquidity score (0-30 points)
  if (t.liquidity > 100000) score += 30;
  else if (t.liquidity > 50000) score += 25;
  else if (t.liquidity > 20000) score += 20;
  else if (t.liquidity > 5000) score += 15;
  else if (t.liquidity > 1000) score += 10;
  else if (t.liquidity > 100) score += 5;

  // Market cap score (0-20 points)
  if (t.mcap > 5000000) score += 20;
  else if (t.mcap > 1000000) score += 16;
  else if (t.mcap > 500000) score += 12;
  else if (t.mcap > 100000) score += 8;
  else if (t.mcap > 10000) score += 4;

  // Holder count score (0-20 points)
  if (t.holderCount > 500) score += 20;
  else if (t.holderCount > 100) score += 15;
  else if (t.holderCount > 20) score += 10;
  else if (t.holderCount > 5) score += 5;

  // Organic score (0-20 points) — Jupiter's own bot/wash-trading heuristic
  score += Math.round((t.organicScore / 100) * 20);

  // Recent buy pressure (0-10 points)
  if (t.numBuys5m > 20) score += 10;
  else if (t.numBuys5m > 5) score += 5;
  else if (t.numBuys5m > 0) score += 2;

  return Math.min(100, Math.max(0, score));
}

/**
 * Assess rug pull risk based on Jupiter's own metadata.
 */
function assessRugPullRisk(t: JupiterRecentToken): "low" | "medium" | "high" {
  let riskFlags = 0;

  if (t.liquidity < 500) riskFlags += 3;
  else if (t.liquidity < 2000) riskFlags += 2;
  else if (t.liquidity < 10000) riskFlags += 1;

  if (!t.mintAuthorityDisabled) riskFlags += 2;
  if (!t.freezeAuthorityDisabled) riskFlags += 2;

  if (t.holderCount < 5) riskFlags += 1;
  if (t.numBuys5m === 0) riskFlags += 1;

  if (riskFlags >= 5) return "high";
  if (riskFlags >= 3) return "medium";
  return "low";
}

function getTokenAgeHours(firstPoolCreatedAt: number): number | undefined {
  if (!firstPoolCreatedAt) return undefined;
  return (Date.now() - firstPoolCreatedAt) / (1000 * 60 * 60);
}

export type CandidateToken = {
  symbol?: string;
  mint: string;
  name?: string;
  priceSol: number | null;
  liquidity: number | null; // USD
  marketCapSol: number | null;
  score?: number;
  riskLevel?: "low" | "medium" | "high";
  age?: number | undefined; // hours since first pool
  pairCreatedAt?: number | undefined; // ms epoch, used by autoBuyer's launch-window filter
  holderCount?: number;
  organicScore?: number;
  // Lifecycle validation fields
  lifecycleStage?: TokenLifecycleStage;
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number | undefined;
  poolAddress?: string | undefined;
};

/**
 * Fetch the current "new tokens" universe directly from Jupiter — this is now
 * the sole discovery source (previously DexScreener + Pump.fun bonding-curve data).
 */
export async function fetchTokenList(): Promise<JupiterRecentToken[]> {
  return jupiterService.getRecentTokens(100);
}

/**
 * Start token watcher
 * - polls Jupiter's recent-tokens feed every intervalMs
 * - emits tokenFeed via socket when the list updates
 * - triggers auto-buy for tokens that are confirmed tradable on Jupiter
 */
export function startTokenWatcher(io: Server, opts?: { intervalMs?: number }) {
  const intervalMs = opts?.intervalMs ?? 10_000;
  let currentMints = new Set<string>();
  const config = getRuntimeConfig();

  log.info(
    `Starting token watcher (Jupiter recent-tokens feed) intervalMs=${intervalMs} MIN_SCORE=${config.minTokenScore}`
  );

  const tick = async () => {
    try {
      const tokens = await fetchTokenList();
      if (!tokens || tokens.length === 0) {
        log.warn("Jupiter recent-tokens list unavailable/empty");
        return;
      }

      log.info(`Processing ${tokens.length} tokens from Jupiter`);

      const runtimeConfig = getRuntimeConfig();

      // No age filtering here anymore — Max Token Age and Launch Window are
      // now each wallet's own setting (see traderConfig.service.ts's
      // getEffectiveMaxTokenAgeSeconds/getEffectiveLaunchWindowSeconds),
      // evaluated per-wallet in autoBuyer.service.ts's fan-out loop. Filtering
      // by a single value here would mean one wallet's setting decides
      // whether ANY wallet even gets a chance to see/buy a token.
      const filtered = tokens.filter((t) => {
        if (!t.mint || !t.symbol) return false;
        if (EXCLUDED_TOKENS.has(t.mint)) return false;
        if (/(USDC|USDT|USD|DAI|BUSD|TUSD|USDH|USDS)/i.test(t.symbol)) return false;
        return true;
      });

      const solPriceUsd = await getSolPriceUsd();
      const byMint = new Map(filtered.map((t) => [t.mint, t]));

      const candidates: CandidateToken[] = filtered
        .map((t) => {
          const score = calculateTokenScore(t);
          const riskLevel = assessRugPullRisk(t);
          const age = getTokenAgeHours(t.firstPoolCreatedAt);
          return {
            symbol: t.symbol,
            mint: t.mint,
            name: t.name,
            priceSol: t.usdPrice > 0 ? t.usdPrice / solPriceUsd : null,
            liquidity: t.liquidity,
            marketCapSol: t.mcap ? t.mcap / solPriceUsd : null,
            score,
            riskLevel,
            age,
            pairCreatedAt: t.firstPoolCreatedAt || undefined,
            holderCount: t.holderCount,
            organicScore: t.organicScore,
          };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0));

      const scoredCandidates = candidates.filter(
        (t) => (t.score || 0) >= runtimeConfig.minTokenScore
      );

      const avgScore =
        scoredCandidates.length > 0
          ? Math.round(
              scoredCandidates.reduce((sum, t) => sum + (t.score || 0), 0) /
                scoredCandidates.length
            )
          : 0;

      log.info(
        `Filtered to ${scoredCandidates.length}/${tokens.length} tokens (avg score: ${avgScore})`
      );

      // === TRADABILITY VALIDATION (Jupiter route + liquidity) ===
      log.info(`Running tradability validation on ${scoredCandidates.length} tokens...`);
      const tokenMints = scoredCandidates.map((t) => t.mint);
      const lifecycleValidation = await validateTokenBatch(tokenMints);

      const validatedCandidates: CandidateToken[] = scoredCandidates.map((candidate) => {
        try {
          const raw = byMint.get(candidate.mint);
          addTrackedToken(candidate.mint, candidate.symbol || "", {
            name: raw?.name,
            decimals: raw?.decimals,
            price: raw?.usdPrice,
            priceSol: candidate.priceSol,
            marketCap: raw?.mcap,
            liquidity: raw?.liquidity,
            volume24h: raw?.volume24h,
            priceChange1h: raw?.priceChange1h,
            priceChange24h: raw?.priceChange24h,
            circulatingSupply: raw?.circSupply,
            totalSupply: raw?.totalSupply,
          });
        } catch (e) {
          log.warn(`Failed to add token to tracked list: ${candidate.mint}`);
        }

        const lifecycleResult: TokenLifecycleResult | undefined = lifecycleValidation.tradable
          .concat(lifecycleValidation.notTradable)
          .find((lc) => lc.mint === candidate.mint);

        if (lifecycleResult) {
          return {
            ...candidate,
            lifecycleStage: lifecycleResult.stage,
            lifecycleValidated: true,
            isTradable: lifecycleResult.isTradable,
            hasLiquidity: lifecycleResult.hasLiquidity,
            liquiditySOL: lifecycleResult.liquiditySOL,
            poolAddress: lifecycleResult.poolAddress,
          };
        }
        return { ...candidate, lifecycleValidated: false };
      });

      const tradableCandidates = validatedCandidates.filter((t) => t.isTradable);
      const notTradableTokens = validatedCandidates.filter((t) => !t.isTradable);

      log.info(
        `✅ Tradability validation complete: ${tradableCandidates.length} tradable on Jupiter, ${notTradableTokens.length} not yet tradable`
      );

      io.emit("tokenFeed", {
        tokens: validatedCandidates,
        tradable: tradableCandidates,
        notTradable: notTradableTokens,
        lifecycleSummary: {
          ...lifecycleValidation.summary,
          tradableCandidates: tradableCandidates.length,
        },
      });

      // New mints → DB watchlist entry + auto-buy trigger if tradable
      for (const tk of validatedCandidates) {
        if (!tk.mint || currentMints.has(tk.mint)) continue;
        currentMints.add(tk.mint);

        // Use Jupiter's own USD mcap directly rather than round-tripping
        // through marketCapSol (itself already derived from this same USD
        // value via a live SOL price) with a hardcoded $150 SOL price — that
        // silently skewed marketCapUSD by however far real SOL price drifts
        // from $150, disagreeing with the correct value already shown
        // elsewhere (e.g. the price cache used by /api/tokens).
        const marketCapUSD = byMint.get(tk.mint)?.mcap ?? 0;

        if (tk.isTradable) {
          log.info(
            `🚀 TRADABLE ON JUPITER: ${tk.symbol} (${tk.mint.slice(0, 8)}...) | Liquidity: $${
              tk.liquidity?.toFixed(0)
            } | Pool: ${tk.poolAddress?.slice(0, 8)}...`
          );

          await dbService.upsertTokenState({
            mint: tk.mint,
            symbol: tk.symbol || "UNKNOWN",
            name: tk.name || "Unknown Token",
            state: "TRADABLE",
            source: "jupiter",
            marketCapUSD,
            jupiterTradable: true,
            liquiditySOL: tk.liquiditySOL || 0,
            liquidityUSD: tk.liquidity || 0,
            poolAddress: tk.poolAddress || "",
            ...(byMint.get(tk.mint)?.devAddress
              ? { creatorAddress: byMint.get(tk.mint)!.devAddress! }
              : {}),
            confirmedTradableAt: new Date(),
            detectedAt: new Date(),
          });

          registerAutoBuyCandidate(io, tk).catch((e: any) => {
            const emsg =
              e && typeof e === "object" && "message" in e ? (e as any).message : String(e);
            log.error(`registerAutoBuyCandidate failed: ${emsg}`);
          });
        } else {
          log.debug(
            `📋 WATCHLIST: ${tk.symbol} (${tk.mint.slice(0, 8)}...) - discovered, not yet tradable`
          );

          await dbService.upsertTokenState({
            mint: tk.mint,
            symbol: tk.symbol || "UNKNOWN",
            name: tk.name || "Unknown Token",
            state: "DISCOVERED",
            source: "jupiter",
            marketCapUSD,
            jupiterTradable: false,
            ...(byMint.get(tk.mint)?.devAddress
              ? { creatorAddress: byMint.get(tk.mint)!.devAddress! }
              : {}),
            detectedAt: new Date(),
          });
        }
      }

      // prune currentMints to keep bounded size
      if (currentMints.size > 2000) {
        const keys = Array.from(currentMints).slice(-1000);
        currentMints = new Set(keys);
      }
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err ? (err as any).message : String(err);
      log.error(`Token watcher tick failed: ${msg}`);
    }
  };

  const handle = setInterval(tick, intervalMs);
  tick().catch((e: any) => {
    const msg = e && typeof e === "object" && "message" in e ? (e as any).message : String(e);
    log.warn(`Initial token tick failed: ${msg}`);
  });

  return () => {
    clearInterval(handle);
    log.info("Token watcher stopped");
  };
}

export default { startTokenWatcher };
