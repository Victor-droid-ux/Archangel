import birdeyeService from "../services/birdeye.service.js";

// Fetch price, liquidity, and volume history for a token, used by strategies that
// need an established trading history (momentum, breakout, mean-reversion).
// Brand-new pool/mint candidates have no history by definition - those are handled
// separately by sniperStrategy via tokenMeta.justLaunched.
export async function getTokenHistory(mint: string): Promise<{
  priceHistory: number[];
  liquidityHistory: number[];
  volumeHistory: number[];
}> {
  const points = await birdeyeService.getPriceHistory(mint, {
    intervalMinutes: 15,
    lookbackMinutes: 6 * 60,
  });

  return {
    priceHistory: points.map((p) => p.price),
    // Birdeye's history_price endpoint doesn't return per-point liquidity/volume;
    // liquidityGrowthStrategy correctly stays gated on "not enough data" rather
    // than being fed fabricated numbers until a real time-series source exists.
    liquidityHistory: [],
    volumeHistory: [],
  };
}
