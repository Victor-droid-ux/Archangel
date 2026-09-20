// frontend/lib/positionSizing.ts
//
// The same split the backend uses to size every buy (backend
// src/utils/positionSizing.ts) — kept in step by hand and pinned by tests on
// both sides — so the dashboard can say, before anything trades, what the
// next position will be and why the bot would or wouldn't open one.
//
//   buy size = spendable balance / free slots      (free = max open - open now)
//
// where spendable = balance - a small fee reserve. What stops the bot opening
// another position is either every slot being in use ("at_capacity") or a
// balance too low to fund one minimum-size position ("low_balance").

export interface SizingInput {
  balanceSol: number;
  openPositions: number;
  maxOpenPositions: number;
  minTradeSol: number;
  feeReserveSol: number;
}

export type SizingResult =
  | { status: "ready"; buySol: number; slotsUsed: number; freeSlots: number }
  | { status: "at_capacity"; openPositions: number; maxOpenPositions: number }
  | { status: "low_balance"; spendableSol: number; neededSol: number };

/** Balance needed to open `slots` positions at the minimum size. */
export function minBalanceForSlots(
  slots: number,
  minTradeSol: number,
  feeReserveSol: number
): number {
  return feeReserveSol + Math.max(0, slots) * minTradeSol;
}

export function computePositionSize(input: SizingInput): SizingResult {
  const { balanceSol, openPositions, maxOpenPositions } = input;
  const minTradeSol = Math.max(input.minTradeSol, 0);
  const feeReserveSol = Math.max(input.feeReserveSol, 0);

  const freeSlots = maxOpenPositions - openPositions;
  if (freeSlots <= 0) {
    return { status: "at_capacity", openPositions, maxOpenPositions };
  }

  const spendableSol = Math.max(
    0,
    (Number.isFinite(balanceSol) ? balanceSol : 0) - feeReserveSol
  );
  // The epsilon stops 0.03 / 0.01 = 2.9999999999999996 costing a whole slot.
  const affordableSlots =
    minTradeSol > 0 ? Math.floor(spendableSol / minTradeSol + 1e-9) : freeSlots;
  const slotsUsed = Math.min(freeSlots, affordableSlots);

  if (slotsUsed < 1) {
    return {
      status: "low_balance",
      spendableSol,
      neededSol: minBalanceForSlots(1, minTradeSol, feeReserveSol),
    };
  }

  return {
    status: "ready",
    buySol: spendableSol / slotsUsed,
    slotsUsed,
    freeSlots,
  };
}

const fmt = (n: number) => Number(n.toFixed(4));

/** One line for the settings UI: what the split means for this balance. */
export function describeSizing(
  result: SizingResult | null,
  balanceSol: number | null
): { tone: "ok" | "info" | "warn"; text: string } | null {
  if (!result) return null;
  if (result.status === "ready") {
    const partial =
      result.slotsUsed < result.freeSlots
        ? ` (the balance only funds ${result.slotsUsed} of ${result.freeSlots} free slots at the minimum size)`
        : "";
    return {
      tone: "ok",
      text: `≈ ${fmt(result.buySol)} SOL per position from your ${
        balanceSol != null ? fmt(balanceSol) : "current"
      } SOL balance${partial}.`,
    };
  }
  if (result.status === "at_capacity") {
    return {
      tone: "info",
      text: `All ${result.maxOpenPositions} slots are in use right now — a new position opens when one closes.`,
    };
  }
  return {
    tone: "warn",
    text: `Low balance — your trading wallet needs at least ${fmt(
      result.neededSol
    )} SOL before the bot can open a position.`,
  };
}
