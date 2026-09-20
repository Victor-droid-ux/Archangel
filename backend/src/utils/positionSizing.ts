// backend/src/utils/positionSizing.ts
//
// How the bot sizes a buy. Pure functions only (no DB, RPC or env access
// beyond sizingEnv()), so the rule is unit-tested in one place and shared by
// the buy pipeline (validationPipeline.service.ts, Stage 0) and the wallet
// status endpoint (userWallet.route.ts) — the two can never disagree about
// whether a wallet "can trade".
//
// THE RULE. A trader chooses "Max Open Positions" (N). The trading wallet's
// spendable balance is split evenly across the slots that are still free:
//
//     buy size = spendable balance / free slots      (free = N - open now)
//
// so $10 with N=5 opens five $2 positions: after the first buy there is $8
// left and 4 free slots, which is $2 again. As positions close, the slots
// free up and the recovered balance is re-split across them.
//
// What stops the bot from opening another position:
//   - all N slots are in use (AT_CAPACITY), or
//   - LOW BALANCE: what's left (after a small reserve for network fees and
//     token-account rent) can't fund even one position of MIN_AUTO_TRADE_SOL.
//
// If the balance can't fund every free slot at the minimum size, the split
// uses fewer slots (bigger positions) rather than refusing to trade: 0.04 SOL
// with a 0.01 SOL minimum and 0.01 SOL reserve opens up to three 0.01 SOL
// positions, not zero.

export const DEFAULT_MAX_OPEN_POSITIONS = 5;
export const MAX_OPEN_POSITIONS_LIMIT = 50;

export interface SizingInput {
  balanceSol: number;
  openPositions: number;
  maxOpenPositions: number;
  minTradeSol: number;
  feeReserveSol: number;
}

export type SizingResult =
  | {
      ok: true;
      buySol: number;
      /** How many equal positions the spendable balance is being split into. */
      slotsUsed: number;
      freeSlots: number;
      spendableSol: number;
    }
  | {
      ok: false;
      code: "AT_CAPACITY";
      openPositions: number;
      maxOpenPositions: number;
    }
  | {
      ok: false;
      code: "LOW_BALANCE";
      freeSlots: number;
      spendableSol: number;
      /** Total balance at which one more position becomes possible. */
      neededSol: number;
    };

/** Runtime knobs; read at call time so tests and env changes are honored. */
export function sizingEnv(): { minTradeSol: number; feeReserveSol: number } {
  return {
    minTradeSol: Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003),
    // Kept back from sizing for network fees, token-account rent (~0.002 SOL
    // for each new token) and the fees to SELL later — a wallet spent down to
    // zero couldn't pay to exit its own positions.
    feeReserveSol: Number(process.env.TRADE_FEE_RESERVE_SOL ?? 0.01),
  };
}

/** A stored/entered value -> a usable slot count, falling back to the default. */
export function normalizeMaxOpenPositions(value: unknown): number {
  const fallback = Number(
    process.env.DEFAULT_MAX_OPEN_POSITIONS ?? DEFAULT_MAX_OPEN_POSITIONS,
  );
  const base =
    Number.isInteger(fallback) &&
    fallback >= 1 &&
    fallback <= MAX_OPEN_POSITIONS_LIMIT
      ? fallback
      : DEFAULT_MAX_OPEN_POSITIONS;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_OPEN_POSITIONS_LIMIT
  ) {
    return value;
  }
  return base;
}

/** Balance needed to open `slots` positions at the minimum size. */
export function minBalanceForSlots(
  slots: number,
  minTradeSol: number,
  feeReserveSol: number,
): number {
  return feeReserveSol + Math.max(0, slots) * minTradeSol;
}

export function computePositionSize(input: SizingInput): SizingResult {
  const { balanceSol, openPositions, maxOpenPositions } = input;
  const minTradeSol = Math.max(input.minTradeSol, 0);
  const feeReserveSol = Math.max(input.feeReserveSol, 0);

  const freeSlots = maxOpenPositions - openPositions;
  if (freeSlots <= 0) {
    return { ok: false, code: "AT_CAPACITY", openPositions, maxOpenPositions };
  }

  const spendableSol = Math.max(
    0,
    (Number.isFinite(balanceSol) ? balanceSol : 0) - feeReserveSol,
  );

  // How many minimum-size positions the money can actually fund. The epsilon
  // stops 0.03 / 0.01 = 2.9999999999999996 from costing a whole slot.
  const affordableSlots =
    minTradeSol > 0 ? Math.floor(spendableSol / minTradeSol + 1e-9) : freeSlots;
  const slotsUsed = Math.min(freeSlots, affordableSlots);

  if (slotsUsed < 1) {
    return {
      ok: false,
      code: "LOW_BALANCE",
      freeSlots,
      spendableSol,
      neededSol: minBalanceForSlots(1, minTradeSol, feeReserveSol),
    };
  }

  return {
    ok: true,
    buySol: spendableSol / slotsUsed,
    slotsUsed,
    freeSlots,
    spendableSol,
  };
}
