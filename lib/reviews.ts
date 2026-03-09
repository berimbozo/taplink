import fetch from "node-fetch";
import { db } from "./db.js";
import type { Review, CacheEntry, RefreshResult } from "./types.js";

/**
 * Fetches up to 5 reviews from Google Places API for a given Place ID.
 * Note: The free Places API returns max 5 reviews. For more, use Outscraper.
 */
export async function fetchGoogleReviews(): Promise<{ reviews: Review[]; overallRating: number; totalReviews: number }> {
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
  const data = await res.json() as {
    status: string;
    error_message?: string;
    result: {
      rating: number;
      user_ratings_total: number;
      reviews: Array<{
        time: number;
        author_name: string;
        profile_photo_url?: string;
        rating: number;
        text: string;
      }>;
    };
  };

  if (data.status !== "OK") {
    throw new Error(`Google Places API error: ${data.status} — ${data.error_message || ""}`);
  }

  const place   = data.result;
  const reviews: Review[] = (place.reviews || []).map(r => ({
    id:       r.time.toString(),
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

/**
 * Fetches all reviews from Outscraper for a given Place ID.
 * Requires OUTSCRAPER_API_KEY env var.
 * OUTSCRAPER_MAX_REVIEWS controls the cap (default 300).
 */
export async function fetchOutscraperReviews(): Promise<{ reviews: Review[]; overallRating: number; totalReviews: number }> {
  const apiKey  = process.env.OUTSCRAPER_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;
  const limit   = parseInt(process.env.OUTSCRAPER_MAX_REVIEWS || "300", 10);

  if (!apiKey)  throw new Error("OUTSCRAPER_API_KEY is not set");
  if (!placeId) throw new Error("GOOGLE_PLACE_ID is not set");

  const url = new URL("https://api.app.outscraper.com/maps/reviews-v3");
  url.searchParams.set("query", placeId);
  url.searchParams.set("reviewsLimit", String(limit));
  url.searchParams.set("sort", "newest");
  url.searchParams.set("async", "false");

  const res = await fetch(url.toString(), {
    headers: { "X-API-KEY": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Outscraper API error ${res.status}: ${text}`);
  }

  const body = await res.json() as { data?: unknown[] } | unknown[];
  const place = ((Array.isArray(body) ? body : (body as { data?: unknown[] }).data) ?? [])[0] as {
    rating: number;
    reviews: number;
    reviews_data: Array<{
      review_id?: string;
      review_datetime_utc?: string;
      author_title: string;
      author_image?: string;
      review_rating: number;
      review_text?: string;
    }>;
  } | undefined;

  if (!place) throw new Error("No data returned from Outscraper");

  const reviews: Review[] = (place.reviews_data || []).map(r => ({
    id:       r.review_id || String(r.review_datetime_utc),
    author:   r.author_title,
    avatar:   r.author_image || null,
    rating:   r.review_rating,
    date:     r.review_datetime_utc
                ? r.review_datetime_utc.split(" ")[0]
                : "",
    text:     r.review_text || "",
    pinned:   false,
    aiPicked: false,
  }));

  return {
    reviews,
    overallRating: place.rating,
    totalReviews:  place.reviews,
  };
}

export async function getCache(): Promise<CacheEntry | null> {
  const { rows } = await db.query<{
    reviews: Review[];
    overall_rating: number;
    total_reviews: number;
    source: string;
    fetched_at: Date;
  }>("SELECT * FROM review_cache ORDER BY fetched_at DESC LIMIT 1");

  if (!rows.length) return null;
  const row = rows[0];
  return {
    reviews:       row.reviews,
    overallRating: row.overall_rating,
    totalReviews:  row.total_reviews,
    source:        row.source,
    fetchedAt:     row.fetched_at,
  };
}

/**
 * Fetches fresh reviews from Outscraper, backs up the current cache,
 * and saves the new data. On failure the existing cache is preserved.
 */
export async function runRefresh(): Promise<RefreshResult> {
  // Fetch first — only touch the DB if the fetch succeeds
  const { reviews, overallRating, totalReviews } = await fetchOutscraperReviews();

  // Backup existing cache (keep exactly 1 previous snapshot)
  const current = await getCache();
  if (current) {
    await db.query("DELETE FROM review_cache_backup");
    await db.query(
      `INSERT INTO review_cache_backup
         (reviews, overall_rating, total_reviews, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [JSON.stringify(current.reviews), current.overallRating,
       current.totalReviews, current.source, current.fetchedAt]
    );
  }

  // Replace cache
  await db.query("DELETE FROM review_cache");
  await db.query(
    `INSERT INTO review_cache (reviews, overall_rating, total_reviews, source)
     VALUES ($1, $2, $3, 'outscraper')`,
    [JSON.stringify(reviews), overallRating, totalReviews]
  );

  // Log success
  await db.query(
    "INSERT INTO refresh_log (success, source, review_count) VALUES (TRUE, 'outscraper', $1)",
    [reviews.length]
  );

  console.log(`✅ Outscraper refresh complete: ${reviews.length} reviews cached`);
  return { reviewCount: reviews.length };
}
