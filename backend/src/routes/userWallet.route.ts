// backend/src/routes/userWallet.route.ts
import { Router, Request, Response } from "express";
import { getLogger } from "../utils/logger.js";
import userWalletService from "../services/userWallet.service.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";

const router = Router();
const log = getLogger("userWallet.route");

// Below this, AUTO_TRADE_PERCENT_OF_BALANCE sizing (autoBuyer.service.ts)
// can never produce a trade that clears MIN_AUTO_TRADE_SOL, regardless of
// auto-trade being enabled — e.g. 0.02 * balance >= 0.01 needs >= 0.5 SOL.
// Exposed here so the frontend can tell a user this concretely, instead of
// auto-trade silently never firing for an underfunded wallet.
const AUTO_TRADE_PERCENT_OF_BALANCE = Number(
  process.env.AUTO_TRADE_PERCENT_OF_BALANCE ?? 0.02
);
const MIN_AUTO_TRADE_SOL = Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003);
const MIN_BALANCE_FOR_AUTO_TRADE_SOL =
  AUTO_TRADE_PERCENT_OF_BALANCE > 0
    ? MIN_AUTO_TRADE_SOL / AUTO_TRADE_PERCENT_OF_BALANCE
    : MIN_AUTO_TRADE_SOL;

/**
 * GET /api/user-wallet/:ownerWallet
 * Returns (creating on first call) this owner's dedicated custodial
 * trading wallet address and its current SOL balance.
 */
router.get("/:ownerWallet", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const result = await userWalletService.getUserWalletBalanceSol(
      ownerWallet!
    );
    return res.json({
      success: true,
      ...result,
      minBalanceForAutoTradeSol: MIN_BALANCE_FOR_AUTO_TRADE_SOL,
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
      Number(amountSol)
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
        io
      );
      return res.json({ success: true, ...result });
    } catch (err: any) {
      log.error({ err: err.message }, "Stop auto-trade failed");
      return res.status(400).json({
        success: false,
        error: err.message || "Stop auto-trade failed",
      });
    }
  }
);

export default router;
