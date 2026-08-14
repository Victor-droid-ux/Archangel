import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const fetcherMock = vi.fn();
vi.mock("@lib/utils", () => ({
  fetcher: (...args: any[]) => fetcherMock(...args),
}));

let mockLastMessage: any = null;
vi.mock("@hooks/useSocket", () => ({
  useSocket: () => ({ lastMessage: mockLastMessage }),
}));

import { useWatchlist } from "../useWatchlist";

beforeEach(() => {
  fetcherMock.mockReset();
  mockLastMessage = null;
});

describe("useWatchlist", () => {
  it("loads the watchlist on mount", async () => {
    fetcherMock.mockResolvedValue({
      success: true,
      tokens: [{ mint: "MintA", symbol: "A", addedAt: "2026-01-01" }],
    });

    const { result } = renderHook(() => useWatchlist());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetcherMock).toHaveBeenCalledWith("/api/watchlist");
    expect(result.current.tokens).toHaveLength(1);
    expect(result.current.tokens[0].mint).toBe("MintA");
  });

  it("clears to an empty list (not a crash) when the load fails", async () => {
    fetcherMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokens).toEqual([]);
  });

  it("addToken posts to the API then reloads the list", async () => {
    fetcherMock
      .mockResolvedValueOnce({ success: true, tokens: [] }) // initial load
      .mockResolvedValueOnce({ success: true }) // POST /api/watchlist
      .mockResolvedValueOnce({
        success: true,
        tokens: [{ mint: "MintB", addedAt: "2026-01-01" }],
      }); // reload after add

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addToken("MintB", "B");
    });

    expect(fetcherMock).toHaveBeenCalledWith("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ mint: "MintB", symbol: "B", name: undefined }),
    });
    expect(result.current.tokens.some((t) => t.mint === "MintB")).toBe(true);
  });

  it("does not reload after addToken when the API call itself fails", async () => {
    fetcherMock
      .mockResolvedValueOnce({ success: true, tokens: [] })
      .mockResolvedValueOnce({ success: false, error: "duplicate" });

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addToken("MintC");
    });

    // Only the initial load + the failed POST — no follow-up reload fetch.
    expect(fetcherMock).toHaveBeenCalledTimes(2);
  });
});
