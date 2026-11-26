// Imports plant profiles into Supabase from GBIF, Wikidata, Wikipedia, Wikimedia Commons
// and (with a token) Trefle. Safe to re-run: records are matched by GBIF / Wikidata / Trefle
// ids, then by accepted name and synonyms, so nothing is duplicated, and anything a reviewer
// marked "reviewed" or locked is left as it is.
//
//   node --env-file=.env scripts/import-wiki.mjs                 import data/wiki-plants.txt (resumes if interrupted)
//   node --env-file=.env scripts/import-wiki.mjs --fresh         start the list from the top again
//   node --env-file=.env scripts/import-wiki.mjs --only "Aloe vera"
//   node --env-file=.env scripts/import-wiki.mjs --draft         new plants start as drafts (default: published)
//   node scripts/import-wiki.mjs --dry-run --out plants.json     fetch and validate only; writes nothing to the database
//
// Environment (.env, never committed; see .env.example):
//   SUPABASE_URL           your project URL (defaults to the one in public/config.js)
//   SUPABASE_SERVICE_KEY   Supabase → Project Settings → API Keys → secret key. Server-side only.
//   WIKI_USER_AGENT        "AppName/1.0 (https://your-site; contact@your-domain)", required by Wikimedia's API policy
//   TREFLE_TOKEN           optional, from https://trefle.io/profile

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildEntry } from "../public/wiki-source.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ljzaxeeknesbbskiapua.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const UA = process.env.WIKI_USER_AGENT;
const TREFLE = process.env.TREFLE_TOKEN || null;
const LIST = new URL("../data/wiki-plants.txt", import.meta.url);
const CHECKPOINT = new URL("../data/.import-checkpoint.json", import.meta.url);
const BATCH = 10;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flag = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);
const only = flag("--only");
const out = flag("--out");
const dryRun = has("--dry-run") || !!out;
const status = has("--draft") ? "draft" : "published";

if (!dryRun && !KEY) fail("SUPABASE_SERVICE_KEY is not set. Add it to .env, or use --dry-run.");
if (KEY && /^sb_publishable_/.test(KEY)) fail("SUPABASE_SERVICE_KEY is the publishable key. Use the secret key.");
if (!UA) fail('WIKI_USER_AGENT is not set, e.g. WIKI_USER_AGENT="FloraeIndex/1.0 (https://your-site; you@your-domain)"');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- Validation of what we're about to store ----------
const httpsUrl = z.string().url().startsWith("https://");
const Record = z.object({
  plant: z.object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    scientific_name: z.string().min(2).max(200),
    authorship: z.string().max(300).nullable(),
    rank: z.string().max(40).nullable(),
    kingdom: z.string().nullable(),
    plant_order: z.string().nullable(),
    family: z.string().nullable(),
    genus: z.string().nullable(),
    common_name: z.string().min(1).max(200),
    collection: z.string().nullable(),
    description: z.string().max(300).nullable(),
  }),
  names: z.array(z.object({ name: z.string().min(1).max(200), kind: z.enum(["accepted", "synonym", "common"]), source: z.string() })).min(1),
  external_ids: z.array(z.object({ source: z.enum(["gbif", "wikidata", "wikipedia", "trefle", "ncbi", "powo", "inaturalist"]), external_id: z.string().min(1), url: httpsUrl.nullable() })),
  content: z.array(
    z.object({
      field: z.enum(["overview", "description", "habitat", "distribution", "taxonomy", "light", "watering", "soil", "humidity", "temperature", "propagation", "toxicity", "section"]),
      section_key: z.string(),
      title: z.string().nullable(),
      body: z.string().max(20000),
      data: z.any(),
      position: z.number().int(),
      source: z.enum(["wikipedia", "gbif", "wikidata", "trefle"]),
      source_url: httpsUrl.nullable(),
      source_record_id: z.string().nullable(),
      license: z.string().min(1),
      license_url: httpsUrl,
      attribution: z.string().min(1),
      retrieved_at: z.string(),
    })
  ),
  images: z.array(
    z.object({
      source: z.literal("commons"), source_id: z.string().min(1), url: httpsUrl, thumb_url: httpsUrl.nullable(),
      page_url: httpsUrl.nullable(), creator: z.string().nullable(), license: z.string().min(1),
      license_url: httpsUrl.nullable(), attribution: z.string(),
    })
  ),
  warnings: z.array(z.string()),
});

