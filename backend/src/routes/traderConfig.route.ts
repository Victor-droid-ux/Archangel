// backend/src/routes/traderConfig.route.ts
import { Router, Request, Response } from "express";
import { getLogger } from "../utils/logger.js";
import {
  getTraderConfig,
  updateGlobalSettings,
  setTokenConfig,
  removeTokenConfig,
  getEffectiveConfig,
} from "../services/traderConfig.service.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";
import dbService from "../services/db.service.js";

const router = Router();
const log = getLogger("traderConfig.route");

/**
 * Confirms the caller actually controls :walletAddress before a
 * settings-changing request is allowed to proceed — without this, changing
 * the walletAddress in the URL would let anyone edit anyone else's trading
 * config. Expects { walletAuthTimestamp, walletAuthSignature } in the body.
 */
function requireWalletAuth(req: Request, res: Response): string | null {
  const { walletAddress } = req.params;
  // DELETE requests here carry no body from the frontend, so accept the
  // auth fields via query string too.
  const walletAuthTimestamp =
    req.body?.walletAuthTimestamp ?? req.query?.walletAuthTimestamp;
  const walletAuthSignature =
    req.body?.walletAuthSignature ?? req.query?.walletAuthSignature;
  const verified = verifyWalletAuth({
    wallet: walletAddress,
    timestamp: walletAuthTimestamp as string | undefined,
    signature: walletAuthSignature as string | undefined,
  });
  if (!verified) {
    res.status(401).json({
      success: false,
      error:
        "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
    });
    return null;
  }
  return verified;
}

/**
 * GET /api/trader-config/:walletAddress
 * Get trader's full configuration
 */
