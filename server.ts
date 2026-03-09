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

import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cron from "node-cron";

import { db, initDB, defaultConfig } from "./lib/db.js";
import { fetchGoogleReviews, getCache, runRefresh } from "./lib/reviews.js";
import { runAiPick } from "./lib/ai.js";
import { buildWidgetScript } from "./lib/widgetTemplate.js";
import type { Review } from "./lib/types.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Env Var Validation ───────────────────────────────────────────────────────
// DATABASE_URL is checked in lib/db.ts (it exits immediately if missing).

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

const extraOrigins = (process.env.WIDGET_ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: [
    process.env.ADMIN_PORTAL_URL as string,
    /\.gymdesk\.com$/,
    ...extraOrigins,
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
}));

app.use(express.json());

const requireAdminKey = (req: Request, res: Response, next: NextFunction): void => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

// ─── Rate Limiters ────────────────────────────────────────────────────────────

const loginLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts — try again in 15 minutes." } });
const refreshLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: "Too many refresh requests — try again in an hour." } });
const aiPickLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: "Too many AI pick requests — try again in an hour." } });

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/api/login", loginLimiter, (req: Request, res: Response): void => {
  const { password } = req.body as { password?: string };
  if (!process.env.ADMIN_PASSWORD) {
    res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server." });
    return;
  }
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  res.json({ token: process.env.ADMIN_API_KEY });
});

app.get("/api/system/capabilities", (_req: Request, res: Response): void => {
  res.json({
    outscraperAvailable: !!process.env.OUTSCRAPER_API_KEY,
  });
});

app.get("/api/reviews", async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows: cfgRows } = await db.query<{ value: { reviewSource?: string } }>(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const source = cfgRows[0]?.value?.reviewSource || "google";

    let reviews: Review[], overallRating: number | null, totalReviews: number | null;

    if (source === "outscraper") {
      const cache = await getCache();
      if (!cache) {
        res.json({ reviews: [], overallRating: null, totalReviews: null, cacheEmpty: true });
        return;
      }
      reviews       = cache.reviews;
      overallRating = cache.overallRating;
      totalReviews  = cache.totalReviews;
    } else {
      ({ reviews, overallRating, totalReviews } = await fetchGoogleReviews());
    }

    const { rows } = await db.query<{ review_id: string; pinned: boolean; ai_picked: boolean }>(
      "SELECT * FROM pinned_reviews"
    );
    const stateMap  = Object.fromEntries(rows.map(r => [r.review_id, r]));
    const merged    = reviews.map(r => ({
      ...r,
      pinned:   stateMap[r.id]?.pinned    ?? false,
      aiPicked: stateMap[r.id]?.ai_picked ?? false,
    }));

    res.json({ reviews: merged, overallRating, totalReviews });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error fetching reviews:", msg);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/reviews/cache-status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const cache = await getCache();

    const { rows: logRows } = await db.query<{
      success: boolean;
      error_message: string | null;
      created_at: Date;
    }>("SELECT * FROM refresh_log ORDER BY created_at DESC LIMIT 1");
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
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/reviews/refresh", requireAdminKey, refreshLimiter, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { reviewCount } = await runRefresh();
    res.json({ success: true, reviewCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.query(
      "INSERT INTO refresh_log (success, error_message, source) VALUES (FALSE, $1, 'outscraper')",
      [msg]
    ).catch(() => {});
    console.error("Manual refresh failed:", msg);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/reviews/pin", requireAdminKey, async (req: Request, res: Response): Promise<void> => {
  const { reviewId, pinned } = req.body as { reviewId?: string; pinned?: boolean };
  if (!reviewId || typeof pinned !== "boolean") {
    res.status(400).json({ error: "reviewId and pinned (boolean) required" });
    return;
  }
  await db.query(`
    INSERT INTO pinned_reviews (review_id, pinned)
    VALUES ($1, $2)
    ON CONFLICT (review_id) DO UPDATE SET pinned = $2
  `, [reviewId, pinned]);
  res.json({ success: true });
});

app.get("/api/config", async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await db.query<{ value: Record<string, unknown> }>(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    if (rows.length === 0) {
      res.json(defaultConfig());
      return;
    }
    res.json(rows[0].value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/config", requireAdminKey, async (req: Request, res: Response): Promise<void> => {
  try {
    const config = req.body as Record<string, unknown>;
    await db.query(`
      INSERT INTO widget_config (key, value, updated_at)
      VALUES ('main', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(config)]);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/ai-pick", requireAdminKey, aiPickLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: cfgRows } = await db.query<{ value: { reviewSource?: string } }>(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const source = cfgRows[0]?.value?.reviewSource || "google";

    let reviews: Review[];
    if (source === "outscraper") {
      const cache = await getCache();
      if (!cache || !cache.reviews?.length) {
        res.status(400).json({ error: "No cached reviews. Run a refresh first." });
        return;
      }
      reviews = cache.reviews;
    } else {
      reviews = (req.body as { reviews?: Review[] }).reviews ?? [];
      if (!reviews.length) {
        res.status(400).json({ error: "reviews array required" });
        return;
      }
    }

    const result = await runAiPick(reviews);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Claude API error:", msg);
    res.status(500).json({ error: "AI pick failed: " + msg });
  }
});

app.get("/widget.js", (_req: Request, res: Response): void => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300");
  const apiBase = process.env.API_BASE_URL || "https://your-app.up.railway.app";
  res.send(buildWidgetScript(apiBase));
});

// ─── Weekly Cron ──────────────────────────────────────────────────────────────

cron.schedule("0 2 * * 0", async () => {
  try {
    const { rows } = await db.query<{ value: { reviewSource?: string; refreshSchedule?: string; autoAiPick?: boolean } }>(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    const config = rows[0]?.value || {};

    if (config.reviewSource !== "outscraper" || config.refreshSchedule !== "weekly") {
      return;
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error("❌ Weekly refresh error:", msg);
    await db.query(
      "INSERT INTO refresh_log (success, error_message, source) VALUES (FALSE, $1, 'outscraper')",
      [msg]
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
