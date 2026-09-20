// backend/src/routes/userWallet.route.ts
import { Router, Request, Response } from "express";
import { getLogger } from "../utils/logger.js";
import userWalletService from "../services/userWallet.service.js";
import dbService from "../services/db.service.js";
import {
  getMaxOpenPositions,
  setAutoTradeEnabled,
} from "../services/traderConfig.service.js";
import { minBalanceForSlots, sizingEnv } from "../utils/positionSizing.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";

const router = Router();
const log = getLogger("userWallet.route");

/**
 * GET /api/user-wallet/:ownerWallet
 * Returns (creating on first call) this owner's dedicated custodial
 * trading wallet address and its current SOL balance.
 */
router.get("/:ownerWallet", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const result = await userWalletService.getUserWalletBalanceSol(
      ownerWallet!,
    );

    // What the dashboard needs to explain — concretely — whether the bot can
    // open another position for this wallet: how many slots the trader
    // allows, how many are in use, and the sizing floors. The split itself is
    // computed from these (utils/positionSizing.ts), on both sides.
    const [maxOpenPositions, openPositions] = await Promise.all([
      getMaxOpenPositions(ownerWallet!),
      dbService.getOpenPositionCount(ownerWallet!),
    ]);
    const { minTradeSol, feeReserveSol } = sizingEnv();

    return res.json({
      success: true,
      ...result,
      maxOpenPositions,
      openPositions,
      minTradeSol,
      feeReserveSol,
      // Enough to open every one of the trader's slots at the minimum size.
      minBalanceForAutoTradeSol: minBalanceForSlots(
        maxOpenPositions,
        minTradeSol,
        feeReserveSol,
      ),
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to load/create user wallet");
    return res.status(400).json({
      success: false,
      error: err.message || "Invalid wallet address",
    });
  }
});

/**
 * POST /api/user-wallet/:ownerWallet/withdraw
 * body: { amountSol, walletAuthTimestamp, walletAuthSignature }
 * Withdraws from this owner's custodial hot wallet back to their own
 * connected wallet — nowhere else. Requires proof (a fresh wallet
 * signature) that the caller actually controls :ownerWallet.
 */
router.post("/:ownerWallet/withdraw", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const { amountSol, walletAuthTimestamp, walletAuthSignature } = req.body;

    const verifiedWallet = verifyWalletAuth({
      wallet: ownerWallet,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        error:
          "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
      });
    }

    const result = await userWalletService.withdrawToOwner(
      verifiedWallet,
      Number(amountSol),
    );
    return res.json({ success: true, ...result });
  } catch (err: any) {
    log.error({ err: err.message }, "Withdrawal failed");
    return res.status(400).json({
      success: false,
      error: err.message || "Withdrawal failed",
    });
  }
});

/**
 * POST /api/user-wallet/:ownerWallet/stop-auto-trade
 * body: { walletAuthTimestamp, walletAuthSignature }
 * Disables auto-trade for this wallet and sells every position the bot has
 * bought for it (never touches self-custody/manual positions — those are
 * only sellable by the user themselves). Requires proof of ownership, same
 * as withdraw above, since this moves real funds.
 */
router.post(
  "/:ownerWallet/stop-auto-trade",
  async (req: Request, res: Response) => {
    try {
      const { ownerWallet } = req.params;
      const { walletAuthTimestamp, walletAuthSignature } = req.body;

      const verifiedWallet = verifyWalletAuth({
        wallet: ownerWallet,
        timestamp: walletAuthTimestamp,
        signature: walletAuthSignature,
      });
      if (!verifiedWallet) {
        return res.status(401).json({
          success: false,
          error:
            "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
        });
      }

      const io = (req.app as any).locals.io;
      const result = await userWalletService.stopAutoTradeAndLiquidate(
        verifiedWallet,
        io,
      );
      return res.json({ success: true, ...result });
    } catch (err: any) {
      log.error({ err: err.message }, "Stop auto-trade failed");
      return res.status(400).json({
        success: false,
        error: err.message || "Stop auto-trade failed",
      });
    }
  },
);

/**
 * POST /api/user-wallet/:ownerWallet/auto-trade
 * body: { enabled: boolean, walletAuthTimestamp, walletAuthSignature }
 * Pauses or resumes auto-trading for this wallet WITHOUT selling anything
 * and without touching any other saved setting. (stop-auto-trade above turns
 * it off AND liquidates every bot position; this is the gentle version —
 * open positions keep being managed by the exit monitor either way.)
 */
router.post("/:ownerWallet/auto-trade", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const { enabled, walletAuthTimestamp, walletAuthSignature } =
      req.body ?? {};

    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ success: false, error: "enabled must be true or false" });
    }

    const verifiedWallet = verifyWalletAuth({
      wallet: ownerWallet,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        error:
          "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
      });
    }

    const io = (req.app as any).locals.io;
    await setAutoTradeEnabled(verifiedWallet, enabled, io);
    return res.json({ success: true, autoTradeEnabled: enabled });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to change auto-trade state");
    return res.status(400).json({
      success: false,
      error: err.message || "Failed to change auto-trade state",
    });
  }
});

export default router;
