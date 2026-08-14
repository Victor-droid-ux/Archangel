// backend/src/routes/tokens.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";
import { getLatestTokens } from "../services/tokenPrice.service.js";
import { getSolPriceUsd } from "../services/jupiter.service.js";
import {
  validateTokenLifecycle,
  validateTokenBatch,
  getLifecycleStatusMessage,
} from "../services/tokenLifecycle.service.js";

const router = express.Router();
const logger = getLogger("tokens.route");

/**
 * GET /api/tokens
 * Returns token list from in-memory cache:
 *  - symbol
 *  - mint address
 *  - current price
 *  - 24h change (pnl)
 *  - liquidity
 *  - marketCap
 */
router.get("/", async (_req, res) => {
  try {
    const tokens = getLatestTokens();

    return res.json({
      success: true,
      tokens,
    });
  } catch (err: any) {
    logger.error("❌ Failed to load tokens:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/**
 * GET /api/tokens/sol-price
 * Live SOL/USD price (jupiter.service.ts, 30s-cached) — for frontend
 * SOL->USD display estimates. Previously several UI components hardcoded a
 * stale $150-$200 conversion instead of fetching this.
 */
router.get("/sol-price", async (_req, res) => {
  try {
    const price = await getSolPriceUsd();
    return res.json({ success: true, price });
  } catch (err: any) {
    logger.error("❌ Failed to fetch SOL price:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/tokens/lifecycle/validate
 * Validate lifecycle for a single token or batch of tokens
 * Body: { tokenMint: string } or { tokenMints: string[] }
 */
router.post("/lifecycle/validate", async (req, res) => {
  try {
    const { tokenMint, tokenMints } = req.body;

    if (tokenMint) {
      // Single token validation
      const result = await validateTokenLifecycle(tokenMint);
      const statusMessage = getLifecycleStatusMessage(result);

      return res.json({
        success: true,
        data: {
          ...result,
          statusMessage,
        },
      });
    } else if (tokenMints && Array.isArray(tokenMints)) {
      // Batch validation
      const results = await validateTokenBatch(tokenMints);

      return res.json({
        success: true,
        data: {
          tradable: results.tradable.map((r) => ({
            ...r,
            statusMessage: getLifecycleStatusMessage(r),
          })),
          notTradable: results.notTradable.map((r) => ({
            ...r,
            statusMessage: getLifecycleStatusMessage(r),
          })),
          summary: results.summary,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Request must include 'tokenMint' or 'tokenMints' field",
      });
    }
  } catch (err: any) {
    logger.error("❌ Lifecycle validation failed:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/**
 * GET /api/tokens/lifecycle/:tokenMint
 * Get lifecycle status for a specific token
 */
router.get("/lifecycle/:tokenMint", async (req, res) => {
  try {
    const { tokenMint } = req.params;

    if (!tokenMint) {
      return res.status(400).json({
        success: false,
        message: "Token mint address is required",
      });
    }

    const result = await validateTokenLifecycle(tokenMint);
    const statusMessage = getLifecycleStatusMessage(result);

    return res.json({
      success: true,
      data: {
        ...result,
        statusMessage,
      },
    });
  } catch (err: any) {
    logger.error("❌ Lifecycle validation failed:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

export default router;
