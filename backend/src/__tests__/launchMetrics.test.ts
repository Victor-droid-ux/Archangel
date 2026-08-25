import {
  launchMetricsWithinLimits,
  launchMetricsFromTokenState,
  launchAgeWithinWindow,
  LaunchMetrics,
} from "../services/multiUserExecution.service.js";

const config = {
  minMarketCapSol: 3,
  maxMarketCapSol: 100,
  minMarketCapUsd: 450,
  maxMarketCapUsd: 15000,
  minLiquiditySol: 0.05,
  maxLiquiditySol: 10,
  minLiquidityUsd: 7.5,
  maxLiquidityUsd: 1500,
  takeProfitPct: 0.1,
  stopLossPct: 0.3,
  maxTradeAmountSol: 1,
  autoTrade: true,
};

const validMetrics: LaunchMetrics = {
  marketCapUSD: 1000,
  marketCapSOL: 10,
  liquidityUSD: 100,
  liquiditySOL: 1,
};

describe("launchMetricsWithinLimits", () => {
  it("accepts values exactly at every configured boundary", () => {
    expect(
      launchMetricsWithinLimits(
        {
          marketCapUSD: config.minMarketCapUsd,
          marketCapSOL: config.minMarketCapSol,
          liquidityUSD: config.minLiquidityUsd,
          liquiditySOL: config.minLiquiditySol,
        },
        config,
      ),
    ).toBe(true);

    expect(
      launchMetricsWithinLimits(
        {
          marketCapUSD: config.maxMarketCapUsd,
          marketCapSOL: config.maxMarketCapSol,
          liquidityUSD: config.maxLiquidityUsd,
          liquiditySOL: config.maxLiquiditySol,
        },
        config,
      ),
    ).toBe(true);
  });

  it.each([
    ["market cap USD below minimum", { marketCapUSD: 449 }],
    ["market cap USD above maximum", { marketCapUSD: 15001 }],
    ["market cap SOL below minimum", { marketCapSOL: 2.99 }],
    ["market cap SOL above maximum", { marketCapSOL: 100.01 }],
    ["liquidity USD below minimum", { liquidityUSD: 7.49 }],
    ["liquidity USD above maximum", { liquidityUSD: 1500.01 }],
    ["liquidity SOL below minimum", { liquiditySOL: 0.049 }],
    ["liquidity SOL above maximum", { liquiditySOL: 10.01 }],
  ])("rejects when %s", (_reason, change) => {
    expect(
      launchMetricsWithinLimits({ ...validMetrics, ...change }, config),
    ).toBe(false);
  });

  it("rejects missing or non-finite launch values", () => {
    expect(
      launchMetricsWithinLimits(
        { ...validMetrics, marketCapUSD: Number.NaN },
        config,
      ),
    ).toBe(false);
    expect(
      launchMetricsWithinLimits(
        { ...validMetrics, liquiditySOL: Number.POSITIVE_INFINITY },
        config,
      ),
    ).toBe(false);
  });
});

describe("launchMetricsFromTokenState", () => {
  it("extracts the immutable launch snapshot used by alternate auto-buy paths", () => {
    expect(
      launchMetricsFromTokenState({
        launchMarketCapUSD: 1000,
        launchMarketCapSOL: 10,
        launchLiquidityUSD: 100,
        launchLiquiditySOL: 1,
      } as any),
    ).toEqual(validMetrics);
  });

  it("returns null when no stored token exists", () => {
    expect(launchMetricsFromTokenState(null)).toBeNull();
  });
});

describe("launchAgeWithinWindow", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("accepts inclusive minimum and maximum boundaries", () => {
    expect(
      launchAgeWithinWindow(new Date(now - 10_000), now, { min: 10, max: 20 }),
    ).toBe(true);
    expect(
      launchAgeWithinWindow(new Date(now - 20_000), now, { min: 10, max: 20 }),
    ).toBe(true);
  });

  it("rejects missing, invalid, and out-of-window timestamps", () => {
    expect(launchAgeWithinWindow(undefined, now, { min: 0, max: 60 })).toBe(
      false,
    );
    expect(launchAgeWithinWindow("invalid", now, { min: 0, max: 60 })).toBe(
      false,
    );
    expect(
      launchAgeWithinWindow(new Date(now - 61_000), now, { min: 0, max: 60 }),
    ).toBe(false);
  });
});
