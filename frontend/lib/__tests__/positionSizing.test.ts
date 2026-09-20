import { describe, it, expect } from "vitest";
import { computePositionSize, minBalanceForSlots } from "../positionSizing";

const base = { minTradeSol: 0.01, feeReserveSol: 0 };

describe("computePositionSize (must match the backend rule)", () => {
  it("splits the balance into N equal positions as slots fill", () => {
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        ...base,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (r.status !== "ready") throw new Error("expected ready");
      sizes.push(r.buySol);
      balance -= r.buySol;
    }
    expect(sizes).toEqual([2, 2, 2, 2, 2]);
  });

  it("is at capacity once every slot is open", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 100,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(r.status).toBe("at_capacity");
  });

  it("is low_balance when what's left can't fund one minimum position", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.015,
      openPositions: 2,
      maxOpenPositions: 5,
    });
    expect(r.status).toBe("low_balance");
    if (r.status === "low_balance") expect(r.neededSol).toBeCloseTo(0.02, 9);
  });

  it("uses fewer, larger positions when the balance can't fund every slot", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.04,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.slotsUsed).toBe(3);
    expect(r.buySol).toBeCloseTo(0.01, 9);
  });

  it("treats a non-finite balance as empty", () => {
    expect(
      computePositionSize({
        ...base,
        balanceSol: NaN,
        openPositions: 0,
        maxOpenPositions: 5,
      }).status
    ).toBe("low_balance");
  });
});

describe("minBalanceForSlots", () => {
  it("is the reserve plus the minimum for each slot", () => {
    expect(minBalanceForSlots(5, 0.01, 0.01)).toBeCloseTo(0.06, 9);
  });
});

import { describeSizing } from "../positionSizing";

describe("describeSizing", () => {
  it("says nothing when there is no result yet", () => {
    expect(describeSizing(null, 1)).toBeNull();
  });

  it("reports the per-position size", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 10,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    const d = describeSizing(r, 10);
    expect(d?.tone).toBe("ok");
    expect(d?.text).toContain("2 SOL per position");
  });

  it("reports a full house as information, not an error", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 10,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(describeSizing(r, 10)?.tone).toBe("info");
  });

  it("reports low balance as a warning with the amount needed", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.01,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    const d = describeSizing(r, 0.01);
    expect(d?.tone).toBe("warn");
    expect(d?.text).toContain("0.02 SOL");
  });
});
