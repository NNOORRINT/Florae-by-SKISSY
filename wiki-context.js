// Connects a photo diagnosis to the plant wiki.
//  * Tools Claude can call while diagnosing: look up stored plant profiles and reviewed
//    health articles. Calls run as the signed-in user, so only published content is visible.
//  * Every fact handed to Claude gets a reference id; facts Claude cites are checked against
//    those ids and carry their source, licence and review status back to the browser.
//  * Which wiki page a result links to is decided here, from the database, not by the model.
import { z } from "zod";
import { gbifAcceptedKey, speciesName, slugify } from "./public/wiki-source.js";

const CARE_FIELDS = ["overview", "light", "watering", "soil", "humidity", "temperature", "propagation", "toxicity", "distribution", "habitat"];
const USEFUL_SECTION = /cultivation|care|propagat|pest|disease|toxic|growing|description|habitat|distribution/i;
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || "");

export const WIKI_TOOLS = [
  {
    name: "lookup_plants",
    description:
      "Look up stored plant profiles in Florae's wiki by scientific name, synonym or common name. Call it with your best identification and up to four alternatives before writing the answer. Returns sourced facts (each with a ref id), or nothing for plants that are not stored. Absence means 'not in the wiki', not 'not a real plant'.",
    input_schema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Scientific names first, then common names" } },
      required: ["names"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "find_health_articles",
    description:
      "Find reviewed health articles in Florae's wiki about symptoms you see (e.g. 'yellow lower leaves', 'white powdery coating'). Call it when you see a possible problem. Only human-reviewed, published articles are returned. Returns an empty list when there is none.",
    input_schema: {
      type: "object",
      properties: {
        symptoms: { type: "array", items: { type: "string" }, maxItems: 8 },
        categories: {
          type: "array",
          items: { type: "string", enum: ["disease", "pest", "nutrient", "watering", "light", "temperature", "physical_damage", "other"] },
          maxItems: 8,
        },
        plant_slug: { type: ["string", "null"], description: "slug from lookup_plants, or null" },
      },
      required: ["symptoms", "categories", "plant_slug"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const LookupInput = z.object({ names: z.array(z.string().min(1).max(200)).min(1).max(5) });
const HealthInput = z.object({
  symptoms: z.array(z.string().max(200)).max(8),
  categories: z.array(z.string()).max(8),
  plant_slug: z.string().max(120).nullable(),
});

/** One context per request: talks to Supabase as the user and remembers every ref it handed out. */
export function createWikiContext(callRpc) {
  const refs = new Map(); // ref -> source metadata shown with a cited fact
  const plantsBySlug = new Map();
  const gbifKeys = new Map(); // name -> accepted GBIF key

  async function keysFor(names) {
    const out = [];
    await Promise.all(
      names.slice(0, 3).map(async (n) => {
        const sp = speciesName(n);
        if (!sp || !/^[A-Z]/.test(sp)) return;
        if (!gbifKeys.has(sp)) gbifKeys.set(sp, await gbifAcceptedKey(sp).catch(() => null));
        const k = gbifKeys.get(sp);
        if (k) out.push(k.key);
      })
    );
    return out;
  }

  async function resolve(names) {
    const clean = [...new Set(names.flatMap((n) => [n, speciesName(n)]).filter(Boolean))];
    const keys = await keysFor(names);
    const rows = await callRpc("wiki_resolve", { p_names: clean, p_gbif_keys: keys });
    return { rows: Array.isArray(rows) ? rows : [], keys };
  }

  async function plant(slug) {
    if (!plantsBySlug.has(slug)) plantsBySlug.set(slug, await callRpc("wiki_plant", { p_slug: slug }));
    return plantsBySlug.get(slug);
  }

  async function lookupPlants(input) {
    const { rows } = await resolve(input.names);
    const slugs = [...new Set(rows.map((r) => r.slug))].slice(0, 4);
    const result = [];
    for (const slug of slugs) {
      const rec = await plant(slug);
      if (!rec?.plant) continue;
      const facts = (rec.content || [])
        .filter((c) => c.status === "published")
        .filter((c) => CARE_FIELDS.includes(c.field) || (c.field === "section" && USEFUL_SECTION.test(c.title || "")))
        .slice(0, 14)
        .map((c) => {
          const ref = `P-${c.id.slice(0, 8)}`;
          refs.set(ref, {
            kind: "plant",
            plant_slug: slug,
            label: c.title || c.field,
            source: c.source,
            source_url: c.source_url,
            license: c.license,
            attribution: c.attribution,
            reviewed: c.review_status === "reviewed",
            origin: c.origin,
          });
          return { ref, topic: c.title || c.field, text: clip(c.body, 1200), source: c.source, reviewed_by_florae: c.review_status === "reviewed" };
        });
      result.push({
        slug,
        scientific_name: rec.plant.scientific_name,
        common_name: rec.plant.common_name,
        family: rec.plant.family,
        matched_by: rows.filter((r) => r.slug === slug).map((r) => `${r.match_kind}: ${r.matched_name}`),
        facts,
      });
    }
    return { plants: result, note: result.length ? undefined : "None of these names are stored in the wiki." };
  }

  async function findHealth(input) {
    let plantId = null;
    if (input.plant_slug) plantId = (await plant(input.plant_slug))?.plant?.id || null;
    const rows = await callRpc("wiki_health_lookup", { p_terms: input.symptoms, p_categories: input.categories, p_plant: plantId });
    return {
      articles: (Array.isArray(rows) ? rows : []).map((a) => {
        const ref = `H-${a.id.slice(0, 8)}`;
        refs.set(ref, {
          kind: "health",
          article_slug: a.slug,
          label: a.title,
          source: "planty",
          sources: a.sources,
          reviewed: true,
          last_reviewed_at: a.last_reviewed_at,
        });
        return { ref, title: a.title, summary: a.summary, text: clip(a.body, 2500), cited_sources: a.sources };
      }),
    };
  }

  async function runTool(name, input) {
    if (name === "lookup_plants") return lookupPlants(LookupInput.parse(input));
    if (name === "find_health_articles") return findHealth(HealthInput.parse(input));
    throw new Error(`unknown tool ${name}`);
  }

  /** Keep only facts whose ref was actually handed out, and attach their source. */
  function checkFacts(facts) {
    const kept = [];
    const dropped = [];
    for (const f of facts || []) {
      const meta = refs.get(f.ref);
      if (meta) kept.push({ ...f, ...meta });
      else dropped.push(f);
    }
    return { kept, dropped };
  }

  /** Decide which stored plant (if any) the result links to. */
  async function match(result) {
    const top = result.plant?.scientific_name;
    if (!result.is_plant || !top) return { status: "none", plant: null, candidates: [] };
    const alts = (result.plant.alternatives || []).map((a) => a.scientific_name).filter(Boolean);
    let rows = [];
    let keys = [];
    try {
      ({ rows, keys } = await resolve([top, ...alts]));
    } catch (err) {
      console.error("wiki match failed:", err.message);
    }
    const topNames = new Set([top, speciesName(top)].map((s) => s.toLowerCase()));
    const topKey = gbifKeys.get(speciesName(top))?.key;
    const topRows = rows.filter((r) => topNames.has(String(r.input).toLowerCase()) || (topKey && r.input === topKey));
    const topSlugs = [...new Set(topRows.map((r) => r.slug))];

    const candidateFor = (name, why) => {
      const r = rows.find((x) => String(x.input).toLowerCase() === name.toLowerCase() || String(x.input).toLowerCase() === speciesName(name).toLowerCase());
      return r
        ? { slug: r.slug, scientific_name: r.scientific_name, common_name: r.common_name, stored: true, why }
        : { slug: slugify(speciesName(name)), scientific_name: speciesName(name), common_name: null, stored: false, why };
    };
    const candidates = [
      candidateFor(top, null),
      ...(result.plant.alternatives || []).map((a) => ({ ...candidateFor(a.scientific_name, a.why), common_name: candidateFor(a.scientific_name).common_name || a.common_name })),
    ].filter((c, i, arr) => c.slug && arr.findIndex((x) => x.slug === c.slug) === i);

    const confident = result.plant.confidence === "high" || (result.plant.confidence === "medium" && !alts.length);
    if (topSlugs.length === 1 && confident) {
      const r = topRows.find((x) => x.slug === topSlugs[0]);
      return {
        status: "matched",
        plant: { slug: r.slug, scientific_name: r.scientific_name, common_name: r.common_name, match_kind: r.match_kind, matched_name: r.matched_name },
        candidates: [],
        gbif_keys: keys,
      };
    }
    if (!confident || topSlugs.length > 1) return { status: "uncertain", plant: null, candidates: candidates.slice(0, 5), gbif_keys: keys };
    return { status: "not_stored", plant: null, candidates: candidates.slice(0, 1), gbif_keys: keys };
  }

  return { runTool, checkFacts, match, refs };
}
