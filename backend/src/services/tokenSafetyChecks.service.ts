// backend/src/services/tokenSafetyChecks.service.ts
// Shared safety checks used by BOTH auto-buy paths (autoBuyer.service.ts's
// tradeValidation.service.ts, and jupiterDiscovery/storedTokenChecker's
// jupiterTokenValidator.service.ts). Before this file existed, each path had
// its own independent copy of "is this token safe" — one checked holder
// concentration but never tax/honeypot, the other checked tax/honeypot but
// never holder concentration, so which protections a token got depended on
// which discovery mechanism found it first. Extracting these here means both
// paths run the identical checks against the identical data.
import { getConnection } from "./solana.service.js";
import { getLogger } from "../utils/logger.js";
import { PublicKey } from "@solana/web3.js";
import axios from "axios";

const LOG = getLogger("token-safety-checks");

export interface RugCheckReport {
  available: boolean;
  taxes: { buyTax: number; sellTax: number };
  isHoneypot: boolean;
  lpLocked: boolean;
}

/**
 * Single fetch of RugCheck's report, reused for the tax, honeypot, and
 * LP-lock checks. `available: false` means the API genuinely couldn't be
 * reached/parsed — callers must fail their checks closed on that, not assume
 * the token is safe just because the check couldn't run.
 */
export async function fetchRugCheckReport(
  tokenMint: string,
): Promise<RugCheckReport> {
  try {
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { timeout: 5000 },
    );
    if (!response.data) {
      return {
        available: false,
        taxes: { buyTax: 0, sellTax: 0 },
        isHoneypot: true,
        lpLocked: false,
      };
    }

    const market = response.data.markets?.[0] ?? {};
    const risks: any[] = Array.isArray(response.data.risks)
      ? response.data.risks
      : [];

    const isHoneypot = risks.some(
      (r) =>
        r.name?.toLowerCase().includes("honeypot") ||
        r.name?.toLowerCase().includes("cannot sell"),
    );

    const lpLockedPct = Number(
      market.lp?.lpLockedPct ?? market.lpLockedPct ?? 0,
    );
    const unlockedRisk = risks.some(
      (r) =>
        r.name?.toLowerCase().includes("lp") &&
        (r.name?.toLowerCase().includes("unlock") ||
          r.name?.toLowerCase().includes("not locked")),
    );
    const lpLocked = lpLockedPct >= 80 && !unlockedRisk;

    return {
      available: true,
      taxes: {
        buyTax: Number(market.buyTax || 0),
        sellTax: Number(market.sellTax || 0),
      },
      isHoneypot,
      lpLocked,
    };
  } catch (err: any) {
    LOG.debug(`RugCheck API unavailable: ${err?.message ?? String(err)}`);
    return {
      available: false,
      taxes: { buyTax: 0, sellTax: 0 },
      isHoneypot: true,
      lpLocked: false,
    };
  }
}

export interface HolderDistribution {
  creatorHoldings: number;
  top3Combined: number;
  available: boolean;
}

const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/**
 * Top-holder concentration, straight from on-chain token account data.
 * `available: false` on an RPC error — callers must fail closed, not treat a
 * failed lookup as "0% concentrated" (maximally decentralized).
 *
 * `creatorAddress` (Jupiter's `devAddress`, when known) is used to compute
 * creatorHoldings directly, instead of assuming the largest holder IS the
 * creator. On a freshly launched pool, the single largest balance is very
 * often the AMM's own vault, not the deployer — without this, a token whose
 * pool happens to hold >20% would fail creator_holdings checks regardless of
 * what the actual deployer wallet holds, and a deployer who split holdings
 * across several wallets each individually under the threshold would pass
 * despite controlling far more supply collectively.
 *
 * `excludeOwners` (typically the pool/AMM address) is dropped from the
 * ranking entirely before computing top3Combined, for the same reason — the
 * pool's balance is liquidity, not a wallet that can independently dump.
 * Best-effort: this only reliably excludes the pool where its pool-state
 * address is also the authority holding its token vault (true for some but
 * not necessarily every AMM/launchpad program) — it's not a guarantee every
 * pool-controlled account gets caught.
 */
export async function getHolderDistribution(
  tokenMint: string,
  options: {
    creatorAddress?: string | null | undefined;
    excludeOwners?: (string | null | undefined)[] | undefined;
  } = {},
): Promise<HolderDistribution> {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccounts = await connection.getProgramAccounts(
      SPL_TOKEN_PROGRAM_ID,
      {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
        ],
      },
    );

    // SPL token account layout: mint (bytes 0-32), owner (32-64), amount (64-72).
    // account.pubkey is the token account's OWN address, not the wallet that
    // owns it — the owner has to be decoded from the account data itself.
    const allHoldings = tokenAccounts
      .map((account) => {
        const data = account.account.data;
        const amount = Number(data.readBigUInt64LE(64));
        const owner = new PublicKey(data.subarray(32, 64)).toBase58();
        return { amount, owner };
      })
      .filter((h) => h.amount > 0);

    if (allHoldings.length === 0) {
      return { creatorHoldings: 0, top3Combined: 0, available: true };
    }

    // Total supply denominator includes everything, pool included — a pool
    // legitimately holding most of supply isn't wrong, it's just not
    // "concentration risk" in the sense these two metrics are meant to catch.
    const totalSupply = allHoldings.reduce((sum, h) => sum + h.amount, 0);

    const excludeSet = new Set(
      (options.excludeOwners ?? []).filter((a): a is string => !!a),
    );
    const rankedHoldings = allHoldings
      .filter((h) => !excludeSet.has(h.owner))
      .sort((a, b) => b.amount - a.amount);

    const creatorHolding = options.creatorAddress
      ? allHoldings.find((h) => h.owner === options.creatorAddress)
      : rankedHoldings[0]; // no known deployer wallet — fall back to largest non-pool holder
    const creatorHoldings =
      creatorHolding && totalSupply > 0
        ? (creatorHolding.amount / totalSupply) * 100
        : 0;

    const top3Amount = rankedHoldings
      .slice(0, 3)
      .reduce((sum, h) => sum + h.amount, 0);
    const top3Combined = totalSupply > 0 ? (top3Amount / totalSupply) * 100 : 0;

    return { creatorHoldings, top3Combined, available: true };
  } catch (err) {
    LOG.warn(`Failed to get holder distribution: ${err}`);
    return { creatorHoldings: 0, top3Combined: 0, available: false };
  }
}

/**
 * Confirm the pool account itself still exists and holds a real balance.
 * Fails closed (false) when there's no address to check or the RPC call errors.
 */
export async function checkPoolStillLive(
  tokenMint: string,
  poolAddress?: string,
): Promise<boolean> {
  if (!poolAddress) {
    LOG.debug({ tokenMint }, "No pool address available for LP-removal check");
    return false;
  }
  try {
    const connection = getConnection();
    const info = await connection.getAccountInfo(new PublicKey(poolAddress));
    return !!info && info.lamports > 0;
  } catch (err) {
    LOG.warn(
      `Failed to check pool liveness for ${tokenMint.slice(0, 8)}...: ${err}`,
    );
    return false;
  }
}
