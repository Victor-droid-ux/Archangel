"use client";

import React, { useEffect, useState } from "react";
import { Twitter, MessageCircle, TrendingUp, TrendingDown } from "lucide-react";
import { Switch } from "@components/ui/switch";
import { Card } from "@components/ui/card";
import { fetcher } from "@lib/utils";

export const SocialFilter = () => {
  const [enabled, setEnabled] = useState(true);
  const [stats, setStats] = useState({ count: 0, sentiment: 0 });

  useEffect(() => {
    if (!enabled) return;

    const load = async () => {
      try {
        const res = await fetcher("/api/social/twitter");
        setStats(res);
      } catch {
        setStats({ count: 0, sentiment: 0 });
      }
    };

    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, [enabled]);

  return (
    <Card className="p-4 bg-base-200">
      <h2 className="text-lg font-semibold text-primary">Social Filters</h2>

      <div className="flex justify-between items-center mt-3">
        <div className="flex items-center gap-2">
          <Twitter size={18} className="text-sky-400" />
          <span>Twitter Mentions</span>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {enabled && (
        <div className="mt-2 ml-6 text-sm">
          <p>
            Mentions: <b>{stats.count}</b>
          </p>

          <p
            className={`flex items-center gap-1 ${
              stats.sentiment >= 50 ? "text-green-400" : "text-red-400"
            }`}
          >
            Sentiment: {stats.sentiment}%{" "}
            {stats.sentiment >= 50 ? (
              <TrendingUp size={14} />
            ) : (
              <TrendingDown size={14} />
            )}
          </p>
        </div>
      )}
    </Card>
  );
};
