// backend/src/routes/admin.route.ts
import express from "express";
import dbService from "../services/db.service.js";
import { executeJupiterSwap } from "../services/jupiter.service.js";
import notify from "../services/notifications/notify.service.js";
import pnlTrackerService from "../services/pnlTracker.service.js";
import { getLogger } from "../utils/logger.js";

const router = express.Router();
const log = getLogger("admin.route");

/**
 * POST /api/admin/force-sell
 * body: { token: string, amountSol?: number, wallet?: string }
 * Force sell a position immediately.
 */
router.post("/force-sell", async (req, res) => {
  try {
    const { token, amountSol, wallet } = req.body;
    if (!token)
      return res
        .status(400)
        .json({ success: false, message: "token required" });

    // compute amount lamports (default: everything)
    const positions = await dbService.getPositions();
    const p = positions.find((x: any) => x.token === token);
    if (!p)
      return res
        .status(404)
        .json({ success: false, message: "position not found" });

    const amountToSell = amountSol ?? p.netSol;
    const amountLamports = Math.floor(amountToSell * 1e9);
    // No explicit amountSol means "sell everything" (defaults to p.netSol
    // above) — a genuine full close, so the live P&L poll loop for this
    // token should stop rather than keep polling a position we no longer hold.
    const isFullClose = amountSol === undefined;

    const result = await executeJupiterSwap({
      inputMint: token, // token is the mint address
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      userPublicKey: wallet ?? process.env.ADMIN_WALLET_PUBKEY ?? "",
      slippageBps: Number(process.env.ADMIN_FORCE_SLIPPAGE || 1) * 100,
    });

    // insert sell trade record
    const sellRecord = await dbService.addTrade({
      type: "sell",
      token,
      inputMint: token,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      price: p.avgBuyPrice ?? 0,
      pnl: 0,
      wallet: wallet ?? process.env.ADMIN_WALLET_PUBKEY ?? "admin",
      simulated: !result.success,
      signature: result.success ? result.signature ?? null : null,
      timestamp: new Date(),
    });

    if (isFullClose && result.success) {
      pnlTrackerService.stopTracking(token);
    }

    // Only include defined optional properties
    notify.notifyTrade({
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      amountSol: sellRecord.amountSol,
      ...(sellRecord.price !== undefined && { price: sellRecord.price }),
      ...(sellRecord.pnl !== undefined && { pnl: sellRecord.pnl }),
      ...(sellRecord.signature !== undefined && {
        signature: sellRecord.signature,
      }),
      ...(sellRecord.simulated !== undefined && {
        simulated: sellRecord.simulated,
      }),
    });

    // socket
    const io = req.app?.get?.("io");
    io?.emit("tradeFeed", {
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      // tradeFeed's "amount" field is lamports everywhere else it's emitted
      // (jupiterDiscovery.service.ts, storedTokenChecker.service.ts) — the
      // frontend (live-feed.tsx) divides by 1e9 to get SOL. Sending raw SOL
      // here made every force-sell show up ~1e9x too small on the dashboard.
      amount: Math.round(sellRecord.amountSol * 1e9),
      price: sellRecord.price,
      pnl: sellRecord.pnl,
      signature: sellRecord.signature,
      simulated: sellRecord.simulated,
      timestamp: sellRecord.timestamp,
    });

    return res.json({ success: true, data: sellRecord });
  } catch (err: any) {
    log.error("force-sell failed: " + (err?.message || err));
    notify
      .notifyError({ source: "admin.force-sell", message: err?.message })
      .catch(() => {});
    return res
      .status(500)
      .json({ success: false, message: err?.message || "force-sell failed" });
  }
});

// A /cancel-order endpoint used to live here. Removed: a Solana swap is
// atomic once submitted — it either lands or expires, there's no pending
// on-chain order to cancel — and the handler admitted as much in its own
// response message ("you may implement...") without ever actually marking
// anything. Nothing called it. If trade lifecycle tracking (pending/failed/
// expired) is ever wanted, that needs a real `status` field on TradeRecord
// (db.service.ts) set at /prepare and /confirm time, not a bolt-on cancel
// endpoint with nothing to attach to.

export default router;
