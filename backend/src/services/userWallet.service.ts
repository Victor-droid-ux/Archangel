// backend/src/services/userWallet.service.ts
//
// Phase 1 of per-user custodial trading: generates and stores a dedicated
// hot-wallet keypair for each connected "owner" wallet (the wallet a user
// actually connects via Phantom/Solflare in the browser). The bot will
// trade using these generated wallets — funded by the owner depositing SOL
// into them — rather than the single shared ADMIN_WALLET_SECRET. Private
// keys are encrypted at rest (see utils/walletEncryption.ts); nothing here
// yet touches execution (that's a later phase) — this only covers
// generate/lookup/balance.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Collection, Db } from "mongodb";
import { getLogger } from "../utils/logger.js";
import { encryptSecret, decryptSecret } from "../utils/walletEncryption.js";
import {
  normalizeWalletAddress,
  getBalanceInSol,
  getConnection,
  getTokenBalance,
} from "./solana.service.js";
import { connect } from "./db.service.js";
import dbService from "./db.service.js";
import { getJupiterQuote, executeJupiterSwap } from "./jupiter.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { setAutoTradeEnabled } from "./traderConfig.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import type { Server } from "socket.io";

// Reserve for the transfer's own network fee — a "withdraw everything"
// request would otherwise try to send a balance that can't also cover the
// fee to send it, and fail.
const WITHDRAWAL_FEE_RESERVE_LAMPORTS = 5000;

const log = getLogger("userWallet.service");

export type UserWallet = {
  ownerWallet: string; // the wallet the user connects in the browser
  hotWalletPublicKey: string; // the bot-generated trading wallet's address
  encryptedSecretKey: string; // AES-256-GCM ciphertext of the base58 secret key
  createdAt: Date;
  // Newest transaction signature depositTracker.service.ts has already
  // classified for this wallet — lets its periodic scan resume from where
  // it left off instead of re-scanning full history every tick.
  lastScannedSignature?: string;
};

export type WalletWithdrawal = {
  ownerWallet: string;
  hotWalletPublicKey: string;
  signature: string;
  amountSol: number;
  timestamp: Date;
};

let col: Collection<UserWallet> | null = null;
let withdrawalsCol: Collection<WalletWithdrawal> | null = null;

async function getWithdrawalsCol(): Promise<Collection<WalletWithdrawal>> {
  if (withdrawalsCol) return withdrawalsCol;
  const db: Db = await connect();
  withdrawalsCol = db.collection<WalletWithdrawal>("walletWithdrawals");
  return withdrawalsCol;
}

async function getCol(): Promise<Collection<UserWallet>> {
  if (col) return col;
  const db: Db = await connect();
  col = db.collection<UserWallet>("userWallets");
  await col.createIndex({ ownerWallet: 1 }, { unique: true });
  await col.createIndex({ hotWalletPublicKey: 1 }, { unique: true });
  return col;
}

/**
 * Returns the existing hot wallet for this owner, generating one on first
 * call. Idempotent — safe to call every time a wallet connects.
 */
export async function getOrCreateUserWallet(
  ownerWalletRaw: string
): Promise<UserWallet> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const c = await getCol();

  const existing = await c.findOne({ ownerWallet });
  if (existing) return existing;

  const keypair = Keypair.generate();
  const doc: UserWallet = {
    ownerWallet,
    hotWalletPublicKey: keypair.publicKey.toBase58(),
    encryptedSecretKey: encryptSecret(bs58.encode(keypair.secretKey)),
    createdAt: new Date(),
  };

  try {
    await c.insertOne(doc);
    log.info(
      { ownerWallet, hotWallet: doc.hotWalletPublicKey },
      "Generated new custodial hot wallet"
    );
    return doc;
  } catch (err: any) {
    // Race: two near-simultaneous requests for the same never-before-seen
    // owner wallet. Unique index on ownerWallet rejects the loser — fetch
    // what the winner actually inserted instead of erroring the request.
    if (err?.code === 11000) {
      const winner = await c.findOne({ ownerWallet });
      if (winner) return winner;
    }
    throw err;
  }
}

