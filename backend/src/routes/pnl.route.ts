import { Router, Request, Response } from "express";
import * as db from "../services/db.service.js";

const router = Router();

/**
 * GET /api/pnl/portfolio
 * Get comprehensive portfolio P&L metrics
 */
router.get("/portfolio", async (req: Request, res: Response) => {
  try {
    // No wallet param must still resolve to a specific, restricted view (the
    // operator's own public P&L), never dbService's unrestricted {} — that's
    // reserved for trusted internal callers, not an unauthenticated request.
    const wallet = (req.query.wallet as string | undefined) || db.OPERATOR_WALLET;
    const pnl = await db.getPortfolioPnL(wallet);
    res.json({
      success: true,
      data: pnl,
    });
  } catch (err) {
    console.error("Error fetching portfolio P&L:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch portfolio P&L",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/pnl/tokens
 * Get P&L breakdown by token
 */
router.get("/tokens", async (req: Request, res: Response) => {
  try {
    // Same reasoning as /portfolio above.
    const wallet = (req.query.wallet as string | undefined) || db.OPERATOR_WALLET;
    const tokenPnL = await db.getTokenPnL(wallet);
    res.json({
      success: true,
      data: tokenPnL,
    });
  } catch (err) {
    console.error("Error fetching token P&L:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch token P&L",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/pnl/history?days=30
 * Get P&L history over time (daily aggregation)
 */
router.get("/history", async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    // Same reasoning as /portfolio above.
    const wallet = (req.query.wallet as string | undefined) || db.OPERATOR_WALLET;
    const history = await db.getPnLHistory(days, wallet);
    res.json({
      success: true,
      data: history,
    });
  } catch (err) {
    console.error("Error fetching P&L history:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch P&L history",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

export default router;
