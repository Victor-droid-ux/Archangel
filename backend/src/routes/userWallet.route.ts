// backend/src/routes/userWallet.route.ts
import { Router, Request, Response } from "express";
import { getLogger } from "../utils/logger.js";
import userWalletService from "../services/userWallet.service.js";
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
      ownerWallet!
    );
    return res.json({ success: true, ...result });
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

export default router;