export async function getUserWallet(
  ownerWalletRaw: string
): Promise<UserWallet | null> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const c = await getCol();
  return c.findOne({ ownerWallet });
}

/**
 * Decrypts and returns the actual signing keypair. Only for server-side use
 * at execution time (later phase) — never returned from an API response.
 */
export async function getUserWalletKeypair(
  ownerWalletRaw: string
): Promise<Keypair | null> {
  const wallet = await getUserWallet(ownerWalletRaw);
  if (!wallet) return null;
  const secretKey = bs58.decode(decryptSecret(wallet.encryptedSecretKey));
  return Keypair.fromSecretKey(secretKey);
}

export async function getUserWalletBalanceSol(
  ownerWalletRaw: string
): Promise<{ hotWalletPublicKey: string; balanceSol: number } | null> {
  const wallet = await getOrCreateUserWallet(ownerWalletRaw);
  const balanceSol = await getBalanceInSol(wallet.hotWalletPublicKey);
  return { hotWalletPublicKey: wallet.hotWalletPublicKey, balanceSol };
}

/**
 * Withdraws SOL from an owner's custodial hot wallet back to that SAME
 * owner's own connected wallet — never to an arbitrary caller-supplied
 * address, which is what makes this safe to expose even given a verified
 * signature: the destination is always the wallet that proved it owns this
 * hot wallet, so there's no address to trick the API into draining funds to.
 * Caller (the route) is responsible for verifying wallet-signature auth
 * BEFORE calling this — this function trusts ownerWalletRaw completely.
 */
export async function withdrawToOwner(
  ownerWalletRaw: string,
  amountSol: number
): Promise<{ signature: string; amountSol: number }> {
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("Withdrawal amount must be a positive number");
  }

  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const wallet = await getUserWallet(ownerWallet);
  if (!wallet) {
    throw new Error("No trading wallet found for this owner");
  }

  const keypair = await getUserWalletKeypair(ownerWallet);
  if (!keypair) {
    throw new Error("Failed to load trading wallet keypair");
  }

  const balanceLamports = Math.round(
    (await getBalanceInSol(wallet.hotWalletPublicKey)) * LAMPORTS_PER_SOL
  );
  const requestedLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const maxWithdrawableLamports = balanceLamports - WITHDRAWAL_FEE_RESERVE_LAMPORTS;

  if (maxWithdrawableLamports <= 0) {
    throw new Error("Balance too low to cover the network fee");
  }
  if (requestedLamports > maxWithdrawableLamports) {
    throw new Error(
      `Requested ${amountSol} SOL exceeds withdrawable balance of ${(
        maxWithdrawableLamports / LAMPORTS_PER_SOL
      ).toFixed(6)} SOL (after reserving the network fee)`
    );
  }

  const conn = getConnection();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(ownerWallet),
      lamports: requestedLamports,
    })
  );

  const latest = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await conn.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  log.info(
    { ownerWallet, hotWallet: wallet.hotWalletPublicKey, amountSol, signature },
    "Withdrawal completed"
  );

  // Recorded directly here (not detected from chain, unlike deposits) —
  // this is our own app-initiated transfer, so we already know everything
  // about it. depositTracker.service.ts checks this collection so a
  // withdrawal is never mistaken for an external deposit.
  const withdrawals = await getWithdrawalsCol();
  await withdrawals.insertOne({
    ownerWallet,
    hotWalletPublicKey: wallet.hotWalletPublicKey,
    signature,
    amountSol: requestedLamports / LAMPORTS_PER_SOL,
    timestamp: new Date(),
  });

  return { signature, amountSol: requestedLamports / LAMPORTS_PER_SOL };
}

/** All owner wallets with a funded (non-dust) hot wallet — used by the
 * execution fan-out in a later phase to know who's actually eligible to
 * receive an auto-buy. Not used yet. */
