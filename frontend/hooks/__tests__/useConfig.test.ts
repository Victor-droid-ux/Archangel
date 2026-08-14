import { describe, it, expect, vi, beforeEach } from "vitest";

const fetcherMock = vi.fn();
vi.mock("@lib/utils", () => ({
  fetcher: (...args: any[]) => fetcherMock(...args),
}));

import { useTradingConfigStore } from "../useConfig";

const defaults = {
  amount: 0.1,
  slippage: 1,
  takeProfit: 10,
  stopLoss: 2,
  autoTrade: false,
  dexRoute: "Jupiter",
  selectedToken: undefined,
};

beforeEach(() => {
  useTradingConfigStore.setState({ ...defaults });
  window.localStorage.clear();
  fetcherMock.mockReset();
});

describe("useTradingConfigStore", () => {
  it("round-trips through localStorage via saveConfig/loadConfig", () => {
    useTradingConfigStore.getState().setAmount(0.5);
    useTradingConfigStore.getState().setSlippage(3);
    useTradingConfigStore.getState().saveConfig();

    // Reset in-memory state to defaults, then reload from storage.
    useTradingConfigStore.setState({ ...defaults });
    useTradingConfigStore.getState().loadConfig();

    expect(useTradingConfigStore.getState().amount).toBe(0.5);
    expect(useTradingConfigStore.getState().slippage).toBe(3);
  });

  it("migrates a stale saved BONK selectedToken to undefined on load", () => {
    window.localStorage.setItem(
      "tradingConfig",
      JSON.stringify({ ...defaults, selectedToken: "BONK" })
    );
    useTradingConfigStore.getState().loadConfig();
    expect(useTradingConfigStore.getState().selectedToken).toBeUndefined();
  });

  it("does nothing when there is no saved config", () => {
    useTradingConfigStore.getState().loadConfig();
    expect(useTradingConfigStore.getState().amount).toBe(defaults.amount);
  });

  it("loadConfigFromAPI populates the store from a successful response", async () => {
    fetcherMock.mockResolvedValue({
      success: true,
      data: { amount: 0.77, autoTrade: true },
    });

    await useTradingConfigStore.getState().loadConfigFromAPI("SomeWallet111");

    expect(fetcherMock).toHaveBeenCalledWith(
      "/api/user/settings?wallet=SomeWallet111"
    );
    expect(useTradingConfigStore.getState().amount).toBe(0.77);
    expect(useTradingConfigStore.getState().autoTrade).toBe(true);
  });

  it("loadConfigFromAPI leaves the store untouched when the wallet is empty", async () => {
    await useTradingConfigStore.getState().loadConfigFromAPI("");
    expect(fetcherMock).not.toHaveBeenCalled();
  });

  it("loadConfigFromAPI does not throw when the request fails", async () => {
    fetcherMock.mockRejectedValue(new Error("network down"));
    await expect(
      useTradingConfigStore.getState().loadConfigFromAPI("SomeWallet111")
    ).resolves.toBeUndefined();
  });
});
