// backend/src/utils/walletSocket.ts
//
// Emits a wallet-attributed event to only that wallet's own connections —
// sockets join a room named after their owner wallet on "identify" (see
// socket.route.ts) — except for the bot's own operator-wallet activity,
// which stays a global broadcast (consistent with db.service.ts's
// viewerWalletFilter(), which treats the operator's trades as everyone's
// shared "here's what the bot is doing" view, while a specific user's own
// activity is private to them). Without this, every connected browser saw
// every wallet's live trade feed/pipeline events/PnL updates regardless of
// which wallet was actually connected in that browser.
import { Server } from "socket.io";
import { getLogger } from "./logger.js";

const log = getLogger("walletSocket");

export const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

export function emitToWalletOrGlobal(
  io: Server | null | undefined,
  wallet: string | undefined,
  event: string,
  payload: unknown
): void {
  if (!io) return;
  if (!wallet || wallet === OPERATOR_WALLET) {
    io.emit(event, payload);
    return;
  }
  io.to(wallet).emit(event, payload);
  log.debug({ wallet, event }, "Emitted wallet-scoped socket event");
}
