import { Router } from "express";
import dbService from "../services/db.service.js";
import { getJupiterTokenInfo, getSolPriceUsd } from "../services/jupiter.service.js";
import { getLogger } from "../utils/logger.js";

const router = Router();
const log = getLogger("positions.route");

router.get("/", async (req, res) => {
  try {
    // No wallet query param (no wallet connected on the frontend) must still
    // resolve to a specific, restricted view — the operator's own public
    // positions — never the unrestricted {} that dbService.getPositions()
    // returns for internal engine callers, which would hand every user's
    // private positions to an unauthenticated request.
    const wallet =
      (req.query.wallet as string | undefined) || dbService.OPERATOR_WALLET;
    const positions = await dbService.getPositions(wallet);
    if (!positions.length) {
      return res.json({ success: true, positions: [] });
    }

    const solPriceUsd = await getSolPriceUsd();

    const enriched = await Promise.all(
      positions.map(async (p) => {
        let currentPrice = 0; // SOL-denominated, same unit as avgBuyPrice
        try {
          const info = await getJupiterTokenInfo(p.token);
          if (info && solPriceUsd > 0) {
            currentPrice = info.usdPrice / solPriceUsd;
          }
        } catch (err: any) {
          log.warn(
            { token: p.token.slice(0, 8), err: err?.message },
            "Failed to fetch live price for position"
          );
        }

        const hasPrice = !!p.avgBuyPrice && currentPrice > 0;
        const unrealizedPnlSol = hasPrice
          ? (currentPrice - p.avgBuyPrice!) * (p.netSol / p.avgBuyPrice!)
          : 0;
        // Decimal fraction (0.05 = +5%), matching this codebase's convention
        // elsewhere (TradeRecord.pnl, SL_PCT, tier profit percentages) — the
        // frontend multiplies by 100 for display.
        const unrealizedPnlPct = hasPrice
          ? (currentPrice - p.avgBuyPrice!) / p.avgBuyPrice!
          : 0;

        return {
          ...p,
          currentPrice,
          unrealizedPnlSol,
          unrealizedPnlPct,
        };
      })
    );

    res.json({
      success: true,
      positions: enriched,
    });
  } catch (err: any) {
    log.error({ err: err?.message }, "Positions API error");
    res.status(500).json({
      success: false,
      message: err.message || "Failed fetching positions",
    });
  }
});

export default router;
