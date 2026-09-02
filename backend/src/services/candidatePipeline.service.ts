// backend/src/services/candidatePipeline.service.ts
//
// The single linear discovery→validate→buy pipeline. Replaces the three
// overlapping polling loops (jupiterDiscovery.service.ts,
// tokenDiscovery.service.ts + autoBuyer.service.ts, and
// storedTokenChecker.service.ts) that used to each run their own take on
// "Jupiter validation + filtering" concurrently. There is now exactly one
// entry point — processCandidateMint() — invoked once per mint, driven by
// the QuickNode webhook (see routes/quicknode.route.ts) instead of three
// independent polling timers:
//
//   Phase 1  QuickNode webhook        → routes/quicknode.route.ts
//   Phase 2  Token extraction         → tokenExtraction.service.ts
//   Phase 3  Jupiter validation       → jupiterTradeability.service.ts
//   Phase 4  Token filtering          → tokenFiltering.service.ts
//   Phase 5  Jupiter quote  ┐
//   Phase 6  Trading        ┘ per-wallet fan-out → multiUserExecution.service.ts
//                              (which calls validationPipeline.service.ts per wallet)
//   Phase 7  Monitoring               → monitor.service.ts / pnlTracker.service.ts (unchanged)
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { checkJupiterTradeability } from "./jupiterTradeability.service.js";
import {
  applyArchAngelFilters,
  ArchAngelFilterConfig,
} from "./tokenFiltering.service.js";
import multiUserExecutionService from "./multiUserExecution.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { addTrackedToken } from "./tokenPrice.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import {
  claimMint,
  completeMint,
  releaseMint,
} from "./discoveryCoordinator.service.js";
import type { CandidateMint } from "./tokenExtraction.service.js";

const LOG = getLogger("candidate-pipeline");
const MAX_CANDIDATE_DELIVERY_AGE_MS = Number(
  process.env.MAX_CANDIDATE_DELIVERY_AGE_MS ?? 120_000,
);

interface PipelineConfig extends ArchAngelFilterConfig {
  autoBuyEnabled: boolean;
}

function loadConfig(): PipelineConfig {
  return {
    maxBuyTax: Number(process.env.MAX_BUY_TAX_PCT || 5),
    maxSellTax: Number(process.env.MAX_SELL_TAX_PCT || 5),
    requireMintDisabled: process.env.REQUIRE_MINT_DISABLED !== "false",
    requireFreezeDisabled: process.env.REQUIRE_FREEZE_DISABLED !== "false",
    requireLpLocked: process.env.REQUIRE_LP_LOCKED === "true",
    autoBuyEnabled: process.env.JUPITER_AUTO_BUY === "true",
  };
}

let io: SocketIOServer | null = null;
export function setSocketIO(server: SocketIOServer): void {
  io = server;
}

export function isFreshCandidate(
  poolCreatedAt: Date,
  now = Date.now(),
): boolean {
  const ageMs = now - poolCreatedAt.getTime();
  return (
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= MAX_CANDIDATE_DELIVERY_AGE_MS
  );
}

/**
 * Runs the full pipeline for a single candidate mint. Safe to call
 * concurrently for different mints; a given mint is only ever taken through
 * to a buy attempt once (see the claimMint/completeMint/releaseMint dedup
 * around Phase 5/6 below) — a duplicate webhook delivery for the same mint
 * is the expected reason to call this twice, not a bug.
 */