router.get("/:walletAddress", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    log.info(
      { walletAddress },
      "GET /api/trader-config/:walletAddress request",
    );

    if (!walletAddress) {
      return res
        .status(400)
        .json({ success: false, error: "Wallet address required" });
    }

    const config = await getTraderConfig(walletAddress);
    // How many trades this wallet has taken so far, toward its own Max
    // Total Trades setting (if any) — lets the settings UI show "X of Y
    // used" instead of the cap being a number nobody can see progress on.
    const tradesTaken = await dbService.getTotalTradesCount(walletAddress);

    if (!config) {
      log.info({ walletAddress }, "No config found, returning default");
      return res.json({
        success: true,
        config: {
          walletAddress,
          globalSettings: {},
          tokenSpecificSettings: {},
          tradesTaken,
        },
      });
    }

    res.json({
      success: true,
      config: { ...config, tradesTaken },
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get trader config");
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * PATCH /api/trader-config/:walletAddress/global
 * Update trader's global settings
 */
router.patch("/:walletAddress/global", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    // Strip the auth fields out — they're proof-of-ownership for this
    // request, not a trading setting, and must never be persisted into
    // globalSettings alongside real config (they were being saved verbatim
    // into the DB doc before this fix).
    const { walletAuthTimestamp, walletAuthSignature, ...settings } =
      req.body ?? {};

    if (!walletAddress) {
      return res
        .status(400)
        .json({ success: false, error: "Wallet address required" });
    }

    if (!requireWalletAuth(req, res)) return;

    // Launch window (min/max seconds since a token's pool was created).
    for (const field of [
      "minSecondsSinceLaunch",
      "maxSecondsSinceLaunch",
    ] as const) {
      if (settings && field in settings) {
        const v = settings[field];
        const isValid =
          v === null ||
          v === undefined ||
          (typeof v === "number" && Number.isFinite(v) && v >= 0);
        if (!isValid) {
          return res.status(400).json({
            success: false,
            error: `${field} must be a non-negative number (or omitted/null to clear it)`,
          });
        }
        if (typeof v === "number" && v > 30 * 24 * 3600) {
          return res.status(400).json({
            success: false,
            error: `${field} cannot exceed 30 days (2592000 seconds)`,
          });
        }
      }
    }
    if (
      settings &&
      typeof settings.minSecondsSinceLaunch === "number" &&
      typeof settings.maxSecondsSinceLaunch === "number" &&
      settings.minSecondsSinceLaunch > settings.maxSecondsSinceLaunch
    ) {
      return res.status(400).json({
        success: false,
        error:
          "minSecondsSinceLaunch cannot be greater than maxSecondsSinceLaunch",
      });
    }

    const rangePairs = [
      ["minMarketCapSol", "maxMarketCapSol"],
      ["minMarketCapUsd", "maxMarketCapUsd"],
      ["minLiquiditySol", "maxLiquiditySol"],
      ["minLiquidityUsd", "maxLiquidityUsd"],
    ] as const;
    for (const [minField, maxField] of rangePairs) {
      const min = settings?.[minField];
      const max = settings?.[maxField];
      for (const [field, value] of [
        [minField, min],
        [maxField, max],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        ) {
          return res.status(400).json({
            success: false,
            error: `${field} must be a finite non-negative number`,
          });
        }
      }
      if (typeof min === "number" && typeof max === "number" && min > max) {
        return res.status(400).json({
          success: false,
          error: `${minField} cannot be greater than ${maxField}`,
        });
      }
    }

    for (const field of ["takeProfitPct", "stopLossPct"] as const) {
      const value = settings?.[field];
      if (
        value !== undefined &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1)
      ) {
        return res.status(400).json({
          success: false,
          error: `${field} must be between 0 and 1`,
        });
      }
    }

    if (
      settings?.maxTradeAmountSol !== undefined &&
      (typeof settings.maxTradeAmountSol !== "number" ||
        !Number.isFinite(settings.maxTradeAmountSol) ||
        settings.maxTradeAmountSol <= 0)
    ) {
      return res.status(400).json({
        success: false,
        error: "maxTradeAmountSol must be a finite positive number",
      });
    }
    if (
      settings?.minTokenScore !== undefined &&
      (typeof settings.minTokenScore !== "number" ||
        !Number.isFinite(settings.minTokenScore) ||
        settings.minTokenScore < 0 ||
        settings.minTokenScore > 100)
    ) {
      return res.status(400).json({
        success: false,
        error: "minTokenScore must be between 0 and 100",
      });
    }
    if (
      settings?.autoTradeEnabled !== undefined &&
      typeof settings.autoTradeEnabled !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        error: "autoTradeEnabled must be a boolean",
      });
    }

    // Max Total Trades — a lifetime cap on how many trades the bot takes for
    // this wallet (see multiUserExecution.service.ts). Same fail-closed
    // reasoning as the other numeric settings above.
    if (settings && "maxTotalTrades" in settings) {
      const v = settings.maxTotalTrades;
      const isValid =
        v === null ||
        v === undefined ||
        (typeof v === "number" &&
          Number.isFinite(v) &&
          Number.isInteger(v) &&
          v > 0);
      if (!isValid) {
        return res.status(400).json({
          success: false,
          error:
            "maxTotalTrades must be a positive whole number (or omitted/null to clear it)",
        });
      }
      if (typeof v === "number" && v > 100000) {
        return res.status(400).json({
          success: false,
          error: "maxTotalTrades cannot exceed 100000",
        });
      }
    }

    const io = (req.app as any).locals.io;
    const config = await updateGlobalSettings(walletAddress, settings, io);

    if (!config) {
      return res.status(500).json({
        success: false,
        error: "Failed to update global settings",
      });
    }

    res.json({
      success: true,
      config,
      message: "Global settings updated successfully",
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to update global settings");
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * PUT /api/trader-config/:walletAddress/token/:mint
 * Set token-specific configuration
 */
router.put(
  "/:walletAddress/token/:mint",
  async (req: Request, res: Response) => {
    try {
      const { walletAddress, mint } = req.params;
      // Same reasoning as PATCH /global — strip auth fields before persisting.
      const { walletAuthTimestamp, walletAuthSignature, ...tokenConfig } =
        req.body ?? {};
      log.info(
        { walletAddress, mint },
        "PUT /api/trader-config/:walletAddress/token/:mint request",
      );

      if (!walletAddress || !mint) {
        return res
          .status(400)
          .json({ success: false, error: "Wallet address and mint required" });
      }

      if (!requireWalletAuth(req, res)) return;

      const io = (req.app as any).locals.io;
      const config = await setTokenConfig(walletAddress, mint, tokenConfig, io);

      if (!config) {
        return res.status(500).json({
          success: false,
          error: "Failed to set token configuration",
        });
      }

      res.json({
        success: true,
        config,
        message: `Token configuration set for ${mint}`,
      });
    } catch (err: any) {
      log.error({ err: err.message }, "Failed to set token config");
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  },
);

/**
 * DELETE /api/trader-config/:walletAddress/token/:mint
 * Remove token-specific configuration
 */
router.delete(
  "/:walletAddress/token/:mint",
  async (req: Request, res: Response) => {
    try {
      const { walletAddress, mint } = req.params;

      if (!walletAddress || !mint) {
        return res
          .status(400)
          .json({ success: false, error: "Wallet address and mint required" });
      }

      if (!requireWalletAuth(req, res)) return;

      const io = (req.app as any).locals.io;
      const config = await removeTokenConfig(walletAddress, mint, io);

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Configuration not found",
        });
      }

      res.json({
        success: true,
        config,
        message: `Token configuration removed for ${mint}`,
      });
    } catch (err: any) {
      log.error({ err: err.message }, "Failed to remove token config");
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  },
);

/**
 * GET /api/trader-config/:walletAddress/effective/:mint
 * Get effective configuration for a specific token
 * (resolves token-specific + global + defaults)
 */
router.get(
  "/:walletAddress/effective/:mint",
  async (req: Request, res: Response) => {
    try {
      const { walletAddress, mint } = req.params;
      log.info(
        { walletAddress, mint },
        "GET /api/trader-config/:walletAddress/effective/:mint request",
      );

      if (!walletAddress || !mint) {
        return res
          .status(400)
          .json({ success: false, error: "Wallet address and mint required" });
      }

      const effectiveConfig = await getEffectiveConfig(walletAddress, mint);

      res.json({
        success: true,
        config: effectiveConfig,
      });
    } catch (err: any) {
      log.error({ err: err.message }, "Failed to get effective config");
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  },
);

export default router;
