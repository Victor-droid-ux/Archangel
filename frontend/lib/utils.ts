/**
 * ==========================================================
 *  🧠 Unified Fetcher Utility
 * ==========================================================
 */
export const fetcher = async <T = any>(
  url: string,
  options: RequestInit = {}
): Promise<T> => {
  const BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

  const finalUrl = url.startsWith("http") ? url : `${BASE}${url}`;

  // Timeout protection (30 seconds for slow API responses)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res: Response;

  try {
    res = await fetch(finalUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (err: any) {
    clearTimeout(timeout);

    if (err?.name === "AbortError") {
      throw new Error(`⏳ Request timed out: ${finalUrl}`);
    }

    throw new Error(`🌐 Network error: ${err?.message || "Unknown error"}`);
  }

  clearTimeout(timeout);

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`❌ Invalid JSON response from ${finalUrl}`);
  }

  if (!res.ok || json?.success === false) {
    throw new Error(
      json?.message ||
        `❌ Request failure: HTTP ${res.status} — ${res.statusText}`
    );
  }

  return json as T;
};

/**
 * 📌 POST helper
 */
export const post = async <T = any>(url: string, body: any): Promise<T> =>
  fetcher<T>(url, {
    method: "POST",
    body: JSON.stringify(body),
  });

/**
 * 🧩 Tailwind class combiner
 */
export function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ");
}

/**
 * 💰 Format numbers nicely
 */
export const formatNumber = (num: number, decimals = 2) =>
  Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
  }).format(num);

/**
 * 🔗 Shorten Solana addresses — matches the 8+4 convention used everywhere
 * else in the app truncates a mint/address inline (LiveTrades.tsx,
 * PipelineStatus.tsx, TokenDiscovery.tsx, etc.)
 */
export const truncateAddress = (address: string) =>
  address ? `${address.slice(0, 8)}...${address.slice(-4)}` : "";

/**
 * ⏰ Format timestamps
 */
export const formatTime = (date: Date | string) => {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", { hour12: false });
};
