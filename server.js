/**
 * Google Reviews Widget — Backend API
 * Runs on Railway as a Node.js/Express server.
 *
 * Routes:
 *   POST /api/login                — validate admin password, return session token
 *   GET  /api/system/capabilities  — report which optional features are available
 *   GET  /api/reviews              — fetch reviews (Google Places live OR Outscraper cache)
 *   GET  /api/reviews/cache-status — last refresh timestamp, source, and failure info
 *   POST /api/reviews/refresh      — manually trigger an Outscraper fetch and cache update
 *   POST /api/reviews/pin          — toggle pinned state for a review
 *   GET  /api/config               — load widget config from DB
 *   POST /api/config               — save widget config to DB
 *   POST /api/ai-pick              — call Claude to pick best reviews
 *   GET  /widget.js                — serve embeddable widget script
 *
 * Open Source — MIT License
 * https://github.com/your-org/reviews-widget
 */

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cron from "node-cron";

import { db, initDB, defaultConfig } from "./lib/db.js";
import { fetchGoogleReviews, getCache, runRefresh } from "./lib/reviews.js";
import { runAiPick } from "./lib/ai.js";
import { buildWidgetScript } from "./lib/widgetTemplate.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Env Var Validation ───────────────────────────────────────────────────────
// DATABASE_URL is checked in lib/db.js (it exits immediately if missing).

if (!process.env.ADMIN_API_KEY) {
  console.error("❌ ADMIN_API_KEY is not set. Set it in your environment variables.");
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn("⚠️  ADMIN_PASSWORD is not set — admin portal login will be disabled.");
}
if (!process.env.API_BASE_URL) {
  console.warn("⚠️  API_BASE_URL is not set — widget.js will use a placeholder URL.");
}
if (!process.env.GOOGLE_PLACES_API_KEY || !process.env.GOOGLE_PLACE_ID) {
  console.warn("⚠️  GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID not set — Google Places source will be unavailable.");
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY not set — AI pick feature will be unavailable.");
}
if (!process.env.ADMIN_PORTAL_URL) {
  console.warn("⚠️  ADMIN_PORTAL_URL not set — admin portal CORS will not be configured.");
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Parse any extra allowed origins from WIDGET_ALLOWED_ORIGINS (comma-separated)
// e.g. WIDGET_ALLOWED_ORIGINS=https://goldenjj.com,https://www.goldenjj.com
const extraOrigins = (process.env.WIDGET_ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: [
    process.env.ADMIN_PORTAL_URL,  // your Railway admin portal URL
    /\.gymdesk\.com$/,             // allow all gymdesk subdomains
    ...extraOrigins,               // custom domains set via env var
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
}));

app.use(express.json());

// Admin key auth middleware (protects write routes)
const requireAdminKey = (req, res, next) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ─── Rate Limiters ────────────────────────────────────────────────────────────

const loginLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts — try again in 15 minutes." } });
const refreshLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: "Too many refresh requests — try again in an hour." } });
const aiPickLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: "Too many AI pick requests — try again in an hour." } });

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/login
 * Validates the admin password (set via ADMIN_PASSWORD env var on the backend).
 * Returns the API token on success — never exposes the raw API key in env vars.
 */
app.post("/api/login", loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server." });
  }
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  res.json({ token: process.env.ADMIN_API_KEY });
});

/**
 * GET /api/system/capabilities
 * Tells the frontend which optional features are available on this deployment.
 */
app.get("/api/system/capabilities", (_req, res) => {
  res.json({
    outscraperAvailable: !!process.env.OUTSCRAPER_API_KEY,
  });
});

/**
 * GET /api/reviews
 * If source is 'outscraper': serve from cache merged with pinned state.
 * If source is 'google': fetch live from Google Places.
 */
