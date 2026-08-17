import { Server, Socket } from "socket.io";
import { getLogger } from "../utils/logger.js";
import { getLatestTokens } from "../services/tokenPrice.service.js";
import dbService from "../services/db.service.js";
import { poolMonitor } from "../services/poolMonitor.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import {
  startWalletBalanceSync,
  stopWalletBalanceSync,
  updateWalletSocketId,
} from "../services/walletBalance.service.js";

const logger = getLogger("socket");

// In-memory map: wallet => socket.id for targeted messaging
const walletSocketMap = new Map<string, string>();

export function registerSocketHandlers(io: Server) {
  // Listen for pool availability events
  poolMonitor.on("poolAvailable", (data) => {
    const { tokenMint, wallet } = data;
    const socketId = walletSocketMap.get(wallet);

    if (socketId) {
      io.to(socketId).emit("poolAvailable", {
        tokenMint,
        message: `A Jupiter route is now available for token ${tokenMint.slice(
          0,
          8
        )}...! You can now trade this token.`,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        `Notified wallet ${wallet.slice(
          0,
          8
        )}... that pool is available for ${tokenMint.slice(0, 8)}...`
      );
    }
  });

  poolMonitor.on("monitoringTimeout", (data) => {
    const { tokenMint, wallet } = data;
    const socketId = walletSocketMap.get(wallet);

    if (socketId) {
      io.to(socketId).emit("poolMonitorTimeout", {
        tokenMint,
        message: `Monitoring timed out for token ${tokenMint.slice(
          0,
          8
        )}... after 10 minutes. Pool may not be available yet.`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  io.on("connection", async (socket: Socket) => {
    logger.info(`⚡ Socket connected: ${socket.id}`);

    /** INITIAL TOKEN SNAPSHOT */
    try {
      const snapshot = getLatestTokens();
      socket.emit("tokenFeed", { tokens: snapshot });
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        "Failed to send token snapshot on connect"
      );
    }

    /** INITIAL STATS SNAPSHOT */
    try {
      const stats = await dbService.getStats();
      socket.emit("stats:update", stats);
    } catch (err: any) {
      logger.warn("Failed broadcasting initial stats");
    }

    /** CONFIRM CONNECTION */
    socket.emit("connection", { status: "connected" });

    /**
     * WALLET IDENTIFICATION
     * Client sends wallet address to register for auto-trading
     */
    socket.on("identify", async (payload: any) => {
      try {
        const { wallet, balanceSol, autoMode, manualAmountSol } = payload || {};
        if (!wallet) {
          logger.warn("identify event without wallet address");
          return;
        }

        // Check if wallet was already mapped (reconnection)
        const existingSocketId = walletSocketMap.get(wallet);
        const isReconnect = existingSocketId && existingSocketId !== socket.id;

        // Map wallet to socket for targeted messages
        walletSocketMap.set(wallet, socket.id);
        socket.data.wallet = wallet;
        // traderConfig.service.ts broadcasts config changes via
        // io.to(walletAddress).emit(...) — that only reaches anyone if a
        // socket has actually joined a room by that name, which nothing did
        // until now.
        socket.join(wallet);

        // Update socket ID for existing wallet sync or start new sync
        if (isReconnect) {
          logger.info(
            `🔄 Wallet ${wallet.slice(
              0,
              8
            )}... reconnected with new socket ${socket.id.slice(0, 8)}...`
          );
          updateWalletSocketId(wallet, socket.id);
        } else {
          // Start continuous balance syncing for this wallet
          logger.info(
            `🆕 Starting balance sync for wallet ${wallet.slice(0, 8)}...`
          );
          await startWalletBalanceSync(io, wallet, socket.id, {
            intervalMs: 5000, // Sync every 5 seconds
            initialBalance: balanceSol || undefined,
          });
        }

        // autoMode/manualAmountSol here are legacy identify-handshake fields,
        // logged only. Real settings persistence is REST-based —
        // POST/GET /api/user/settings (user.route.ts, db.service.ts's
        // userSettings collection) — and independent of this socket payload.

        logger.info(
          { wallet, autoMode: !!autoMode, manualAmountSol },
          `Socket identified for wallet`
        );

        // Acknowledge identification
        socket.emit("identified", { wallet, success: true });
      } catch (err: any) {
        logger.error(
          { err: err?.message ?? String(err) },
          "identify event failed"
        );
        socket.emit("identified", { success: false, error: err?.message });
      }
    });

    /**
     * FRONTEND TRADE EVENTS → scoped to the sending socket's own identified
     * wallet (not a global broadcast — this is that wallet's own manual
     * trade, private the same as every other per-wallet activity), plus a
     * refreshed stats snapshot for that same wallet.
     */
    socket.on("tradeLog", async (payload) => {
      const wallet = socket.data?.wallet;
      logger.info({ wallet }, "📥 tradeLog received");
      emitToWalletOrGlobal(io, wallet, "tradeFeed", {
        ...payload,
        timestamp: new Date().toISOString(),
      });

      if (wallet) {
        const stats = await dbService.getStats(wallet);
        emitToWalletOrGlobal(io, wallet, "stats:update", stats);
      }
    });

    socket.on("trade:update", async (payload) => {
      const wallet = socket.data?.wallet;
      logger.info({ wallet }, "📡 trade:update received");
      emitToWalletOrGlobal(io, wallet, "tradeFeed", payload);

      if (wallet) {
        const stats = await dbService.getStats(wallet);
        emitToWalletOrGlobal(io, wallet, "stats:update", stats);
      }
    });

    /**
     * TOKEN DISCOVERY LIVE UPDATES
     */
    socket.on("tokenFeed", (payload) => {
      logger.info("🔄 tokenFeed update");
      io.emit("tokenFeed", payload);
    });

    /**
     * PRICE STREAM PASS-THROUGH
     */
    socket.on("priceUpdate", (payload) => {
      io.emit("priceUpdate", payload);
    });

    /**
     * FRONTEND CAN REQUEST CURRENT STATS — scoped to this socket's own
     * identified wallet (set by "identify", above). Unidentified (no wallet
     * connected) correctly gets back zeroed stats from getStats(undefined).
     */
    socket.on("stats:request", async () => {
      const stats = await dbService.getStats(socket.data?.wallet);
      socket.emit("stats:update", stats);
    });

    /**
     * PORTFOLIO P&L REQUEST — scoped to this socket's own identified wallet.
     * Was previously hardcoded to the operator's own P&L regardless of who
     * asked, which handed the operator's private numbers to any socket.
     */
    socket.on("pnl:request", async () => {
      try {
        const wallet = socket.data?.wallet;
        const portfolioPnL = wallet
          ? await dbService.getPortfolioPnL(wallet)
          : {
              totalInvestedSol: 0,
              totalReturnedSol: 0,
              unrealizedPnlSol: 0,
              realizedPnlSol: 0,
              totalPnlSol: 0,
              totalPnlPercent: 0,
              winningTrades: 0,
              losingTrades: 0,
              totalTrades: 0,
              winRate: 0,
              averageWinSol: 0,
              averageLossSol: 0,
              largestWinSol: 0,
              largestLossSol: 0,
              openPositionsValue: 0,
              closedPositionsValue: 0,
              roi: 0,
            };
        // See pnlBroadcaster.service.ts — "pnl:update" is reserved for
        // pnlTracker.service.ts's per-token PnLUpdate payload shape.
        socket.emit("portfolio:pnl:update", portfolioPnL);
      } catch (err: any) {
        logger.error("Failed to fetch portfolio P&L:", err?.message);
      }
    });

    /**
     * TOKEN P&L REQUEST — same reasoning as pnl:request above.
     */
    socket.on("pnl:tokens:request", async () => {
      try {
        const wallet = socket.data?.wallet;
        const tokenPnL = wallet ? await dbService.getTokenPnL(wallet) : [];
        socket.emit("pnl:tokens:update", tokenPnL);
      } catch (err: any) {
        logger.error("Failed to fetch token P&L:", err?.message);
      }
    });

    /**
     * WATCHLIST REQUEST
     */
    socket.on(
      "watchlist:request",
      async (payload: { userId?: string } = {}) => {
        try {
          const watchlist = await dbService.getWatchlist(payload.userId);
          socket.emit("watchlist:update", watchlist);
        } catch (err: any) {
          logger.error("Failed to fetch watchlist:", err?.message);
        }
      }
    );

    /** DISCONNECT */
    socket.on("disconnect", (reason) => {
      const wallet = socket.data?.wallet;
      if (wallet) {
        // Stop balance syncing for this wallet
        stopWalletBalanceSync(wallet);
        walletSocketMap.delete(wallet);
        logger.info(
          `🛑 Wallet ${wallet.slice(
            0,
            8
          )}... disconnected, balance sync stopped`
        );
      }
      logger.warn(`❌ Disconnected: ${socket.id} (${reason})`);
    });

    socket.on("error", (err) =>
      logger.error("Socket error: " + (err?.message ?? String(err)))
    );
  });

  // Expose wallet socket map globally for other services to emit targeted messages
  (global as any).__walletSocketMap = walletSocketMap;
}

/**
 * Helper function to get socket ID for a specific wallet
 * Can be used by services to send targeted messages
 */
export function getSocketIdForWallet(wallet: string): string | undefined {
  return walletSocketMap.get(wallet);
}
