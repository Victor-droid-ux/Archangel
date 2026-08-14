import { Router, Request, Response } from "express";
import * as db from "../services/db.service.js";

const router = Router();

/**
 * GET /api/pnl/portfolio
 * Get comprehensive portfolio P&L metrics
 */
router.get("/portfolio", async (req: Request, res: Response) => {
  try {
    const pnl = await db.getPortfolioPnL();
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
    const tokenPnL = await db.getTokenPnL();
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
    const history = await db.getPnLHistory(days);
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