app.get("/api/reviews", async (_req, res) => {
  try {
    const { rows: cfgRows } = await db.query(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const source = cfgRows[0]?.value?.reviewSource || "google";

    let reviews, overallRating, totalReviews;

    if (source === "outscraper") {
      const cache = await getCache();
      if (!cache) {
        return res.json({ reviews: [], overallRating: null, totalReviews: null, cacheEmpty: true });
      }
      reviews       = cache.reviews;
      overallRating = cache.overallRating;
      totalReviews  = cache.totalReviews;
    } else {
      ({ reviews, overallRating, totalReviews } = await fetchGoogleReviews());
    }

    // Merge pinned/ai state from DB
    const { rows } = await db.query("SELECT * FROM pinned_reviews");
    const stateMap  = Object.fromEntries(rows.map(r => [r.review_id, r]));
    const merged    = reviews.map(r => ({
      ...r,
      pinned:   stateMap[r.id]?.pinned   ?? false,
      aiPicked: stateMap[r.id]?.ai_picked ?? false,
    }));

    res.json({ reviews: merged, overallRating, totalReviews });
  } catch (err) {
    console.error("Error fetching reviews:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reviews/cache-status
 * Returns info about the last Outscraper fetch: timestamp, success, error.
 */
app.get("/api/reviews/cache-status", async (_req, res) => {
  try {
    const cache = await getCache();

    const { rows: logRows } = await db.query(
      "SELECT * FROM refresh_log ORDER BY created_at DESC LIMIT 1"
    );
    const lastLog = logRows[0] || null;

    res.json({
      outscraperAvailable: !!process.env.OUTSCRAPER_API_KEY,
      hasCachedData:       !!cache,
      fetchedAt:           cache?.fetchedAt || null,
      reviewCount:         cache?.reviews?.length || 0,
      lastRefreshSuccess:  lastLog?.success ?? null,
      lastRefreshError:    lastLog?.success === false ? lastLog.error_message : null,
      lastRefreshAt:       lastLog?.created_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reviews/refresh
 * Manually triggers an Outscraper fetch and updates the cache.
 */
app.post("/api/reviews/refresh", requireAdminKey, refreshLimiter, async (_req, res) => {
  try {
    const { reviewCount } = await runRefresh();
    res.json({ success: true, reviewCount });
  } catch (err) {
    await db.query(
      "INSERT INTO refresh_log (success, error_message, source) VALUES (FALSE, $1, 'outscraper')",
      [err.message]
    ).catch(() => {});
    console.error("Manual refresh failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reviews/pin
 * Body: { reviewId: string, pinned: boolean }
 */
app.post("/api/reviews/pin", requireAdminKey, async (req, res) => {
  const { reviewId, pinned } = req.body;
  if (!reviewId || typeof pinned !== "boolean") {
    return res.status(400).json({ error: "reviewId and pinned (boolean) required" });
  }
  await db.query(`
    INSERT INTO pinned_reviews (review_id, pinned)
    VALUES ($1, $2)
    ON CONFLICT (review_id) DO UPDATE SET pinned = $2
  `, [reviewId, pinned]);
  res.json({ success: true });
});

/**
 * GET /api/config
 */
app.get("/api/config", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    if (rows.length === 0) return res.json(defaultConfig());
    res.json(rows[0].value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config
 */
app.post("/api/config", requireAdminKey, async (req, res) => {
  try {
    const config = req.body;
    await db.query(`
      INSERT INTO widget_config (key, value, updated_at)
      VALUES ('main', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(config)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai-pick
 * If source is 'outscraper', uses all cached reviews.
 * If source is 'google', uses the reviews array from the request body.
 */
app.post("/api/ai-pick", requireAdminKey, aiPickLimiter, async (req, res) => {
  try {
    const { rows: cfgRows } = await db.query(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const source = cfgRows[0]?.value?.reviewSource || "google";

    let reviews;
    if (source === "outscraper") {
      const cache = await getCache();
      if (!cache || !cache.reviews?.length) {
        return res.status(400).json({ error: "No cached reviews. Run a refresh first." });
      }
      reviews = cache.reviews;
    } else {
      reviews = req.body.reviews;
      if (!reviews?.length) {
        return res.status(400).json({ error: "reviews array required" });
      }
    }

    const result = await runAiPick(reviews);
    res.json(result);
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: "AI pick failed: " + err.message });
  }
});

/**
 * GET /widget.js
 * Serves the embeddable widget script.
 */
app.get("/widget.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300");
  const apiBase = process.env.API_BASE_URL || "https://your-app.up.railway.app";
  res.send(buildWidgetScript(apiBase));
});

// ─── Weekly Cron ──────────────────────────────────────────────────────────────

// Runs every Sunday at 2am. Checks config at runtime so toggling the setting
// takes effect without a redeploy.
cron.schedule("0 2 * * 0", async () => {
  try {
    const { rows } = await db.query(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const config = rows[0]?.value || {};

    if (config.reviewSource !== "outscraper" || config.refreshSchedule !== "weekly") {
      return; // Weekly refresh not enabled
    }

    console.log("🕐 Weekly review refresh starting...");
    await runRefresh();

    if (config.autoAiPick) {
      console.log("🤖 Running auto AI pick after weekly refresh...");
      const cache = await getCache();
      if (cache?.reviews?.length) {
        await runAiPick(cache.reviews);
        console.log("✅ Auto AI pick complete");
      }
    }
  } catch (err) {
    console.error("❌ Weekly refresh error:", err.message);
    await db.query(
      "INSERT INTO refresh_log (success, error_message, source) VALUES (FALSE, $1, 'outscraper')",
      [err.message]
    ).catch(() => {});
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Reviews Widget API running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
