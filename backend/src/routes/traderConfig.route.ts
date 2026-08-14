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

const router = Router();
const log = getLogger("traderConfig.route");

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

    if (!config) {
      log.info({ walletAddress }, "No config found, returning default");
      return res.json({
        success: true,
        config: {
          walletAddress,
          globalSettings: {},
          tokenSpecificSettings: {},
        },
      });
    }

    res.json({
      success: true,
      config,
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
    const settings = req.body;

    if (!walletAddress) {
      return res
        .status(400)
        .json({ success: false, error: "Wallet address required" });
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
      const tokenConfig = req.body;
      log.info(
        { walletAddress, mint },
        "PUT /api/trader-config/:walletAddress/token/:mint request"
      );

      if (!walletAddress || !mint) {
        return res
          .status(400)
          .json({ success: false, error: "Wallet address and mint required" });
      }

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
