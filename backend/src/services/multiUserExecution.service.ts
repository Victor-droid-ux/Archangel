// backend/src/services/multiUserExecution.service.ts
//
// Phase 4 of per-user custodial trading: once a token has been discovered
// and looks like a real candidate, this fans the buy decision out across
// every eligible funded, auto-trade-enabled user — each one independently
// risk-checked and executed with their OWN hot wallet (see userWallet.service.ts)
// — instead of a single admin wallet deciding once for everyone. The token-
// intrinsic validation stages (liquidity, routing, authority, market health)
// still only need to be correct once; what genuinely differs per user is
// balance, existing positions, and settings, all of which
// validationPipeline.service.ts's runPipeline() already re-checks per
// WalletContext passed to it.
import { getLogger } from "../utils/logger.js";
import validationPipelineService, {
  WalletContext,
  PipelineResult,
} from "./validationPipeline.service.js";
import userWalletService from "./userWallet.service.js";
import { getTraderConfig } from "./traderConfig.service.js";
import { loadKeypairFromEnv } from "./solana.service.js";
import dbService from "./db.service.js";

const LOG = getLogger("multi-user-execution");

// Below this, a hot wallet is treated as unfunded for auto-trading purposes
// (matches validationPipeline.service.ts's own MIN_AUTO_TRADE_SOL floor —
// no point fanning a pipeline run out to a wallet that Stage 0 will reject
// anyway, that's just wasted Jupiter/Birdeye calls).
const MIN_FUNDED_BALANCE_SOL = Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.01);

const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

function operatorWalletContext(): WalletContext {
  const keypair = loadKeypairFromEnv();
  const publicKey = keypair.publicKey.toBase58();
  return { ownerWallet: publicKey, publicKey, keypair };
}

/**
 * True unless this wallet has set its own Max Total Trades and already hit
 * it. No setting (the default for every wallet, including one that's never
 * touched Global Trade Settings) means unlimited — matches how every other
 * per-wallet setting in this codebase defaults to "off"/unrestricted until
 * explicitly configured.
 */
async function isUnderTradeCap(wallet: string): Promise<boolean> {
  const config = await getTraderConfig(wallet);
  const maxTotalTrades = config?.globalSettings?.maxTotalTrades;
  if (maxTotalTrades == null || maxTotalTrades <= 0) return true;
  const tradesTaken = await dbService.getTotalTradesCount(wallet);
  return tradesTaken < maxTotalTrades;
}

/**
 * Every wallet currently eligible to receive an auto-buy: the operator's
 * own wallet (the bot's original, always-on identity — gated the same way
 * it always has been, by JUPITER_AUTO_BUY/config upstream of this call) plus
 * every user-created custodial hot wallet that has auto-trade enabled in
 * its owner's Global Trade Settings AND a non-dust balance. Either can be
 * excluded by its own Max Total Trades cap, once reached.
 */
export async function getEligibleWallets(): Promise<WalletContext[]> {
  const eligible: WalletContext[] = [];

  // Operator wallet: always eligible from this function's point of view —
  // whether auto-buy actually happens for it is gated by the caller
  // (jupiterDiscovery.service.ts / storedTokenChecker.service.ts's existing
  // JUPITER_AUTO_BUY config), same as before this phase existed — except its
  // own Max Total Trades cap, if it has set one, same as any other wallet.
  const operatorCtx = operatorWalletContext();
  if (await isUnderTradeCap(operatorCtx.ownerWallet)) {
    eligible.push(operatorCtx);
  } else {
    LOG.info(
      { wallet: operatorCtx.ownerWallet },
      "Operator wallet excluded from this round: Max Total Trades reached"
    );
  }

  const userWallets = await userWalletService.listAllUserWallets();
  for (const uw of userWallets) {
    try {
      const config = await getTraderConfig(uw.ownerWallet);
      if (!config?.globalSettings?.autoTradeEnabled) continue;

      const { balanceSol } = (await userWalletService.getUserWalletBalanceSol(
        uw.ownerWallet
      )) ?? { balanceSol: 0 };
      if (balanceSol < MIN_FUNDED_BALANCE_SOL) continue;

      const maxTotalTrades = config.globalSettings.maxTotalTrades;
      if (maxTotalTrades != null && maxTotalTrades > 0) {
        const tradesTaken = await dbService.getTotalTradesCount(uw.ownerWallet);
        if (tradesTaken >= maxTotalTrades) {
          LOG.info(
            { ownerWallet: uw.ownerWallet, tradesTaken, maxTotalTrades },
            "Wallet excluded from this round: Max Total Trades reached"
          );
          continue;
        }
      }

      const keypair = await userWalletService.getUserWalletKeypair(uw.ownerWallet);
      if (!keypair) continue;

      eligible.push({
        ownerWallet: uw.ownerWallet,
        publicKey: uw.hotWalletPublicKey,
        keypair,
      });
    } catch (err: any) {
      LOG.error(
        { ownerWallet: uw.ownerWallet, err: err?.message },
        "Failed to evaluate wallet for auto-trade eligibility — skipping it"
      );
    }
  }

  return eligible;
}

export interface FanOutResult {
  ownerWallet: string;
  result: PipelineResult;
}

/**
 * Runs the full validation+execution pipeline for a single token, once per
 * eligible wallet, sequentially. Sequential (not parallel) is deliberate: it
 * keeps Jupiter/Birdeye request pacing predictable rather than multiplying
 * bursts by however many users are active, and one wallet's slow/failed run
 * never risks stepping on another's in-flight buy. A failure or rejection
 * for one wallet never stops the rest — each is independent.
 */
export async function runPipelineForAllEligibleWallets(
  tokenMint: string,
  lpSol: number
): Promise<FanOutResult[]> {
  const wallets = await getEligibleWallets();
  const results: FanOutResult[] = [];

  for (const walletContext of wallets) {
    try {
      const result = await validationPipelineService.runPipeline(
        tokenMint,
        lpSol,
        walletContext
      );
      results.push({ ownerWallet: walletContext.ownerWallet, result });
    } catch (err: any) {
      LOG.error(
        { ownerWallet: walletContext.ownerWallet, tokenMint, err: err?.message },
        "Pipeline run failed unexpectedly for this wallet — continuing with the rest"
      );
      results.push({
        ownerWallet: walletContext.ownerWallet,
        result: {
          success: false,
          reason: err?.message || "Unexpected pipeline error",
          results: [],
        },
      });
    }
  }

  return results;
}

export default {
  getEligibleWallets,
  runPipelineForAllEligibleWallets,
};
