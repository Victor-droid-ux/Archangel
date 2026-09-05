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
    // Backend routes aren't consistent about the error key (some use
    // `message`, others `error`) — check both before falling back.
    throw new Error(
      json?.message ||
        json?.error ||
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
 * 💵 Format a token price specifically — freshly-launched tokens routinely
 * price at a small fraction of a cent (e.g. $0.0000144), and formatNumber's
 * normal 2-decimal default rounds that straight to "0", which reads as "no
 * price data" even though a real price exists. Uses significant digits
 * instead of a fixed decimal count for anything under $1, so a genuinely
 * tiny price still shows real digits.
 */
export const formatPrice = (num: number): string => {
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return "0";
  if (Math.abs(num) >= 1) return formatNumber(num, 2);
  return Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
    minimumSignificantDigits: 2,
  }).format(num);
};

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
