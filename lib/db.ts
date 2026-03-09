import pg from "pg";
import type { WidgetConfig } from "./types.js";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || dbUrl.includes("user:password@host")) {
  console.error("❌ DATABASE_URL is missing or still set to the placeholder value.");
  console.error("   Set the real DATABASE_URL in your Railway environment variables.");
  process.exit(1);
}

export const db = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

export async function initDB(): Promise<void> {
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

    CREATE TABLE IF NOT EXISTS review_cache (
      id             SERIAL PRIMARY KEY,
      reviews        JSONB NOT NULL,
      overall_rating NUMERIC,
      total_reviews  INTEGER,
      source         TEXT NOT NULL DEFAULT 'outscraper',
      fetched_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS review_cache_backup (
      id             SERIAL PRIMARY KEY,
      reviews        JSONB NOT NULL,
      overall_rating NUMERIC,
      total_reviews  INTEGER,
      source         TEXT NOT NULL DEFAULT 'outscraper',
      fetched_at     TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS refresh_log (
      id            SERIAL PRIMARY KEY,
      success       BOOLEAN NOT NULL,
      error_message TEXT,
      source        TEXT,
      review_count  INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database tables ready");
}

export function defaultConfig(): WidgetConfig {
  return {
    accentColor:     "#C41E3A",
    bgColor:         "#ffffff",
    textColor:       "#1a1a1a",
    showStars:       true,
    showPhoto:       true,
    showName:        true,
    showBadge:       true,
    displayStyle:    "carousel",
    maxReviews:      6,
    minRating:       4,
    ctaEnabled:      true,
    ctaText:         "Book Your Free Trial",
    ctaLink:         "#",
    ctaColor:        "#C41E3A",
    reviewSource:    "google",
    refreshSchedule: "manual",
    autoAiPick:      false,
    showSectionTitle: true,
    sectionTitle:    "What Our Members Say About Us",
    reviewMaxChars:  250,
    showMoreButton:  false,
  };
}
