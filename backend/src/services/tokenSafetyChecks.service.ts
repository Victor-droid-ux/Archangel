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
export async function fetchRugCheckReport(tokenMint: string): Promise<RugCheckReport> {
  try {
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { timeout: 5000 }
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
        r.name?.toLowerCase().includes("cannot sell")
    );

    const lpLockedPct = Number(market.lp?.lpLockedPct ?? market.lpLockedPct ?? 0);
    const unlockedRisk = risks.some((r) =>
      r.name?.toLowerCase().includes("lp") &&
      (r.name?.toLowerCase().includes("unlock") || r.name?.toLowerCase().includes("not locked"))
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

/**
 * Top-holder concentration, straight from on-chain token account data.
 * `available: false` on an RPC error — callers must fail closed, not treat a
 * failed lookup as "0% concentrated" (maximally decentralized).
 */
export async function getHolderDistribution(
  tokenMint: string
): Promise<HolderDistribution> {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccounts = await connection.getProgramAccounts(
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
        ],
      }
    );

    const holdings = tokenAccounts
      .map((account) => {
        const amount = account.account.data.readBigUInt64LE(64);
        return { amount: Number(amount), owner: account.pubkey.toBase58() };
      })
      .filter((h) => h.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    if (holdings.length === 0) {
      return { creatorHoldings: 0, top3Combined: 0, available: true };
    }

    const totalSupply = holdings.reduce((sum, h) => sum + h.amount, 0);
    const creatorHoldings =
      holdings.length > 0 && holdings[0] ? (holdings[0].amount / totalSupply) * 100 : 0;
    const top3Amount = holdings.slice(0, 3).reduce((sum, h) => sum + h.amount, 0);
    const top3Combined = (top3Amount / totalSupply) * 100;

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
  poolAddress?: string
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
    LOG.warn(`Failed to check pool liveness for ${tokenMint.slice(0, 8)}...: ${err}`);
    return false;
  }
}
