// backend/src/services/traderConfig.service.ts
import { getLogger } from "../utils/logger.js";
import { MongoClient, Db } from "mongodb";
import { Server } from "socket.io";

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "archangel";

let dbInstance: Db | null = null;

async function getDb(): Promise<Db> {
  if (dbInstance) return dbInstance;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  dbInstance = client.db(MONGO_DB_NAME);
  return dbInstance;
}

const log = getLogger("TraderConfigService");

export interface TraderConfig {
  walletAddress: string;
  globalSettings: {
    minMarketCapSol?: number;
    maxMarketCapSol?: number;
    minMarketCapUsd?: number;
    maxMarketCapUsd?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    maxTokenAgeHours?: number;
    minTokenScore?: number;
    autoTradeEnabled?: boolean;
    maxTradeAmountSol?: number;
  };
  tokenSpecificSettings: {
    [mint: string]: {
      minMarketCapSol?: number;
      maxMarketCapSol?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      entryPriceSol?: number;
      triggerMarketCapSol?: number; // MC at which trade should trigger
      autoTrade?: boolean;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get trader configuration
 */
export async function getTraderConfig(
  walletAddress: string
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();
    const config = await db
      .collection<TraderConfig>("traderConfigs")
      .findOne({ walletAddress });

    return config;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get trader config");
    return null;
  }
}

/**
 * Create or update trader global settings
 */
export async function updateGlobalSettings(
  walletAddress: string,
  settings: TraderConfig["globalSettings"],
  io?: Server
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $set: {
            globalSettings: settings,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            walletAddress,
            tokenSpecificSettings: {},
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" }
      );

    log.info({ walletAddress, settings }, "Updated global trader settings");

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to update global settings");
    return null;
  }
}

/**
 * Set token-specific trading configuration
 */
export async function setTokenConfig(
  walletAddress: string,
  mint: string,
  config: TraderConfig["tokenSpecificSettings"][string],
  io?: Server
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $set: {
            [`tokenSpecificSettings.${mint}`]: config,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            walletAddress,
            globalSettings: {},
            tokenSpecificSettings: {},
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" }
      );

    log.info(
      { walletAddress, mint, config },
      "Set token-specific configuration"
    );

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to set token config");
    return null;
  }
}

/**
 * Remove token-specific configuration
 */
export async function removeTokenConfig(
  walletAddress: string,
  mint: string,
  io?: Server
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $unset: {
            [`tokenSpecificSettings.${mint}`]: "",
          },
          $set: {
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

    log.info({ walletAddress, mint }, "Removed token-specific configuration");

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to remove token config");
    return null;
  }
}

/**
 * Get effective configuration for a specific token
 * (token-specific settings override global settings)
 */
export async function getEffectiveConfig(
  walletAddress: string,
  mint: string
): Promise<{
  minMarketCapSol: number;
  maxMarketCapSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  triggerMarketCapSol?: number;
  autoTrade: boolean;
}> {
  const config = await getTraderConfig(walletAddress);

  // Default values from environment
  const defaults = {
    minMarketCapSol: Number(process.env.MIN_MARKETCAP_SOL ?? 5),
    maxMarketCapSol: Number(process.env.MAX_MARKETCAP_SOL ?? 1000000),
    takeProfitPct: Number(process.env.TP_PCT ?? 0.1),
    // Must match monitor.service.ts's DEFAULT_SL_PCT fallback (0.3) — that
    // 2% figure was the pre-fix default that caused a self-inflicted
    // stop-loss bug (see monitor.service.ts). Both read SL_PCT so they agree
    // whenever it's set, but diverged silently if it were ever unset.
    stopLossPct: Number(process.env.SL_PCT ?? 0.3),
    autoTrade: false,
  };

  if (!config) {
    return defaults;
  }

  // Get token-specific settings
  const tokenSettings = config.tokenSpecificSettings[mint] || {};

  // Merge: defaults < global < token-specific
  const result: {
    minMarketCapSol: number;
    maxMarketCapSol: number;
    takeProfitPct: number;
    stopLossPct: number;
    triggerMarketCapSol?: number;
    autoTrade: boolean;
  } = {
    minMarketCapSol:
      tokenSettings.minMarketCapSol ??
      config.globalSettings.minMarketCapSol ??
      defaults.minMarketCapSol,
    maxMarketCapSol:
      tokenSettings.maxMarketCapSol ??
      config.globalSettings.maxMarketCapSol ??
      defaults.maxMarketCapSol,
    takeProfitPct:
      tokenSettings.takeProfitPct ??
      config.globalSettings.takeProfitPct ??
      defaults.takeProfitPct,
    stopLossPct:
      tokenSettings.stopLossPct ??
      config.globalSettings.stopLossPct ??
      defaults.stopLossPct,
    autoTrade:
      tokenSettings.autoTrade ??
      config.globalSettings.autoTradeEnabled ??
      defaults.autoTrade,
  };

  if (tokenSettings.triggerMarketCapSol !== undefined) {
    result.triggerMarketCapSol = tokenSettings.triggerMarketCapSol;
  }

  return result;
}

/**
 * Check if a trade should be triggered based on current market cap
 */
export async function shouldTriggerTrade(
  walletAddress: string,
  mint: string,
  currentMarketCapSol: number
): Promise<boolean> {
  const effectiveConfig = await getEffectiveConfig(walletAddress, mint);

  // If trigger MC is set, check if current MC meets it
  if (effectiveConfig.triggerMarketCapSol) {
    return currentMarketCapSol >= effectiveConfig.triggerMarketCapSol;
  }

  // Otherwise, check if within min/max range
  return (
    currentMarketCapSol >= effectiveConfig.minMarketCapSol &&
    currentMarketCapSol <= effectiveConfig.maxMarketCapSol
  );
}

/**
 * Get all traders with token-specific configurations
 */
export async function getTradersWithTokenConfig(
  mint: string
): Promise<TraderConfig[]> {
  try {
    const db = await getDb();
    const configs = await db
      .collection<TraderConfig>("traderConfigs")
      .find({
        [`tokenSpecificSettings.${mint}`]: { $exists: true },
      })
      .toArray();

    return configs;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get traders with token config");
    return [];
  }
}
