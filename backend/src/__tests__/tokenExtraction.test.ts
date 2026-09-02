import { extractCandidateMints } from "../services/tokenExtraction.service.js";
import { isFreshCandidate } from "../services/candidatePipeline.service.js";

const TOKEN_MINT = "11111111111111111111111111111112";
const POOL_ADDRESS = "11111111111111111111111111111113";

describe("strict QuickNode pool extraction", () => {
  it("accepts a complete structured pool-creation event", () => {
    const candidates = extractCandidateMints({
      mint: TOKEN_MINT,
      poolAddress: POOL_ADDRESS,
      dex: "raydium_amm_v4",
      blockTime: 1_700_000_000,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      mint: TOKEN_MINT,
      poolAddress: POOL_ADDRESS,
      dex: "raydium_amm_v4",
    });
    expect(candidates[0]?.poolCreatedAt).toBeInstanceOf(Date);
  });

  it("rejects structured events missing pool, DEX, or creation time", () => {
    expect(extractCandidateMints({ mint: TOKEN_MINT, dex: "raydium" })).toEqual(
      [],
    );
    expect(
      extractCandidateMints({
        mint: TOKEN_MINT,
        poolAddress: POOL_ADDRESS,
        blockTime: 1_700_000_000,
      }),
    ).toEqual([]);
  });

  it("rejects raw transaction fallback payloads for auto-trade", () => {
    expect(
      extractCandidateMints({
        blockTime: 1_700_000_000,
        meta: {
          preTokenBalances: [],
          postTokenBalances: [{ mint: TOKEN_MINT }],
        },
      }),
    ).toEqual([]);
  });
});

describe("candidate delivery freshness", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");

  it("accepts a fresh pool event and rejects a delayed or future event", () => {
    expect(isFreshCandidate(new Date(now - 30_000), now)).toBe(true);
    expect(isFreshCandidate(new Date(now - 120_001), now)).toBe(false);
    expect(isFreshCandidate(new Date(now + 1), now)).toBe(false);
  });
});