export async function processCandidateMint(
  candidate: CandidateMint,
): Promise<void> {
  const { mint } = candidate;
  const config = loadConfig();

  if (!isFreshCandidate(candidate.poolCreatedAt)) {
    LOG.info(
      { mint: mint.slice(0, 8), poolCreatedAt: candidate.poolCreatedAt },
      "Skipping stale QuickNode pool-creation candidate",
    );
    io?.emit("candidate:stale", {
      mint,
      poolCreatedAt: candidate.poolCreatedAt,
    });
    return;
  }

  // Already seen this mint before (regardless of outcome) — one pass through
  // this pipeline per mint is the whole point of the consolidation, so don't
  // reprocess it just because a second pool-creation event referenced it.
  const existing = await dbService.getTokenState(mint);
  if (existing) {
    LOG.debug(
      { mint: mint.slice(0, 8), state: existing.state },
      "Already processed — skipping",
    );
    return;
  }

  LOG.info(
    { mint: mint.slice(0, 8), dex: candidate.dex },
    "🎯 New candidate from QuickNode webhook",
  );

  await dbService.upsertTokenState({
    mint,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    state: "DISCOVERED",
    source: "quicknode",
    ...(candidate.poolCreatedAt && { poolCreatedAt: candidate.poolCreatedAt }),
    poolAddress: candidate.poolAddress || "",
    detectedAt: new Date(),
  });
  io?.emit("candidate:detected", {
    mint,
    dex: candidate.dex,
    timestamp: new Date().toISOString(),
  });

  // Phase 3 — Jupiter validation.
  const tradeability = await checkJupiterTradeability(mint);
  await dbService.upsertTokenState({
    mint,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    state: tradeability.tradeable ? "TRADABLE" : "DISCOVERED",
    source: "quicknode",
    jupiterTradable: tradeability.tradeable,
    liquiditySOL: tradeability.liquiditySol,
    liquidityUSD: tradeability.liquidityUsd,
    ...(candidate.poolCreatedAt && { poolCreatedAt: candidate.poolCreatedAt }),
    poolAddress: candidate.poolAddress || "",
    detectedAt: new Date(),
    ...(tradeability.tradeable ? { confirmedTradableAt: new Date() } : {}),
  });

  if (!tradeability.tradeable) {
    LOG.info(
      { mint: mint.slice(0, 8), reason: tradeability.reason },
      "❌ Not tradeable on Jupiter",
    );
    io?.emit("candidate:not_tradeable", { mint, reason: tradeability.reason });
    return;
  }
  io?.emit("candidate:tradeable", {
    mint,
    liquiditySol: tradeability.liquiditySol,
  });

  // Launch market cap — captured here, right after Phase 3, from
  // tradeability.launchMarketCapSol (on-chain supply × the Phase 3 buy
  // quote's implied price). Deliberately not from Birdeye's FDV: this is
  // the field multiUserExecution.service.ts's per-wallet minimum-market-cap
  // gate reads, and market cap is the one filter the client specifically
  // wants enforced — it needs a number that doesn't share Birdeye's
  // indexing-lag failure mode (FDV reading $0 for a token this fresh just
  // as often as its volume figure used to). Captured before Phase 4 runs
  // rather than after, so even a token that fails Phase 4's other checks
  // still gets a correctly-captured launch-time snapshot recorded.
  if (tradeability.launchMarketCapSol != null) {
    await dbService.setLaunchMarketCapIfUnset(
      mint,
      tradeability.launchMarketCapSol,
    );
  }

  // Phase 4 — token filtering (ArchAngel criteria).
  const filterResult = await applyArchAngelFilters(
    mint,
    config,
    undefined,
    candidate.poolAddress,
  );
  if (!filterResult.approved) {
    await dbService.updateTokenState(mint, { autoBuyEligible: false });
    LOG.info(
      { mint: mint.slice(0, 8), failed: filterResult.failedFilters },
      `❌ ${filterResult.reason}`,
    );
    io?.emit("candidate:filtered_out", {
      mint,
      reason: filterResult.reason,
      failedFilters: filterResult.failedFilters,
    });
    return;
  }
  LOG.info(
    { mint: mint.slice(0, 8), passed: filterResult.passedFilters },
    "✅ Passed ArchAngel filters",
  );
  await dbService.updateTokenState(mint, {
    autoBuyEligible: true,
    autoBuyEligibleAt: new Date(),
  });
  addTrackedToken(mint, "NEW", {
    liquidity: tradeability.liquidityUsd,
  });
  io?.emit("candidate:approved", {
    mint,
    passedFilters: filterResult.passedFilters,
  });

  if (!config.autoBuyEnabled) {
    LOG.debug(
      { mint: mint.slice(0, 8) },
      "Auto-buy disabled — stopping after filtering",
    );
    return;
  }

  // Claim before Phase 5/6: prevents a duplicate/near-simultaneous webhook
  // delivery for the same mint from triggering two independent buy fan-outs.
  if (!(await claimMint(mint))) {
    LOG.debug(
      { mint: mint.slice(0, 8) },
      "Mint already claimed for buy — skipping",
    );
    return;
  }

  LOG.info(
    { mint: mint.slice(0, 8) },
    "🚀 Phase 5/6 — quoting and buying across eligible wallets",
  );
  let fanOutResults;
  try {
    fanOutResults =
      await multiUserExecutionService.runPipelineForAllEligibleWallets(
        mint,
        tradeability.liquiditySol,
      );
  } catch (err) {
    await releaseMint(mint);
    throw err;
  }
  await completeMint(mint);

  // Phase 7 — hand off to monitoring for every wallet that actually bought.
  for (const { ownerWallet, result } of fanOutResults) {
    if (!result.success) {
      LOG.warn(
        { mint: mint.slice(0, 8), wallet: ownerWallet, reason: result.reason },
        `❌ Buy failed at stage ${result.failedStage}: ${result.failedStageName}`,
      );
      emitToWalletOrGlobal(io, ownerWallet, "candidate:buy_failed", {
        mint,
        wallet: ownerWallet,
        failedStage: result.failedStage,
        failedStageName: result.failedStageName,
        reason: result.reason,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    LOG.info(
      {
        mint: mint.slice(0, 8),
        wallet: ownerWallet,
        signature: result.executionResult?.signature,
      },
      "✅ Buy executed — handing off to monitoring",
    );

    if (result.executionResult) {
      pnlTrackerService.startTracking({
        tokenMint: mint,
        entryPrice: result.executionResult.actualPrice || 0,
        amount: result.executionResult.tokensReceived || 0,
        wallet: ownerWallet,
        entryTime: Date.now(),
      });
    }

    emitToWalletOrGlobal(io, ownerWallet, "tradeFeed", {
      type: "buy",
      token: mint,
      wallet: ownerWallet,
      amount: Math.round((result.executionResult?.amountSol ?? 0) * 1e9),
      price: result.executionResult?.actualPrice,
      pnl: 0,
      signature: result.executionResult?.signature,
      timestamp: new Date().toISOString(),
      auto: true,
      reason: "candidate_pipeline_buy",
      route: "jupiter",
    });

    emitToWalletOrGlobal(io, ownerWallet, "candidate:buy_success", {
      mint,
      wallet: ownerWallet,
      signature: result.executionResult?.signature,
      tokensReceived: result.executionResult?.tokensReceived,
      actualPrice: result.executionResult?.actualPrice,
      timestamp: new Date().toISOString(),
    });
  }
}

export default { setSocketIO, processCandidateMint };
