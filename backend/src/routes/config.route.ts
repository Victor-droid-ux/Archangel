// backend/src/routes/config.route.ts
import { Router, Request, Response } from "express";
import { getLogger } from "../utils/logger.js";

const router = Router();
const log = getLogger("config.route");

// In-memory config that can be updated without restart
let runtimeConfig = {
  minMarketCapSol: Number(process.env.MIN_MARKETCAP_SOL ?? 5),
  maxMarketCapSol: Number(process.env.MAX_MARKETCAP_SOL ?? 1000000),
  minMarketCapUsd: Number(process.env.MIN_MARKETCAP_USD ?? 1000),
  maxMarketCapUsd: Number(process.env.MAX_MARKETCAP_USD ?? 200000000),
  minTokenScore: Number(process.env.MIN_TOKEN_SCORE ?? 30),
  takeProfitPct: Number(process.env.TP_PCT ?? 0.1),
  // Must match monitor.service.ts's DEFAULT_SL_PCT fallback (0.3) — the 0.02
  // figure was the pre-fix default that caused a self-inflicted stop-loss
  // bug there (see monitor.service.ts). This field isn't currently read by
  // any real trade-execution path, but it's still exposed via GET /api/config
  // and shouldn't silently disagree with the value actually in effect.
  stopLossPct: Number(process.env.SL_PCT ?? 0.3),
};

/**
 * GET /api/config
 * Get current configuration
 */
router.get("/", (req: Request, res: Response) => {
  res.json({
    success: true,
    config: runtimeConfig,
  });
});

/**
 * PATCH /api/config
 * Update configuration dynamically
 * Body: { minMarketCapSol?, maxMarketCapSol?, minMarketCapUsd?, ... }
 */
router.patch("/", (req: Request, res: Response) => {
  try {
    const updates = req.body;
    const oldConfig = { ...runtimeConfig };

    // Update allowed fields
    if (typeof updates.minMarketCapSol === "number") {
      runtimeConfig.minMarketCapSol = updates.minMarketCapSol;
    }
    if (typeof updates.maxMarketCapSol === "number") {
      runtimeConfig.maxMarketCapSol = updates.maxMarketCapSol;
    }
    if (typeof updates.minMarketCapUsd === "number") {
      runtimeConfig.minMarketCapUsd = updates.minMarketCapUsd;
    }
    if (typeof updates.maxMarketCapUsd === "number") {
      runtimeConfig.maxMarketCapUsd = updates.maxMarketCapUsd;
    }
    if (typeof updates.minTokenScore === "number") {
      runtimeConfig.minTokenScore = updates.minTokenScore;
    }
    if (typeof updates.takeProfitPct === "number") {
      runtimeConfig.takeProfitPct = updates.takeProfitPct;
    }
    if (typeof updates.stopLossPct === "number") {
      runtimeConfig.stopLossPct = updates.stopLossPct;
    }

    log.info({
      msg: "Configuration updated",
      old: oldConfig,
      new: runtimeConfig,
    });

    // Emit config update to all connected clients
    const io = (req.app as any).locals.io;
    if (io) {
      io.emit("config:update", runtimeConfig);
    }

    res.json({
      success: true,
      config: runtimeConfig,
      message: "Configuration updated successfully",
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to update configuration");
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/config/reset
 * Reset configuration to environment defaults
 */
router.post("/reset", (req: Request, res: Response) => {
  try {
    runtimeConfig = {
      minMarketCapSol: Number(process.env.MIN_MARKETCAP_SOL ?? 5),
      maxMarketCapSol: Number(process.env.MAX_MARKETCAP_SOL ?? 1000000),
      minMarketCapUsd: Number(process.env.MIN_MARKETCAP_USD ?? 1000),
      maxMarketCapUsd: Number(process.env.MAX_MARKETCAP_USD ?? 200000000),
      minTokenScore: Number(process.env.MIN_TOKEN_SCORE ?? 30),
      takeProfitPct: Number(process.env.TP_PCT ?? 0.1),
      stopLossPct: Number(process.env.SL_PCT ?? 0.3),
    };

    log.info("Configuration reset to environment defaults");

    // Emit config update to all connected clients
    const io = (req.app as any).locals.io;
    if (io) {
      io.emit("config:update", runtimeConfig);
    }

    res.json({
      success: true,
      config: runtimeConfig,
      message: "Configuration reset to defaults",
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to reset configuration");
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * Export runtime config for use in other services
 */
export function getRuntimeConfig() {
  return runtimeConfig;
}

export default router;