// ---------- Supabase (service key, server-side only) ----------
async function supa(path, init = {}) {
  const headers = { apikey: KEY, "Content-Type": "application/json", ...init.headers };
  if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`; // legacy service_role JWT
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
    if (res.ok) return res.status === 204 ? null : res.json();
    const text = await res.text();
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  }
}
const rpc = (fn, body) => supa(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });
const insert = (table, row) => supa(`/rest/v1/${table}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
const patch = (table, id, row) => supa(`/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row) });

// ---------- The list and the checkpoint ----------
async function readList() {
  const items = [];
  let collection = null;
  for (const raw of (await readFile(LIST, "utf8")).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) collection = line.replace(/^#+\s*/, "") || null;
    else items.push({ name: line, collection });
  }
  return items;
}

async function loadCheckpoint(listHash) {
  if (has("--fresh") || only || dryRun) return new Set();
  try {
    const cp = JSON.parse(await readFile(CHECKPOINT, "utf8"));
    return cp.list === listHash ? new Set(cp.done) : new Set();
  } catch {
    return new Set();
  }
}
const saveCheckpoint = (listHash, done) =>
  mkdir(new URL("./", CHECKPOINT), { recursive: true }).then(() => writeFile(CHECKPOINT, JSON.stringify({ list: listHash, done: [...done] }, null, 1)));

// ---------- Run ----------
const all = await readList();
const list = only ? [{ name: only, collection: all.find((i) => i.name === only)?.collection ?? null }] : all;
const listHash = createHash("sha1").update(JSON.stringify(list)).digest("hex").slice(0, 12);
const done = await loadCheckpoint(listHash);
const todo = list.filter((i) => !done.has(i.name));
const sources = ["gbif", "wikidata", "wikipedia", "commons", ...(TREFLE ? ["trefle"] : [])];

console.log(`${dryRun ? "Dry run: " : ""}${todo.length} to import${done.size ? ` (${done.size} already done, resuming)` : ""}. Sources: ${sources.join(", ")}.`);
if (!TREFLE) console.log("TREFLE_TOKEN not set: care indicators from Trefle are skipped.");

const run = dryRun ? null : (await insert("wiki_import_runs", { sources, total: todo.length }))[0];
const tally = { created: 0, updated: 0, failed: 0, preserved: 0, noPhoto: 0, noArticle: 0, conflicts: 0 };
const failures = [];
const records = [];
const seenSlugs = new Map();

async function importOne(item, n) {
  const tag = `[${n}/${todo.length}] ${item.name}`;
  let stage = "fetch";
  try {
    const raw = await buildEntry(item.name, { userAgent: UA, collection: item.collection, trefleToken: TREFLE });
    if (!raw) throw new Error("not found as a plant on GBIF, and no Wikipedia article");
    stage = "validate";
    const rec = Record.parse(raw);
    if (seenSlugs.has(rec.plant.slug)) throw new Error(`same accepted name as "${seenSlugs.get(rec.plant.slug)}" (${rec.plant.scientific_name})`);
    seenSlugs.set(rec.plant.slug, item.name);
    if (!rec.images.length) tally.noPhoto++;
    if (!rec.content.some((c) => c.source === "wikipedia")) tally.noArticle++;

    let note = "";
    if (dryRun) records.push(rec);
    else {
      stage = "store";
      const { warnings, ...payload } = rec;
      const res = await rpc("wiki_import_plant", { p: payload, p_status: status });
      tally[res.action === "created" ? "created" : "updated"]++;
      tally.preserved += res.preserved || 0;
      if (res.id_conflicts?.length) {
        tally.conflicts++;
        note += `  id conflict: ${JSON.stringify(res.id_conflicts)}`;
      }
      if (res.preserved) note += `  kept ${res.preserved} reviewed row(s)`;
      note = `${res.action}${note}`;
    }
    const synonymNote = rec.plant.scientific_name !== item.name ? `  (accepted name: ${rec.plant.scientific_name})` : "";
    console.log(`${tag} → ${rec.plant.common_name}${synonymNote}  ${note}${rec.warnings.length ? `  warnings: ${rec.warnings.join("; ")}` : ""}`);
    done.add(item.name);
  } catch (err) {
    tally.failed++;
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message;
    failures.push({ input_name: item.name, stage, error: msg.slice(0, 1000) });
    console.warn(`${tag} FAILED at ${stage}: ${msg}`);
    if (run) await insert("wiki_import_failures", { run_id: run.id, input_name: item.name, stage, error: msg.slice(0, 1000) }).catch(() => {});
  }
}

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  for (const [j, item] of batch.entries()) await importOne(item, i + j + 1);
  if (!dryRun) await saveCheckpoint(listHash, done);
}

const summary = { ...tally, total: todo.length, status, failures: failures.map((f) => f.input_name) };
if (run) {
  await patch("wiki_import_runs", run.id, {
    finished_at: new Date().toISOString(),
    status: tally.failed === 0 ? "completed" : tally.failed === todo.length ? "failed" : "partial",
    created: tally.created, updated: tally.updated, failed: tally.failed, preserved: tally.preserved, summary,
  });
}
if (out) await writeFile(out, JSON.stringify(records, null, 1));

console.log(`
Summary${dryRun ? " (dry run, nothing stored)" : ""}
  processed   ${todo.length}
  created     ${tally.created}
  updated     ${tally.updated}
  failed      ${tally.failed}${failures.length ? `  (${failures.map((f) => f.input_name).join(", ")})` : ""}
  kept as reviewed  ${tally.preserved}
  without a free photo  ${tally.noPhoto}
  without a Wikipedia article  ${tally.noArticle}${out ? `\n  written to ${out}` : ""}${run ? `\n  run id ${run.id}` : ""}`);
if (!dryRun && tally.failed === 0 && !only) await saveCheckpoint(listHash, new Set()); // finished: next run starts fresh
process.exit(tally.failed && tally.failed === todo.length ? 1 : 0);
