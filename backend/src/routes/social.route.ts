import express from "express";

const router = express.Router();

// GET /api/social/twitter
router.get("/twitter", async (req, res) => {
  // Placeholder: return mock data
  res.json({
    success: true,
    data: {
      trending: [
        { symbol: "SOL", mentions: 1200 },
        { symbol: "BONK", mentions: 900 },
        { symbol: "WIF", mentions: 700 },
      ],
      lastUpdated: new Date().toISOString(),
    },
  });
});

export default router;
