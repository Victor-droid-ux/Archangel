// backend/src/routes/solami.route.ts
//
// Solami counterpart to quicknode.route.ts — same role in the pipeline
// (Phase 1: receive a decoded new-pool event, hand it to the same
// candidatePipelineService.processCandidateMint everything else already
// uses), same shape, deliberately not sharing code with the QuickNode
// route since their payload/signature schemes are unrelated and forcing a
// shared abstraction over two one-off webhook formats tends to age badly.
//
// Runs ADDITIVELY alongside routes/quicknode.route.ts, not instead of it —
// same "prove it before retiring the old path" principle as every other
// migration in this codebase. See docs/discovery-migration-quicknode-to-solami-spec.md.
//
// PRE-LAUNCH VERIFICATION REQUIRED, same spirit as cpmm.ts's own note when
// it was first written against an unconfirmed SDK surface:
//   1. Signature scheme below (HMAC-SHA256 over the raw body, hex digest)
//      is the most common industry convention, NOT confirmed against
//      Solami's actual implementation — their docs state "an HMAC of the
//      body with your secret" without specifying algorithm or encoding.
//      Verify against the header value on the first real delivery before
//      trusting this in production; a real bug here fails CLOSED (rejects
//      real deliveries), not open, so it's a discovery-outage risk, not a
//      fund-safety one — still worth fixing promptly once discovered.
//   2. pool_create's exact field shape (solamiExtraction.service.ts) is
//      inferred from the Blur docs' token_create example plus "same shape,
//      name fields blank" — not yet observed on a real delivery.
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getLogger } from "../utils/logger.js";
import { extractCandidateMintFromSolamiEvent } from "../services/solamiExtraction.service.js";
import { processCandidateMint } from "../services/candidatePipeline.service.js";

const LOG = getLogger("solami-webhook");
const router = Router();

// The webhook's own signing secret (whsec_... — shown once at creation in
// the Solami dashboard), NOT an API key. Same "fails loudly if unset"
// posture as QUICKNODE_WEBHOOK_SECRET.
const WEBHOOK_SECRET = process.env.SOLAMI_WEBHOOK_SECRET || "";

function verifySignature(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    LOG.warn(
      "SOLAMI_WEBHOOK_SECRET not set — webhook signature check is disabled",
    );
    return true;
  }

  const signatureHeader = req.header("x-webhook-signature");
  if (!signatureHeader) return false;

  const payload = req.rawBody
    ? req.rawBody.toString("utf8")
    : JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  // Some providers prefix the header (e.g. "sha256=<hex>") — accept both
  // forms rather than guess wrong and reject every real delivery.
  const received = signatureHeader.includes("=")
    ? signatureHeader.split("=").pop()!
    : signatureHeader;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(received, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    // Length/encoding mismatch — definitely not equal, and definitely
    // worth knowing about if this fires on every delivery (points at a
    // wrong assumption above, not a real forged request).
    LOG.warn(
      { receivedLength: received.length, expectedLength: expected.length },
      "Solami webhook signature comparison threw — likely a scheme mismatch, see this file's PRE-LAUNCH note",
    );
    return false;
  }
}

router.post("/webhooks/solami", (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    LOG.warn("Rejected Solami webhook: signature verification failed");
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // Ack immediately, then process — same reasoning as quicknode.route.ts:
  // downstream Jupiter/RugCheck/Birdeye calls are too slow to run inside
  // the request/response cycle without risking a retried duplicate
  // delivery (Solami's own docs confirm 3 retries with backoff on a slow
  // endpoint).
  res.status(200).json({ received: true });

  const candidate = extractCandidateMintFromSolamiEvent(req.body);
  if (!candidate) {
    // Not necessarily an error — see extractCandidateMintFromSolamiEvent's
    // own comment on why non-pool_create deliveries are expected and
    // silently ignored here.
    return;
  }

  processCandidateMint(candidate, "solami").catch((err) => {
    LOG.error(
      { mint: candidate.mint.slice(0, 8), err: err?.message },
      "Candidate pipeline failed unexpectedly",
    );
  });
});

export default router;
