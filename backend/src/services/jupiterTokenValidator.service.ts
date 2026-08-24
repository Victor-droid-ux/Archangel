// backend/src/services/jupiterTokenValidator.service.ts
import { getLogger } from "../utils/logger.js";
import jupiterService, {
  getSolPriceUsd,
  resolveLiquidityUsd,
  type JupiterRecentToken,
} from "./jupiter.service.js";
import {
  fetchRugCheckReport,
  getHolderDistribution,
} from "./tokenSafetyChecks.service.js";

const LOG = getLogger("jupiter-validator");

interface ValidationConfig {
  minLiquiditySol: number;
  maxBuyTax: number;
  maxSellTax: number;
  requireMintDisabled: boolean;
  requireFreezeDisabled: boolean;
  requireLpLocked: boolean;
  maxCreatorHoldingsPct?: number; // default 20
  maxTop3HoldingsPct?: number; // default 60
}

interface ValidationResult {
  approved: boolean;
  reason?: string;
  passedFilters: string[];
  failedFilters: string[];
  details: {
    liquiditySol: number;
    mintAuthorityDisabled: boolean;
    freezeAuthorityDisabled: boolean;
    buyTax: number;
    sellTax: number;
    lpLocked: boolean;
    isHoneypot: boolean;
    creatorHoldingsPct?: number;
    top3HoldingsPct?: number;
  };
}

/**
 * Comprehensive token validation before allowing an auto-buy.
 * Liquidity + mint/freeze authority come straight from Jupiter's /tokens/v2 audit
 * data (already fetched during discovery) instead of a separate on-chain RPC call.
 *
 * `prefetchedTokenInfo` lets a caller checking many tokens in one pass (e.g.
 * storedTokenChecker's per-cycle sweep) supply a tokenInfo it already fetched
 * via jupiterService.getTokenInfoBatch(), instead of this function doing its
 * own per-mint /tokens/v2/search call. Leave undefined for a standalone call;
 * pass `null` explicitly if the batch lookup ran but didn't find this mint.
 */
