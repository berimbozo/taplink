import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db.js";

/**
 * Runs Claude AI pick on the provided reviews array.
 * Saves ai_picked state to DB and returns { picks, reasoning }.
 */
export async function runAiPick(reviews) {
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

  const message = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages:   [{ role: "user", content: prompt }],
  });

  const text   = message.content.map(b => b.text || "").join("");
  const parsed = JSON.parse(text.trim());

  // Clear existing AI picks then set new ones
  await db.query("UPDATE pinned_reviews SET ai_picked = FALSE");
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

  return parsed;
}
