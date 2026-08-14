// backend/src/app.ts
// Pure Express app construction — zero side effects (no DB connect, no HTTP
// listen, no background services started). Split out of index.ts so tests
// can import createApp() without also triggering index.ts's bootstrap IIFE,
// which used to connect to the real MongoDB, bind a real port, and start
// live Jupiter discovery polling as an unavoidable side effect of the import.
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";

import tradeRoutes from "./routes/trade.route.js";
import statsRoutes from "./routes/stats.route.js";
import tokensRoutes from "./routes/tokens.route.js";
import tokenChartRoute from "./routes/tokenChart.route.js";
import positionsRoutes from "./routes/positions.route.js";
import watchlistRoutes from "./routes/watchlist.route.js";
import pnlRoutes from "./routes/pnl.route.js";
import cacheRoutes from "./routes/cache.route.js";
import configRoutes from "./routes/config.route.js";
import traderConfigRoutes from "./routes/traderConfig.route.js";
import adminRoutes from "./routes/admin.route.js";
import userRoutes from "./routes/user.route.js";
import oldTokensRoute from "./routes/oldTokens.route.js";
import socialRoute from "./routes/social.route.js";

import dbService from "./services/db.service.js";
import { ENV } from "./utils/env.js";

export const createApp = () => {
  const app = express();
  app.use(
    cors({
      origin: ENV.FRONTEND_URL || "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })
  );
  app.use(express.json());
  app.get("/", (_, res) =>
    res.json({ message: "🚀 ArchAngel Backend Running" })
  );
  app.get("/health", (_, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || "development",
    });
  });
  app.get("/ready", async (_, res) => {
    try {
      const dbConnected = await dbService
        .connect()
        .then(() => true)
        .catch(() => false);
      if (dbConnected) {
        res.status(200).json({
          status: "ready",
          timestamp: new Date().toISOString(),
          database: "connected",
        });
      } else {
        res.status(503).json({
          status: "not ready",
          timestamp: new Date().toISOString(),
          database: "disconnected",
        });
      }
    } catch (error) {
      res.status(503).json({
        status: "not ready",
        timestamp: new Date().toISOString(),
        error: "Health check failed",
      });
    }
  });
  app.use("/api/trade", tradeRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/tokens", tokensRoutes);
  app.use("/api/tokens", tokenChartRoute);
  app.use("/api/positions", positionsRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/watchlist", watchlistRoutes);
  app.use("/api/pnl", pnlRoutes);
  app.use("/api/cache", cacheRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/trader-config", traderConfigRoutes);
  app.use("/api/old-tokens", oldTokensRoute);
  app.use("/api/social", socialRoute);
  return app;
};
