/**
 * Google Reviews Widget — Backend API
 * Runs on Railway as a Node.js/Express server.
 *
 * Routes:
 *   GET  /api/reviews          — fetch reviews from Google Places
 *   GET  /api/config           — load widget config from DB
 *   POST /api/config           — save widget config to DB
 *   POST /api/ai-pick          — call Claude to pick best reviews
 *   GET  /widget.js            — serve embeddable widget script
 */

import express from "express";
import cors from "cors";
import pg from "pg";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: [
    process.env.ADMIN_PORTAL_URL,  // your Railway admin portal URL
    /\.gymdesk\.com$/,             // allow all gymdesk subdomains
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
}));

app.use(express.json());

// Simple admin key auth middleware (protects POST routes)
const requireAdminKey = (req, res, next) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ─── Database Setup ───────────────────────────────────────────────────────────

// Bail early with a clear message if DATABASE_URL is missing or still a placeholder
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || dbUrl.includes("user:password@host")) {
  console.error("❌ DATABASE_URL is missing or still set to the placeholder value.");
  console.error("   Set the real DATABASE_URL in your Railway environment variables.");
  process.exit(1);
}

const db = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

// Create tables if they don't exist
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS widget_config (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pinned_reviews (
      review_id   TEXT PRIMARY KEY,
      pinned      BOOLEAN DEFAULT TRUE,
      ai_picked   BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database tables ready");
}

// ─── Google Places Helper ─────────────────────────────────────────────────────

/**
 * Fetches up to 5 reviews from Google Places API for a given Place ID.
 * Note: The free Places API returns max 5 reviews. For more, you'd need
 * a third-party scraping service or a paid Places data provider.
 */
async function fetchGoogleReviews() {
  const placeId = process.env.GOOGLE_PLACE_ID;
  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;

  if (!placeId || !apiKey) {
    throw new Error("GOOGLE_PLACE_ID or GOOGLE_PLACES_API_KEY not set");
  }

  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${placeId}` +
    `&fields=name,rating,user_ratings_total,reviews` +
    `&reviews_sort=newest` +
    `&key=${apiKey}`;

  const res  = await fetch(url);
  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(`Google Places API error: ${data.status} — ${data.error_message || ""}`);
  }

  const place   = data.result;
  const reviews = (place.reviews || []).map(r => ({
    id:       r.time.toString(),      // use Unix timestamp as stable ID
    author:   r.author_name,
    avatar:   r.profile_photo_url || null,
    rating:   r.rating,
    date:     new Date(r.time * 1000).toISOString().split("T")[0],
    text:     r.text,
    pinned:   false,
    aiPicked: false,
  }));

  return {
    reviews,
    overallRating: place.rating,
    totalReviews:  place.user_ratings_total,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/reviews
 * Fetches live reviews from Google, merges in pinned/aiPicked state from DB.
 */
app.get("/api/reviews", async (req, res) => {
  try {
    const { reviews, overallRating, totalReviews } = await fetchGoogleReviews();

    // Load pinned/ai state from DB
    const { rows } = await db.query("SELECT * FROM pinned_reviews");
    const stateMap  = Object.fromEntries(rows.map(r => [r.review_id, r]));

    // Merge state into reviews
    const merged = reviews.map(r => ({
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
 * POST /api/reviews/pin
 * Body: { reviewId: string, pinned: boolean }
 * Toggles pinned state for a review.
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
 * Returns the current widget configuration.
 */
app.get("/api/config", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT value FROM widget_config WHERE key = 'main'"
    );
    if (rows.length === 0) {
      // Return sensible defaults if no config saved yet
      return res.json(defaultConfig());
    }
    res.json(rows[0].value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config
 * Body: { ...configObject }
 * Saves widget config to DB.
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
 * Body: { reviews: Review[] }
 * Calls Claude to select the highest-converting reviews.
 */
app.post("/api/ai-pick", requireAdminKey, async (req, res) => {
  const { reviews } = req.body;
  if (!reviews?.length) {
    return res.status(400).json({ error: "reviews array required" });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a conversion optimization expert for a martial arts / BJJ gym.
Below are Google reviews for the gym. Your job is to select the 3-4 reviews most likely
to convert a curious website visitor into a lead (trial signup or form fill).

Scoring criteria:
- Specific, tangible results (weight loss, competition win, confidence, discipline)
- Emotional transformation story (before/after feeling)
- Relatable author (parent, beginner, older adult, woman — anyone a prospect might identify with)
- Mentions of staff, community, or atmosphere by name or detail
- Length and authenticity — detailed reviews outperform generic praise
- Recency — prefer newer reviews if quality is equal

Reviews:
${reviews.map((r, i) => `[${i + 1}] ${r.author} (${r.rating}★, ${r.date}):\n"${r.text}"`).join("\n\n")}

Respond ONLY with a valid JSON object — no markdown, no preamble:
{
  "picks": [1, 3, 6],
  "reasoning": "One paragraph explaining your selections and what makes them high-converting."
}`;

  try {
    const message = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages:   [{ role: "user", content: prompt }],
    });

    const text   = message.content.map(b => b.text || "").join("");
    const parsed = JSON.parse(text.trim());

    // Save ai_picked state to DB
    // First clear existing AI picks
    await db.query("UPDATE pinned_reviews SET ai_picked = FALSE");

    // Set new picks (1-indexed from Claude → 0-indexed for array)
    for (const pickNum of parsed.picks) {
      const review = reviews[pickNum - 1];
      if (review) {
        await db.query(`
          INSERT INTO pinned_reviews (review_id, ai_picked)
          VALUES ($1, TRUE)
          ON CONFLICT (review_id) DO UPDATE SET ai_picked = TRUE
        `, [review.id]);
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: "AI pick failed: " + err.message });
  }
});

