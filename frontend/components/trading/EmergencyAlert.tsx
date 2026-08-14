// components/trading/EmergencyAlert.tsx
"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, XCircle, Info } from "lucide-react";
import { useSocket } from "@hooks/useSocket";

interface Alert {
  id: string;
  type: "emergency" | "error" | "warning";
  message: string;
  timestamp: number;
}

export const EmergencyAlert: React.FC = () => {
  const { lastMessage } = useSocket();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    if (!lastMessage) return;

    const { event, payload } = lastMessage;

    // Emergency exits
    if (event === "tradeFeed" && payload?.emergency) {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "emergency",
          message: `🚨 EMERGENCY EXIT: ${
            payload.exitReason || "Critical trigger"
          } - Token: ${payload.token}`,
          timestamp: Date.now(),
        },
      ]);
    }

    // Trade errors
    if (event === "tradeError") {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type:
            payload.type === "test_sell_failed_emergency_exit"
              ? "emergency"
              : "error",
          message: payload.message || "Trade error occurred",
          timestamp: Date.now(),
        },
      ]);
    }

    // Position trailing updates (warning level)
    if (event === "position:trailingUpdate" && payload?.trailingActivated) {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "warning",
          message: `📉 Trailing Stop Active: ${payload.token} (Peak: +${(
            payload.highestPnlPct * 100
          ).toFixed(1)}%)`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [lastMessage]);

  // Auto-dismiss alerts after 10 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setAlerts((prev) =>
        prev.filter((alert) => now - alert.timestamp < 10000)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-md">
      <AnimatePresence>
        {alerts.map((alert) => (
          <motion.div
            key={alert.id}
            // opacity starts at 1 (unlike a typical enter animation) — this
            // is a safety-critical alert, it must never be able to render
            // invisible if the enter transition stalls for any reason.
            initial={{ opacity: 1, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            className={`rounded-lg shadow-lg p-4 border-2 ${
              alert.type === "emergency"
                ? "bg-red-900/90 border-red-500 text-red-100"
                : alert.type === "error"
                ? "bg-orange-900/90 border-orange-500 text-orange-100"
                : "bg-yellow-900/90 border-yellow-500 text-yellow-100"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {alert.type === "emergency" ? (
                  <XCircle size={20} />
                ) : alert.type === "error" ? (
                  <AlertTriangle size={20} />
                ) : (
                  <Info size={20} />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold">{alert.message}</p>
                <p className="text-xs opacity-70 mt-1">
                  {new Date(alert.timestamp).toLocaleTimeString()}
                </p>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="flex-shrink-0 opacity-70 hover:opacity-100 transition"
              >
                <XCircle size={16} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
