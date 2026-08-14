import { getLogger } from "../utils/logger.js";
import birdeyeService, { BirdeyePnLData } from "./birdeye.service.js";
import { Server as SocketIOServer } from "socket.io";

const LOG = getLogger("pnl-tracker");

interface TrackedPosition {
  tokenMint: string;
  entryPrice: number;
  amount: number;
  wallet: string;
  entryTime: number;
}

/**
 * STAGE 7: LIVE P&L TRACKING
 * Continuously track unrealized P&L via Birdeye
 */
class PnLTrackerService {
  private trackedPositions: Map<string, TrackedPosition> = new Map();
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds
  private io: SocketIOServer | null = null;

  /**
   * Set Socket.IO server for broadcasting
   */
  setSocketIO(io: SocketIOServer): void {
    this.io = io;
    LOG.info("Socket.IO connected to P&L tracker");
  }

  /**
   * Start tracking a position
   */
  startTracking(position: TrackedPosition): void {
    LOG.info(`📊 Started tracking P&L for ${position.tokenMint.slice(0, 8)}`);
    this.trackedPositions.set(position.tokenMint, position);

    // Start tracking loop if not already running
    if (!this.trackingInterval) {
      this.startTrackingLoop();
    }
  }

  /**
   * Stop tracking a position
   */
  stopTracking(tokenMint: string): void {
    LOG.info(`🛑 Stopped tracking P&L for ${tokenMint.slice(0, 8)}`);
    this.trackedPositions.delete(tokenMint);

    // Stop tracking loop if no positions left
    if (this.trackedPositions.size === 0 && this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }

  /**
   * Get all tracked positions
   */
  getTrackedPositions(): TrackedPosition[] {
    return Array.from(this.trackedPositions.values());
  }

  /**
   * Main tracking loop
   */
  private startTrackingLoop(): void {
    LOG.info("🔄 Starting P&L tracking loop...");

    this.trackingInterval = setInterval(async () => {
      for (const [tokenMint, position] of this.trackedPositions) {
        try {
          const pnlData = await birdeyeService.getPnLData(
            tokenMint,
            position.entryPrice
          );

          // Broadcast to frontend via WebSocket
          this.broadcastPnLUpdate(tokenMint, position, pnlData);
        } catch (error: any) {
          LOG.error(
            `Error tracking P&L for ${tokenMint.slice(0, 8)}: ${error.message}`
          );
        }
      }
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Broadcast P&L update to frontend
   */
  private broadcastPnLUpdate(
    tokenMint: string,
    position: TrackedPosition,
    pnlData: BirdeyePnLData
  ): void {
    const update = {
      tokenMint,
      wallet: position.wallet,
      entryPrice: position.entryPrice,
      currentPrice: pnlData.currentPrice,
      amount: position.amount,
      unrealizedPnL: pnlData.unrealizedPnL * position.amount,
      percentChange: pnlData.percentChange,
      priceImpact: pnlData.priceImpact,
      liquidityMovement: pnlData.liquidityMovement,
      trendDirection: pnlData.trendDirection,
      timestamp: Date.now(),
    };

    // Emit to all connected clients
    this.io?.emit("pnl:update", update);

    // Log significant changes
    if (Math.abs(pnlData.percentChange) > 10) {
      LOG.info(
        `📈 Significant P&L change for ${tokenMint.slice(
          0,
          8
        )}: ${pnlData.percentChange.toFixed(2)}%`
      );
    }
  }

  /**
   * Stop all tracking
   */
  stopAll(): void {
    LOG.info("🛑 Stopping all P&L tracking...");
    this.trackedPositions.clear();
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }
}

export default new PnLTrackerService();
export { TrackedPosition };
