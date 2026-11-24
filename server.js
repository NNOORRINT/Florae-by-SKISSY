// Planty by Skissy — backend
// Receives a plant photo from the browser, asks Claude to diagnose it,
// and returns a structured report (plant, growth stage, problems, next steps).

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const MODEL = "claude-opus-5-5";

// Supabase project (these two values are public by design; access is controlled by RLS).
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ljzaxeeknesbbskiapua.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_gK62nS81juLpGjHOM2UoRA_vkbzQ8z-";

// Call Supabase as the signed-in user, so all its security rules apply.
function supabaseAs(token, path, init = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

// Returns the signed-in (non-anonymous) user for this request, or null.
async function authenticate(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const r = await supabaseAs(token, "/auth/v1/user");
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  if (!user?.id || user.is_anonymous) return null;
  return { user, token };
}

async function rpc(token, fn) {
  const r = await supabaseAs(token, `/rest/v1/rpc/${fn}`, { method: "POST", body: "{}" });
  if (!r.ok) throw new Error(`Supabase ${fn} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

// Reads ANTHROPIC_API_KEY from the environment. The key stays on the server,
// never in the browser.
const client = new Anthropic();

// ---------- What we want back from the AI ----------
const DiagnosisSchema = z.object({
  is_plant: z.boolean().describe("False if the photo does not clearly show a plant"),
  plant: z.object({
    common_name: z.string(),
    scientific_name: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    description: z.string().describe("One or two sentences about this plant"),
  }),
  growth_stage: z.object({
    stage: z.enum([
      "seed_or_germination",
      "seedling",
      "vegetative",
      "budding",
      "flowering",
      "fruiting",
      "ready_to_harvest",
      "mature",
      "dormant",
      "declining",
      "unknown",
    ]),
    explanation: z.string().describe("What in the photo shows this stage"),
    what_comes_next: z.string().describe("What the grower should expect in the next stage"),
  }),
  health: z.object({
    status: z.enum(["healthy", "minor_issues", "needs_attention", "critical"]),
    summary: z.string(),
  }),
  problems: z.array(
    z.object({
      name: z.string(),
      category: z.enum(["disease", "pest", "nutrient", "watering", "light", "temperature", "physical_damage", "other"]),
      severity: z.enum(["low", "medium", "high"]),
      evidence: z.string().describe("What is visible in the photo that indicates this"),
      likely_cause: z.string(),
    })
  ),
  next_steps: z.array(
    z.object({
      when: z.enum(["today", "this_week", "ongoing"]),
      action: z.string(),
      why: z.string(),
    })
  ),
  care_guide: z.object({
    water: z.string(),
    light: z.string(),
    soil: z.string(),
    fertilizer: z.string(),
  }),
  when_to_get_expert_help: z.string().describe("Empty string if not needed"),
  better_photo_tips: z.string().describe("Empty string if the photo was good enough"),
});

const SYSTEM_PROMPT = `You are Planty, a friendly plant doctor. People photograph a plant and you tell them what it is, what growth stage it is in, whether anything is wrong, and exactly what to do next.

Most of your users are growing their very first plant, so assume no gardening knowledge. Write in short, plain, friendly sentences and lead with what matters most. Look carefully for anything unusual in the photo (spots, discoloured or curled leaves, wilting, pests, mould, damage) and list each one as a problem. Keep next steps to the 3–5 that matter most. When you must use a technical term (for example "chlorosis" or "aphids"), explain it in a few words. Make every next step concrete and doable with things a normal person or small farm has: say how much, how often, and how to tell whether it worked.

Base the diagnosis on what is actually visible. If the photo is blurry, too far away, or only shows part of the plant, say so in better_photo_tips, lower your confidence, and give the most likely possibilities instead of guessing with false certainty. If the plant looks healthy, say so and leave problems empty; do not invent issues. Prefer safe, low-cost remedies first (removing affected leaves, adjusting watering, neem oil, soap spray) before chemical pesticides; when you do mention a chemical, tell the user to follow the label and use protective gear. If the photo is not a plant, set is_plant to false and fill the other fields briefly.`;

// ---------- Server ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use(express.static("public"));

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

app.post("/api/diagnose", async (req, res) => {
  const { image, mediaType, notes } = req.body ?? {};

  if (typeof image !== "string" || !ALLOWED_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: "Please send a JPEG, PNG, WebP or GIF photo." });
  }
  if (image.length > 10_000_000) {
    return res.status(413).json({ error: "That photo is too large. Please try a smaller one." });
  }

  // Only signed-in users with checks left today may use the AI.
  let auth;
  try {
    auth = await authenticate(req);
  } catch (err) {
    console.error("Auth check failed:", err);
    return res.status(503).json({ error: "Could not verify your account. Please try again." });
  }
  if (!auth) return res.status(401).json({ error: "Please sign in to check your plant." });

  try {
    const left = await rpc(auth.token, "scan_quota");
    if (left <= 0) {
      return res.status(429).json({
        error: "You've used all of today's free checks. Come back tomorrow!",
        remaining: 0,
      });
    }
  } catch (err) {
    console.error(err.message, "\n→ Did you run supabase/002_accounts.sql?");
    return res.status(503).json({ error: "Planty is being set up. Please try again soon." });
  }

  const userText =
    "Please diagnose this plant." +
    (notes && typeof notes === "string" && notes.trim()
      ? `\n\nExtra information from the grower: ${notes.trim().slice(0, 1000)}`
      : "");

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: betaZodOutputFormat(DiagnosisSchema),
      },
      // If the main model declines, Anthropic retries on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: userText },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI could not analyse this photo. Please try a different photo." });
    }
    if (!response.parsed_output) {
      return res.status(502).json({ error: "The AI returned an incomplete answer. Please try again." });
    }

    let remaining = null;
    try {
      remaining = await rpc(auth.token, "record_scan");
    } catch (err) {
      console.error(err.message);
    }

    res.json({ result: response.parsed_output, remaining });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Invalid or missing ANTHROPIC_API_KEY");
      return res.status(500).json({ error: "Server is not configured with a valid API key." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Too many requests right now. Please wait a moment and try again." });
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("Bad request:", err.message);
      return res.status(400).json({ error: "The photo could not be processed. Try a smaller or different photo." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(503).json({ error: "Could not reach the AI service. Check the internet connection." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// On Vercel the app is exported and run as a serverless function
// (files in public/ are served by Vercel's CDN). Locally we start a server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🌱 Planty is running at http://localhost:${PORT}`);
  });
}

export default app;
