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

// QuickNode Streams signs each delivery with an HMAC in a header (configured
// per-Stream in the QuickNode dashboard, alongside a shared secret you set
// there) — verify the exact header name/scheme against your Stream's
// "Security" settings and adjust `verifySignature` below to match, since
// that's a per-account dashboard configuration, not a fixed constant.
const WEBHOOK_SECRET = process.env.QUICKNODE_WEBHOOK_SECRET || "";

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
  const signature =
    req.header("x-qn-signature") || req.header("x-webhook-signature");
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody ?? JSON.stringify(req.body))
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
