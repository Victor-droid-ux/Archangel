// backend/src/routes/quicknode.route.ts
//
// Phase 1 of the linear discovery→validate→buy pipeline: receive Solana
// pool-creation events from a QuickNode Stream/webhook.
//
// Responds 200 immediately and processes candidates asynchronously —
// QuickNode retries a webhook delivery that doesn't ack quickly, and Phase
// 3/4 (Jupiter + RugCheck/Birdeye calls) are far too slow to run inside the
// request/response cycle without triggering duplicate retried deliveries.
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getLogger } from "../utils/logger.js";
import { extractCandidateMints } from "../services/tokenExtraction.service.js";
import { processCandidateMint } from "../services/candidatePipeline.service.js";

const LOG = getLogger("quicknode-webhook");
const router = Router();

// QuickNode Streams' actual signing scheme (confirmed against QuickNode's own
// "Validating Incoming Streams Webhook Messages" guide — this is not a
// per-account setting, it's fixed): each delivery carries three headers,
// X-QN-Nonce, X-QN-Timestamp, and X-QN-Signature. The signature is
// HMAC-SHA256, keyed with the Stream's security token, over the
// concatenation `nonce + timestamp + rawBody` — NOT the raw body alone.
// Signing just the body (what this used to do) can never match, regardless
// of how correct the secret and raw-body capture are.
const WEBHOOK_SECRET = process.env.QUICKNODE_WEBHOOK_SECRET || "";

// Reject deliveries whose timestamp is older than this, even with an
// otherwise-valid signature — defends against a captured request being
// replayed later. QuickNode's own guide calls this out as recommended
// alongside the nonce.
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

function verifySignature(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    // No secret configured — allow through, but loudly, so this doesn't fail
    // silently open in production. Set QUICKNODE_WEBHOOK_SECRET before
    // pointing a real Stream at this endpoint.
    LOG.warn(
      "QUICKNODE_WEBHOOK_SECRET not set — webhook signature check is disabled",
    );
    return true;
  }

  const nonce = req.header("x-qn-nonce");
  const timestamp = req.header("x-qn-timestamp");
  const signature = req.header("x-qn-signature");
  if (!nonce || !timestamp || !signature) return false;

  const timestampMs = Number(timestamp) * 1000; // QuickNode sends unix seconds
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_AGE_MS
  ) {
    LOG.warn(
      { timestamp },
      "Rejected QuickNode webhook: timestamp outside allowed window (stale or replayed)",
    );
    return false;
  }

  const payload = req.rawBody
    ? req.rawBody.toString("utf8")
    : JSON.stringify(req.body);
  const message = nonce + timestamp + payload;
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    // Length mismatch etc. — definitely not equal.
    return false;
  }
}

router.post("/webhooks/quicknode", (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    LOG.warn("Rejected QuickNode webhook: signature verification failed");
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // Ack immediately, then process. Errors during processing are logged
  // per-candidate inside processCandidateMint/its callers and never surface
  // back to QuickNode — there's no response left to send them on.
  res.status(200).json({ received: true });

  let candidates;
  try {
    candidates = extractCandidateMints(req.body);
  } catch (err: any) {
    LOG.error(
      { err: err?.message },
      "Failed to extract candidates from webhook payload",
    );
    return;
  }

  if (candidates.length === 0) {
    LOG.debug("QuickNode webhook delivered no extractable candidates");
    return;
  }

  for (const candidate of candidates) {
    processCandidateMint(candidate).catch((err) => {
      LOG.error(
        { mint: candidate.mint.slice(0, 8), err: err?.message },
        "Candidate pipeline failed unexpectedly",
      );
    });
  }
});

export default router;
