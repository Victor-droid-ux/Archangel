import {
  computePositionSize,
  minBalanceForSlots,
  normalizeMaxOpenPositions,
  sizingEnv,
  DEFAULT_MAX_OPEN_POSITIONS,
} from "../utils/positionSizing.js";

const base = { minTradeSol: 0.01, feeReserveSol: 0 };

describe("computePositionSize", () => {
  it("splits the balance into N equal positions as slots fill up", () => {
    // $10 (here 10 SOL) with 5 slots -> five positions of 2.
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        ...base,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (!r.ok) throw new Error(`expected a buy at slot ${open}`);
      sizes.push(r.buySol);
      balance -= r.buySol;
    }
    expect(sizes).toEqual([2, 2, 2, 2, 2]);
    expect(Math.round(balance * 1e9)).toBe(0);
  });

  it("stops with AT_CAPACITY once all N slots are open, whatever the balance", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 100,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AT_CAPACITY");
  });

  it("keeps every slice the same size when a fee reserve is held back", () => {
    const reserve = 0.01;
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        minTradeSol: 0.01,
        feeReserveSol: reserve,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (!r.ok) throw new Error("expected a buy");
      sizes.push(Number(r.buySol.toFixed(9)));
      balance -= r.buySol;
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe(1.998);
    // the reserve is still there at the end
    expect(Number(balance.toFixed(9))).toBe(reserve);
  });

  it("reports LOW_BALANCE when what's left can't fund one minimum position", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.015,
      openPositions: 2,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "LOW_BALANCE") {
      expect(r.spendableSol).toBeCloseTo(0.005, 9);
      expect(r.neededSol).toBeCloseTo(0.02, 9);
    } else {
      throw new Error("expected LOW_BALANCE");
    }
  });

  it("uses fewer, larger positions when the balance can't fund every slot at the minimum", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.04,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.slotsUsed).toBe(3); // 0.03 spendable / 0.01 = 3 (not 2 from float noise)
    expect(r.buySol).toBeCloseTo(0.01, 9);
  });

  it("re-splits recovered balance across the slots that free up", () => {
    // 4 of 5 open, 3 SOL back in the wallet: one free slot gets all of it.
    const r = computePositionSize({
      ...base,
      balanceSol: 3,
      openPositions: 4,
      maxOpenPositions: 5,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBe(3);
    expect(r.freeSlots).toBe(1);
  });

  it("treats a non-finite balance as empty", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: NaN,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
  });
});

describe("minBalanceForSlots", () => {
  it("is the reserve plus the minimum for each slot", () => {
    expect(minBalanceForSlots(5, 0.01, 0.01)).toBeCloseTo(0.06, 9);
    expect(minBalanceForSlots(0, 0.01, 0.01)).toBeCloseTo(0.01, 9);
  });
});

describe("normalizeMaxOpenPositions", () => {
  const saved = process.env.DEFAULT_MAX_OPEN_POSITIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEFAULT_MAX_OPEN_POSITIONS;
    else process.env.DEFAULT_MAX_OPEN_POSITIONS = saved;
  });

  it("keeps a valid whole number", () => {
    expect(normalizeMaxOpenPositions(3)).toBe(3);
    expect(normalizeMaxOpenPositions(50)).toBe(50);
  });

  it("falls back to the default for anything unusable", () => {
    delete process.env.DEFAULT_MAX_OPEN_POSITIONS;
    for (const bad of [undefined, null, 0, -1, 2.5, 51, "3", NaN]) {
      expect(normalizeMaxOpenPositions(bad)).toBe(DEFAULT_MAX_OPEN_POSITIONS);
    }
  });

  it("honors DEFAULT_MAX_OPEN_POSITIONS from the environment", () => {
    process.env.DEFAULT_MAX_OPEN_POSITIONS = "8";
    expect(normalizeMaxOpenPositions(undefined)).toBe(8);
    process.env.DEFAULT_MAX_OPEN_POSITIONS = "999"; // invalid -> built-in default
    expect(normalizeMaxOpenPositions(undefined)).toBe(
      DEFAULT_MAX_OPEN_POSITIONS,
    );
  });
});

describe("sizingEnv", () => {
  it("reads the minimum trade and fee reserve from the environment", () => {
    const min = process.env.MIN_AUTO_TRADE_SOL;
    const reserve = process.env.TRADE_FEE_RESERVE_SOL;
    process.env.MIN_AUTO_TRADE_SOL = "0.02";
    process.env.TRADE_FEE_RESERVE_SOL = "0.05";
    try {
      expect(sizingEnv()).toEqual({ minTradeSol: 0.02, feeReserveSol: 0.05 });
    } finally {
      if (min === undefined) delete process.env.MIN_AUTO_TRADE_SOL;
      else process.env.MIN_AUTO_TRADE_SOL = min;
      if (reserve === undefined) delete process.env.TRADE_FEE_RESERVE_SOL;
      else process.env.TRADE_FEE_RESERVE_SOL = reserve;
    }
  });
});