export async function listAllUserWallets(): Promise<UserWallet[]> {
  const c = await getCol();
  return c.find({}).toArray();
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Same floor used elsewhere (monitor.service.ts, db.service.ts) to treat a
// near-zero remainder as fully closed rather than an attemptable sell.
const POSITION_DUST_THRESHOLD_SOL = Number(
  process.env.POSITION_DUST_THRESHOLD_SOL ?? 0.0005
);

export interface StopAutoTradeResult {
  disabledAutoTrade: boolean;
  sold: { token: string; signature: string | null; amountSol: number }[];
  failed: { token: string; error: string }[];
}

/**
 * "Stop Auto Trade": disables future auto-buys for this wallet AND
 * liquidates every open position the bot has already bought for it
 * (custody === "custodial" only — a self-custody/manual position lives in
 * the user's own wallet, which only they can sign for, never the server).
 * Disabling happens first, before any selling starts, so the bot can't
 * rebuy on its next discovery tick while this is still in progress.
 */
export async function stopAutoTradeAndLiquidate(
  ownerWalletRaw: string,
  io?: Server
): Promise<StopAutoTradeResult> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);

  await setAutoTradeEnabled(ownerWallet, false, io);
  const result: StopAutoTradeResult = {
    disabledAutoTrade: true,
    sold: [],
    failed: [],
  };

  const positions = await dbService.getPositions(ownerWallet);
  const custodialOpen = positions.filter(
    (p) => p.custody === "custodial" && p.netSol >= POSITION_DUST_THRESHOLD_SOL
  );
  if (custodialOpen.length === 0) return result;

  const keypair = await getUserWalletKeypair(ownerWallet);
  if (!keypair) {
    for (const p of custodialOpen) {
      result.failed.push({ token: p.token, error: "No custodial signer available" });
    }
    return result;
  }

  for (const pos of custodialOpen) {
    try {
      // Sell the real on-chain balance, not a DB-derived approximation —
      // avoids leaving unsellable dust behind from any drift between the
      // two.
      const { raw } = await getTokenBalance(
        keypair.publicKey.toBase58(),
        pos.token
      );
      if (!raw || raw === "0") {
        result.failed.push({
          token: pos.token,
          error: "No on-chain balance found to sell",
        });
        continue;
      }

      const quote = await getJupiterQuote(pos.token, SOL_MINT, raw, 1000);
      if (!quote?.outAmount) {
        result.failed.push({
          token: pos.token,
          error: "No Jupiter route available",
        });
        continue;
      }

      const swap = await executeJupiterSwap({
        inputMint: pos.token,
        outputMint: SOL_MINT,
        amount: raw,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps: 1000,
        signer: keypair,
      });

      if (!swap.success) {
        result.failed.push({
          token: pos.token,
          error: swap.error || "Swap failed",
        });
        continue;
      }

      const amountSol = Number(quote.outAmount) / 1e9;
      const trade = await dbService.addTrade({
        type: "sell",
        token: pos.token,
        inputMint: pos.token,
        outputMint: SOL_MINT,
        amount: Number(quote.outAmount),
        price: pos.avgBuyPrice ?? 0,
        pnl: 0,
        wallet: ownerWallet,
        simulated: false,
        signature: swap.signature ?? null,
        timestamp: new Date(),
        custody: "custodial",
      });

      pnlTrackerService.stopTracking(pos.token, ownerWallet);
      emitToWalletOrGlobal(io, ownerWallet, "tradeFeed", {
        ...trade,
        auto: true,
        reason: "stop_auto_trade",
      });

      result.sold.push({
        token: pos.token,
        signature: swap.signature ?? null,
        amountSol,
      });
    } catch (err: any) {
      result.failed.push({
        token: pos.token,
        error: err?.message || "Unknown error",
      });
    }
  }

  return result;
}

export default {
  getOrCreateUserWallet,
  getUserWallet,
  getUserWalletKeypair,
  getUserWalletBalanceSol,
  withdrawToOwner,
  listAllUserWallets,
  stopAutoTradeAndLiquidate,
};
