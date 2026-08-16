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
      "GET /api/trader-config/:walletAddress request"
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

    // Max Token Age is user-entered as {value, unit} on the frontend and
    // normalized to seconds before it ever reaches here — validate it landed
    // as a real, positive, finite number rather than letting a bad value
    // silently reach the bot (e.g. 0 would reject almost every token; NaN
    // would make every comparison against it false, which is a fail-open on
    // a safety-relevant filter, not fail-closed).
    if (settings && "maxTokenAgeSeconds" in settings) {
      const v = settings.maxTokenAgeSeconds;
      const isValid =
        v === null ||
        v === undefined ||
        (typeof v === "number" && Number.isFinite(v) && v > 0);
      if (!isValid) {
        return res.status(400).json({
          success: false,
          error:
            "maxTokenAgeSeconds must be a positive number (or omitted/null to clear it)",
        });
      }
      // 30 days — generous ceiling, just guards against a stray extra zero
      // or unit-conversion mistake producing an absurd value.
      if (typeof v === "number" && v > 30 * 24 * 3600) {
        return res.status(400).json({
          success: false,
          error: "maxTokenAgeSeconds cannot exceed 30 days (2592000 seconds)",
        });
      }
    }

    // Launch window (min/max seconds since a token's pool was created) —
    // same fail-closed reasoning as maxTokenAgeSeconds above: a bad value
    // here silently rejects or accepts every token for this wallet.
    for (const field of ["minSecondsSinceLaunch", "maxSecondsSinceLaunch"] as const) {
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
        error: "minSecondsSinceLaunch cannot be greater than maxSecondsSinceLaunch",
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
        (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0);
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
        "PUT /api/trader-config/:walletAddress/token/:mint request"
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
  }
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
  }
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
        "GET /api/trader-config/:walletAddress/effective/:mint request"
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
  }
);

export default router;