/**
 * GET /widget.js
 * Serves the embeddable widget script.
 * This script is what gym owners paste into their GymDesk site.
 */
app.get("/widget.js", async (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300"); // 5 min cache

  const apiBase = process.env.API_BASE_URL || `https://your-app.up.railway.app`;

  // The widget script is inlined here as a template string.
  // It fetches config + reviews from this server and renders itself.
  res.send(`
(function() {
  const API = "${apiBase}";
  const el  = document.getElementById("reviews-widget");
  if (!el) return;

  async function load() {
    try {
      const [cfgRes, revRes] = await Promise.all([
        fetch(API + "/api/config"),
        fetch(API + "/api/reviews")
      ]);
      const config  = await cfgRes.json();
      const { reviews, overallRating, totalReviews } = await revRes.json();
      render(el, config, reviews, overallRating, totalReviews);
    } catch(e) {
      console.error("Reviews widget failed to load:", e);
    }
  }

  function stars(n) {
    return Array.from({length:5}, (_,i) =>
      '<span style="color:' + (i < n ? "#FBBF24" : "#ddd") + '">★</span>'
    ).join("");
  }

  function render(el, cfg, reviews, overallRating, totalReviews) {
    const isMobile = window.innerWidth < 768;
    const style    = isMobile ? "carousel" : cfg.displayStyle;

    // Filter reviews: prefer pinned + aiPicked, fall back to all above minRating
    let display = reviews.filter(r => r.pinned || r.aiPicked);
    if (display.length === 0) display = reviews.filter(r => r.rating >= (cfg.minRating || 4));
    display = display.slice(0, cfg.maxReviews || 6);

    const wrap = document.createElement("div");
    wrap.style.cssText = "font-family:system-ui,sans-serif;background:" + cfg.bgColor + ";color:" + cfg.textColor + ";border-radius:16px;padding:24px;box-sizing:border-box;";

    // Badge
    if (cfg.showBadge) {
      wrap.innerHTML += \`<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 14px;background:\${cfg.accentColor}11;border-radius:10px;border:1px solid \${cfg.accentColor}33;">
        <span style="font-size:28px;font-weight:800;color:\${cfg.accentColor}">\${overallRating}</span>
        <div>\${stars(Math.round(overallRating))}<div style="font-size:11px;color:#888;margin-top:2px">\${totalReviews} Google Reviews</div></div>
      </div>\`;
    }

    // Cards
    const cards = display.map(r => \`
      <div class="rw-card" style="background:\${cfg.bgColor};border:1px solid \${cfg.accentColor}22;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
          \${cfg.showPhoto && r.avatar ? '<img src="'+r.avatar+'" style="width:36px;height:36px;border-radius:50%;">' : ""}
          <div>
            \${cfg.showName ? '<div style="font-weight:700;font-size:13px">'+r.author+'</div>' : ""}
            \${cfg.showStars ? '<div>'+stars(r.rating)+'</div>' : ""}
          </div>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:\${cfg.textColor}cc">\${r.text}</p>
      </div>
    \`).join("");

    if (style === "carousel") {
      let idx = 0;
      const carouselId = "rw-" + Math.random().toString(36).slice(2);
      wrap.innerHTML += \`<div id="\${carouselId}">\${display.map((r,i) => \`<div class="rw-card" style="display:\${i===0?"block":"none"};background:\${cfg.bgColor};border:1px solid \${cfg.accentColor}22;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
            \${cfg.showPhoto && r.avatar ? '<img src="'+r.avatar+'" style="width:36px;height:36px;border-radius:50%;">' : ""}
            <div>
              \${cfg.showName ? '<div style="font-weight:700;font-size:13px">'+r.author+'</div>' : ""}
              \${cfg.showStars ? '<div>'+stars(r.rating)+'</div>' : ""}
            </div>
          </div>
          <p style="margin:0;font-size:13px;line-height:1.6">\${r.text}</p>
        </div>\`).join("")}
        <div style="display:flex;justify-content:center;gap:8px;margin-top:12px;align-items:center;">
          <button id="\${carouselId}-prev" style="width:28px;height:28px;border-radius:50%;border:1px solid \${cfg.accentColor};background:transparent;color:\${cfg.accentColor};cursor:pointer;font-size:16px">&#8249;</button>
          \${display.map((_,i) => '<div id="'+carouselId+'-dot-'+i+'" style="width:7px;height:7px;border-radius:50%;background:'+(i===0?cfg.accentColor:cfg.accentColor+'44')+';cursor:pointer;display:inline-block"></div>').join("")}
          <button id="\${carouselId}-next" style="width:28px;height:28px;border-radius:50%;border:1px solid \${cfg.accentColor};background:transparent;color:\${cfg.accentColor};cursor:pointer;font-size:16px">&#8250;</button>
        </div>
      </div>\`;

      el.appendChild(wrap);

      const showCard = (n) => {
        idx = (n + display.length) % display.length;
        wrap.querySelectorAll(".rw-card").forEach((c,i) => c.style.display = i===idx?"block":"none");
        display.forEach((_,i) => { const d = document.getElementById(carouselId+"-dot-"+i); if(d) d.style.background = i===idx ? cfg.accentColor : cfg.accentColor+"44"; });
      };
      document.getElementById(carouselId+"-prev")?.addEventListener("click", () => showCard(idx-1));
      document.getElementById(carouselId+"-next")?.addEventListener("click", () => showCard(idx+1));
      display.forEach((_,i) => document.getElementById(carouselId+"-dot-"+i)?.addEventListener("click", () => showCard(i)));

      // Auto-advance every 5s
      setInterval(() => showCard(idx+1), 5000);

    } else if (style === "grid") {
      wrap.innerHTML += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">' + cards + '</div>';
      el.appendChild(wrap);
    } else {
      wrap.innerHTML += '<div style="display:flex;flex-direction:column;gap:10px">' + cards + '</div>';
      el.appendChild(wrap);
    }

    // CTA
    if (cfg.ctaEnabled && cfg.ctaText) {
      const cta = document.createElement("div");
      cta.style.textAlign = "center";
      cta.style.marginTop = "18px";
      cta.innerHTML = '<a href="'+cfg.ctaLink+'" style="display:inline-block;padding:11px 28px;border-radius:8px;background:'+cfg.ctaColor+';color:#fff;font-weight:700;font-size:14px;text-decoration:none">'+cfg.ctaText+'</a>';
      el.appendChild(cta);
    }
  }

  load();
})();
  `.trim());
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultConfig() {
  return {
    accentColor:  "#C41E3A",
    bgColor:      "#ffffff",
    textColor:    "#1a1a1a",
    showStars:    true,
    showPhoto:    true,
    showName:     true,
    showBadge:    true,
    displayStyle: "carousel",
    maxReviews:   6,
    minRating:    4,
    ctaEnabled:   true,
    ctaText:      "Book Your Free Trial",
    ctaLink:      "#",
    ctaColor:     "#C41E3A",
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Reviews Widget API running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});