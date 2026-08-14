// backend/src/routes/watchlist.route.ts
import { Router, Request, Response } from "express";
import dbService from "../services/db.service.js";
import { getLogger } from "../utils/logger.js";

const router = Router();
const log = getLogger("watchlist.route");

/**
 * GET /api/watchlist
 * Get all watchlist tokens for the user
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const tokens = await dbService.getWatchlist(userId);
    res.json({ success: true, tokens });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get watchlist");
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/watchlist
 * Add a token to the watchlist
 * Body: { mint, symbol?, name?, userId?, priceAlert? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { mint, symbol, name, userId, priceAlert, notes } = req.body;

    if (!mint) {
      return res
        .status(400)
        .json({ success: false, error: "mint is required" });
    }

    const result = await dbService.addToWatchlist({
      mint,
      symbol,
      name,
      userId,
      priceAlert,
      notes,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Broadcast watchlist update to all clients
    const io = (req.app as any).locals.io;
    if (io) {
      const watchlist = await dbService.getWatchlist(userId);
      io.emit("watchlist:update", watchlist);
    }

    res.json(result);
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to add to watchlist");
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/watchlist/:mint
 * Remove a token from the watchlist
 */
router.delete("/:mint", async (req: Request, res: Response) => {
  try {
    const mint = req.params.mint;
    const userId = req.query.userId as string | undefined;

    if (!mint) {
      return res
        .status(400)
        .json({ success: false, error: "mint is required" });
    }

    const result = await dbService.removeFromWatchlist(
      mint,
      userId || undefined
    );
    if (!result.success) {
      return res
        .status(404)
        .json({ success: false, error: "Token not found in watchlist" });
    }

    // Broadcast watchlist update to all clients
    const io = (req.app as any).locals.io;
    if (io) {
      const watchlist = await dbService.getWatchlist(userId);
      io.emit("watchlist:update", watchlist);
    }

    res.json(result);
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to remove from watchlist");
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/watchlist/:mint/alert
 * Update price alert for a watchlist token
 * Body: { targetPrice, condition: "above" | "below" }
 */
router.patch("/:mint/alert", async (req: Request, res: Response) => {
  try {
    const mint = req.params.mint;
    const { targetPrice, condition } = req.body;
    const userId = req.query.userId as string | undefined;

    if (!mint) {
      return res
        .status(400)
        .json({ success: false, error: "mint is required" });
    }

    if (!targetPrice || !condition) {
      return res.status(400).json({
        success: false,
        error: "targetPrice and condition are required",
      });
    }

    if (condition !== "above" && condition !== "below") {
      return res.status(400).json({
        success: false,
        error: "condition must be 'above' or 'below'",
      });
    }

    const priceAlert = {
      targetPrice: Number(targetPrice),
      condition,
      triggered: false,
    };

    const result = await dbService.updateWatchlistAlert(
      mint,
      priceAlert,
      userId || undefined
    );

    if (!result.success) {
      return res
        .status(404)
        .json({ success: false, error: "Token not found in watchlist" });
    }

    // Broadcast price alert update to all clients
    const io = (req.app as any).locals.io;
    if (io) {
      io.emit("priceAlert:set", {
        mint,
        userId,
        priceAlert,
        timestamp: new Date().toISOString(),
      });
    }

    res.json(result);
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to update price alert");
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