export async function validateJupiterToken(
  tokenMint: string,
  config: ValidationConfig,
  liquiditySol?: number,
  prefetchedTokenInfo?: JupiterRecentToken | null,
): Promise<ValidationResult> {
  const passedFilters: string[] = [];
  const failedFilters: string[] = [];

  try {
    LOG.info(`🔍 Validating token for ${tokenMint.slice(0, 8)}...`);

    const solPriceUsd = await getSolPriceUsd();
    const tokenInfo =
      prefetchedTokenInfo !== undefined
        ? prefetchedTokenInfo
        : await jupiterService.getTokenInfo(tokenMint);

    // Step 1: Check liquidity
    LOG.debug("Checking liquidity...");
    let liquidityValue: number;
    if (liquiditySol != null) {
      // Caller already has a fresh, reliable liquidity figure (e.g. straight
      // from the same /tokens/v2/recent poll that just discovered this
      // token) — use it instead of re-querying Jupiter's search catalog,
      // which is both redundant here and the exact lookup that lags/misses
      // for brand-new mints.
      liquidityValue = liquiditySol;
    } else {
      // tokenInfo?.liquidity comes from a separate Jupiter lookup
      // (/tokens/v2/search) than routing — a catalog miss there must not
      // read as "$0 liquidity" on its own; fall back to a price-impact
      // estimate from an actual quote instead of trusting a zero.
      const minLiquidityUsdHint = config.minLiquiditySol * solPriceUsd;
      const resolved = await resolveLiquidityUsd(
        tokenMint,
        minLiquidityUsdHint,
        tokenInfo,
        solPriceUsd,
      );
      liquidityValue =
        solPriceUsd > 0 ? resolved.liquidityUSD / solPriceUsd : 0;
    }

    if (liquidityValue >= config.minLiquiditySol) {
      passedFilters.push(`liquidity_check_${config.minLiquiditySol}_sol`);
      LOG.info(`✅ Liquidity check passed: ${liquidityValue.toFixed(2)} SOL`);
    } else {
      failedFilters.push(`liquidity_check_${config.minLiquiditySol}_sol`);
      LOG.warn(
        `❌ Liquidity too low: ${liquidityValue.toFixed(2)} SOL < ${config.minLiquiditySol} SOL`,
      );
      return {
        approved: false,
        reason: `Insufficient liquidity: ${liquidityValue.toFixed(2)} SOL`,
        passedFilters,
        failedFilters,
        details: {
          liquiditySol: liquidityValue,
          mintAuthorityDisabled: false,
          freezeAuthorityDisabled: false,
          buyTax: 0,
          sellTax: 0,
          lpLocked: false,
          isHoneypot: false,
        },
      };
    }

    // Step 2: Check token authorities (from Jupiter's audit data — no RPC call needed)
    const mintAuthorityDisabled = tokenInfo?.mintAuthorityDisabled ?? false;
    const freezeAuthorityDisabled = tokenInfo?.freezeAuthorityDisabled ?? false;

    if (config.requireMintDisabled) {
      if (mintAuthorityDisabled) {
        passedFilters.push("mint_authority_disabled");
        LOG.info("✅ Mint authority disabled");
      } else {
        failedFilters.push("mint_authority_disabled");
        LOG.warn("❌ Mint authority still enabled");
      }
    }

    if (config.requireFreezeDisabled) {
      if (freezeAuthorityDisabled) {
        passedFilters.push("freeze_authority_disabled");
        LOG.info("✅ Freeze authority disabled");
      } else {
        failedFilters.push("freeze_authority_disabled");
        LOG.warn("❌ Freeze authority still enabled");
      }
    }

    // Early exit if critical checks failed (skip slow API calls)
    if (failedFilters.length > 0) {
      LOG.debug(
        `Skipping slow checks - already failed ${failedFilters.length} critical checks`,
      );
      return {
        approved: false,
        reason: `Failed ${failedFilters.length} critical check(s)`,
        passedFilters,
        failedFilters,
        details: {
          liquiditySol: liquidityValue,
          mintAuthorityDisabled,
          freezeAuthorityDisabled,
          buyTax: 0,
          sellTax: 0,
          lpLocked: false,
          isHoneypot: false,
        },
      };
    }

    // Steps 3-5 all read from the same RugCheck report — fetch it once.
    LOG.debug("Fetching RugCheck report (tax, honeypot, LP-lock)...");
    const report = await fetchRugCheckReport(tokenMint);

    // Step 3: Check buy/sell taxes
    // A RugCheck outage/timeout must NOT be silently treated as "0% tax" —
    // that's exactly backwards for a check whose entire job is catching a
    // hidden high-tax rug. Fail this specific check closed; it's one of
    // several gates, not the whole pipeline, so a genuinely down API doesn't
    // block every trade — it blocks trades we can't actually verify.
    if (!report.available) {
      failedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
      failedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
      LOG.warn("❌ RugCheck unavailable — cannot verify tax, failing closed");
    } else {
      const taxes = report.taxes;
      if (taxes.buyTax <= config.maxBuyTax) {
        passedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
        LOG.info(`✅ Buy tax acceptable: ${taxes.buyTax}%`);
      } else {
        failedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
        LOG.warn(
          `❌ Buy tax too high: ${taxes.buyTax}% > ${config.maxBuyTax}%`,
        );
      }

      if (taxes.sellTax <= config.maxSellTax) {
        passedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
        LOG.info(`✅ Sell tax acceptable: ${taxes.sellTax}%`);
      } else {
        failedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
        LOG.warn(
          `❌ Sell tax too high: ${taxes.sellTax}% > ${config.maxSellTax}%`,
        );
      }
    }

    // Step 4: Honeypot check — same fail-closed reasoning as tax above; this
    // is the single check most directly meant to catch an unsellable token.
    const isHoneypot = report.available ? report.isHoneypot : true;
    if (!report.available) {
      failedFilters.push("honeypot_check");
      LOG.warn(
        "❌ RugCheck unavailable — cannot verify honeypot status, failing closed",
      );
    } else if (!isHoneypot) {
      passedFilters.push("honeypot_check");
      LOG.info("✅ Not a honeypot");
    } else {
      failedFilters.push("honeypot_check");
      LOG.warn("❌ Potential honeypot detected");
    }

    // Step 5: LP locked/burned
    let lpLocked = false;
    if (config.requireLpLocked) {
      if (!report.available) {
        failedFilters.push("lp_locked");
        LOG.warn(
          "❌ RugCheck unavailable — cannot verify LP lock status, failing closed",
        );
      } else {
        lpLocked = report.lpLocked;
        if (lpLocked) {
          passedFilters.push("lp_locked");
          LOG.info("✅ LP is locked/burned");
        } else {
          failedFilters.push("lp_locked");
          LOG.warn("❌ LP is not locked");
        }
      }
    }

    // Step 6: Holder concentration — the other auto-buy path
    // (tradeValidation.service.ts) already checked this; this path previously
    // didn't, so a 95%-creator-held token could bypass concentration
    // screening entirely depending on which discovery mechanism found it.
    const maxCreatorPct = config.maxCreatorHoldingsPct ?? 20;
    const maxTop3Pct = config.maxTop3HoldingsPct ?? 60;
    const holderDist = await getHolderDistribution(tokenMint, {
      creatorAddress: tokenInfo?.devAddress,
      excludeOwners: [tokenInfo?.firstPoolId],
    });
    const creatorBelowLimit =
      holderDist.available && holderDist.creatorHoldings <= maxCreatorPct;
    const top3BelowLimit =
      holderDist.available && holderDist.top3Combined <= maxTop3Pct;

    if (!holderDist.available) {
      failedFilters.push(`creator_holdings_under_${maxCreatorPct}_pct`);
      failedFilters.push(`top3_holdings_under_${maxTop3Pct}_pct`);
      LOG.warn("❌ Could not verify holder concentration — failing closed");
    } else {
      if (creatorBelowLimit) {
        passedFilters.push(`creator_holdings_under_${maxCreatorPct}_pct`);
        LOG.info(
          `✅ Creator holdings acceptable: ${holderDist.creatorHoldings.toFixed(1)}%`,
        );
      } else {
        failedFilters.push(`creator_holdings_under_${maxCreatorPct}_pct`);
        LOG.warn(
          `❌ Creator holds too much: ${holderDist.creatorHoldings.toFixed(1)}% > ${maxCreatorPct}%`,
        );
      }
      if (top3BelowLimit) {
        passedFilters.push(`top3_holdings_under_${maxTop3Pct}_pct`);
        LOG.info(
          `✅ Top-3 holdings acceptable: ${holderDist.top3Combined.toFixed(1)}%`,
        );
      } else {
        failedFilters.push(`top3_holdings_under_${maxTop3Pct}_pct`);
        LOG.warn(
          `❌ Top-3 holds too much: ${holderDist.top3Combined.toFixed(1)}% > ${maxTop3Pct}%`,
        );
      }
    }

    const approved = failedFilters.length === 0;
    const details = {
      liquiditySol: liquidityValue,
      mintAuthorityDisabled,
      freezeAuthorityDisabled,
      buyTax: report.taxes.buyTax,
      sellTax: report.taxes.sellTax,
      lpLocked,
      isHoneypot,
      creatorHoldingsPct: holderDist.creatorHoldings,
      top3HoldingsPct: holderDist.top3Combined,
    };

    if (approved) {
      LOG.info(
        { passed: passedFilters.length, failed: failedFilters.length },
        `✅ Token validation PASSED for ${tokenMint.slice(0, 8)}`,
      );
    } else {
      LOG.warn(
        {
          passed: passedFilters.length,
          failed: failedFilters.length,
          failedChecks: failedFilters,
        },
        `❌ Token validation FAILED for ${tokenMint.slice(0, 8)}`,
      );
    }

    const result: ValidationResult = {
      approved,
      passedFilters,
      failedFilters,
      details,
    };
    if (!approved) {
      result.reason = `Failed ${failedFilters.length} validation check(s)`;
    }
    return result;
  } catch (err: any) {
    LOG.error(`Validation error: ${err.message}`);
    return {
      approved: false,
      reason: `Validation error: ${err.message}`,
      passedFilters,
      failedFilters: ["validation_error"],
      details: {
        liquiditySol: 0,
        mintAuthorityDisabled: false,
        freezeAuthorityDisabled: false,
        buyTax: 0,
        sellTax: 0,
        lpLocked: false,
        isHoneypot: false,
      },
    };
  }
}
