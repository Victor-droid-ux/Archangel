// backend/src/routes/user.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";
import dbService from "../services/db.service.js";

const router = express.Router();
const log = getLogger("user.route");

// POST /api/user/settings
// body: { wallet, amount?, slippage?, takeProfit?, stopLoss?, autoTrade?, dexRoute?, selectedToken? }
// Field names mirror frontend/hooks/useConfig.ts's TradingConfig exactly so
// the frontend can apply the saved doc straight back into the store.
router.post("/settings", async (req, res) => {
  try {
    const {
      wallet,
      amount,
      slippage,
      takeProfit,
      stopLoss,
      autoTrade,
      dexRoute,
      selectedToken,
    } = req.body;

    if (!wallet) {
      return res
        .status(400)
        .json({ success: false, message: "wallet required" });
    }

    const saved = await dbService.saveUserSettings(wallet, {
      amount,
      slippage,
      takeProfit,
      stopLoss,
      autoTrade,
      dexRoute,
      selectedToken,
    });

    log.info({ wallet }, "Saved user settings");

    return res.json({ success: true, data: saved });
  } catch (err: any) {
    log.error("save settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/user/settings?wallet=...
router.get("/settings", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) {
      return res
        .status(400)
        .json({ success: false, message: "wallet query required" });
    }

    const settings = await dbService.getUserSettings(wallet);

    // No saved settings yet is not an error — the frontend falls back to its
    // own in-store defaults when data is null.
    return res.json({ success: true, data: settings });
  } catch (err: any) {
    log.error("get user settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
