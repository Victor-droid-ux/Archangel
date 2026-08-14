// backend/src/services/tokenChart.service.ts
import birdeyeService from "./birdeye.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenChart.service");

export interface ChartPoint {
  time: string; // ISO timestamp
  price: number;
}

// intervalMinutes/lookbackMinutes per timeframe, matching birdeye.service.ts's
// supported candle types (getPriceHistory maps these to Birdeye's "type" param)
const TIMEFRAME_CONFIG: Record<
  string,
  { intervalMinutes: number; lookbackMinutes: number }
> = {
  "1h": { intervalMinutes: 1, lookbackMinutes: 60 },
  "24h": { intervalMinutes: 15, lookbackMinutes: 24 * 60 },
  "7d": { intervalMinutes: 60, lookbackMinutes: 7 * 24 * 60 },
  "30d": { intervalMinutes: 240, lookbackMinutes: 30 * 24 * 60 },
};

export async function getTokenChartData(
  mint: string,
  tf: string = "24h"
): Promise<ChartPoint[]> {
  const config = TIMEFRAME_CONFIG[tf] ?? TIMEFRAME_CONFIG["24h"];

  const history = await birdeyeService.getPriceHistory(mint, config);

  if (history.length === 0) {
    log.debug(
      { mint: mint.slice(0, 8), tf },
      "No price history available for chart"
    );
  }

  return history.map((point) => ({
    time: new Date(point.timestamp * 1000).toISOString(),
    price: point.price,
  }));
}
