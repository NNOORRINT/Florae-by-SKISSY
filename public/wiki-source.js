// Builds plant records from open data. Runs in the browser (live look-ups for plants that
// aren't stored yet) and in Node (scripts/import-wiki.mjs, which stores them).
//
//   Source                    What we take                                   Licence
//   GBIF Backbone Taxonomy    accepted name, synonyms, classification, names CC BY 4.0
//   Wikidata                  common names, identifiers in other databases   CC0
//   English Wikipedia         article text (lead and sections)               CC BY-SA 4.0
//   Wikimedia Commons         one photo, only if its file licence is free    per file
//   Trefle (Node only, token) habitat indicators, temperature, sowing, ...  CC BY 4.0 (+ upstream)
//
// Every content row carries its own source, URL, licence, attribution and retrieval date.
// Nothing is filled in when a source doesn't say it.

const GBIF = "https://api.gbif.org/v1";
const WIKI = "https://en.wikipedia.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const TREFLE = "https://trefle.io/api/v1";
const PLANTAE = 6; // GBIF key for the plant kingdom

const LICENSES = {
  wikipedia: { license: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  gbif: { license: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0/" },
  wikidata: { license: "CC0 1.0", license_url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  trefle: { license: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0/" },
};

const SKIP_SECTIONS = /^(references|external links|see also|further reading|notes|bibliography|gallery|citations|sources|literature cited|footnotes|works cited|explanatory notes|images)$/i;
const FREE_LICENSE = /^(cc[ -]?by|cc[ -]?by[ -]?sa|cc0|cc[ -]zero|public domain|pd\b|pd-|gfdl|fal|attribution|no restrictions)/i;
// Wikipedia section titles that map onto a profile field.
const SECTION_FIELDS = [
  [/^description$/i, "description"],
  [/^(distribution|range)$/i, "distribution"],
  [/^(habitat|ecology and habitat)$/i, "habitat"],
  [/^distribution and habitat$|^habitat and distribution$/i, "distribution"],
  [/^propagation$/i, "propagation"],
  [/^tox(icity|ins)$/i, "toxicity"],
];

// ---------- Names ----------
// Must match public.wiki_norm() in supabase/003_wiki.sql.
export function normName(s) {
  const from = "áàâäãåéèêëíìîïóòôöõúùûüñç×";
  const to = "aaaaaaeeeeiiiiooooouuuuncx";
  return [...String(s || "").toLowerCase()]
    .map((c) => (from.includes(c) ? to[from.indexOf(c)] : c))
    .join("")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const slugify = (name) => normName(name).replace(/ /g, "-").slice(0, 120);

// "Monstera deliciosa var. borsigiana" -> "Monstera deliciosa"; "Monstera sp." -> "Monstera";
// "Fragaria × ananassa" -> "Fragaria × ananassa"
export function speciesName(scientific) {
  const words = String(scientific || "")
    .replace(/\(.*?\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^(sp|spp|cf|aff)\.?$/i.test(w));
  if (!words.length) return "";
  if (/^[×x]$/.test(words[1] || "") && words[2]) return `${words[0]} × ${words[2]}`;
  if (words[1] && /^[a-z-]+$/.test(words[1])) return `${words[0]} ${words[1]}`;
  return words[0];
}

export function nameFromSlug(slug) {
  const parts = String(slug || "").split("-").filter(Boolean);
  if (parts[1] === "x" && parts[2]) parts[1] = "×";
  const s = parts.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- HTTP with retries, backoff and per-host spacing ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCall = new Map();
const SPACING = { "trefle.io": 1100, "en.wikipedia.org": 250, "commons.wikimedia.org": 250, "www.wikidata.org": 250, "api.gbif.org": 100 };

async function getJson(url, headers, tries = 4) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const gap = (SPACING[host] || 0) - (Date.now() - (lastCall.get(host) || 0));
    if (gap > 0) await sleep(gap);
    lastCall.set(host, Date.now());
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= tries - 1) throw new Error(`${host} unreachable: ${err.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const body = await res.text();
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`${host} returned something that isn't JSON`);
      }
    }
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt >= tries - 1) throw new Error(`${res.status} from ${host}`);
    const wait = Number(res.headers.get("retry-after")) || 0;
    await sleep(Math.max(wait * 1000, 2000 * 2 ** attempt));
  }
}

const qs = (params) => new URLSearchParams(params).toString();

// Tiny response checks: fail loudly on an unexpected shape instead of storing junk.
function expect(cond, what) {
  if (!cond) throw new Error(`unexpected response: ${what}`);
}
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cleanUrl = (u) => (u ? String(u).replace(/[?#].*$/, "") : null);

// ---------- Wikipedia text ----------
// Split TextExtracts plain text ("== Heading ==") into a lead and sections.
export function splitSections(text) {
  const lines = String(text || "").split("\n");
  const lead = [];
  const sections = [];
  let current = null;
  for (const raw of lines) {
    const m = raw.match(/^(={2,4})\s*(.+?)\s*\1\s*$/);
    if (m) {
      current = { title: m[2], level: m[1].length, text: "" };
      sections.push(current);
      continue;
    }
    if (current) current.text += raw + "\n";
    else lead.push(raw);
  }
  const out = [];
  let skipping = false;
  for (const s of sections) {
    if (s.level === 2) skipping = SKIP_SECTIONS.test(s.title);
    if (skipping) continue;
    s.text = s.text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
    out.push(s);
  }
  const kept = out.filter((s, i) => s.text || (out[i + 1] && out[i + 1].level > s.level));
  return { summary: lead.join("\n").replace(/\n{3,}/g, "\n\n").trim(), sections: kept };
}

// Wikipedia leads usually name the plant: "Chlorophytum comosum, usually called spider plant or ...",
// "It is most commonly known as the snake plant, ...", "Its common names include ZZ plant, ...".
const NAME_TRIGGER = /(?:(?:known|called|referred to) as|(?:usually|commonly|often|also|popularly) called|common names? (?:include|includes|are|is))\s+(?:the |an? )?/gi;
const NAME_AT = /^([A-Za-z][A-Za-z'’ -]{1,40}?)(?=\s*(?:[,;.:()]| or | and | is | are | due | in | for | because )|$)/;
const NOT_A_NAME = /^(species|genus|family|plant|perennial|flowering|herbaceous|evergreen|member|type|native|common|single|popular|usually|commonly|also|often|widely|sometimes|known|called|is|was|formerly|previously|synonym|syn)\b/i;

export function leadCommonName(summary, scientific = "") {
  const head = String(summary || "").slice(0, 700);
  const starts = [];
  const sci = String(scientific).toLowerCase();
  if (sci && head.toLowerCase().startsWith(sci)) {
    const opening = head.slice(sci.length).match(/^(?: \([^)]*\))?,\s+(?:the |an? )?/);
    if (opening) starts.push(sci.length + opening[0].length);
  }
  NAME_TRIGGER.lastIndex = 0;
  for (let m; (m = NAME_TRIGGER.exec(head)); ) starts.push(m.index + m[0].length);
  for (const at of starts) {
    const name = head.slice(at).match(NAME_AT)?.[1]?.trim();
    if (!name || name.split(/\s+/).length > 4 || NOT_A_NAME.test(name)) continue;
    if (sci && name.toLowerCase() === sci) continue;
    return sentenceCase(name);
  }
  return null;
}

// ---------- Sources ----------
async function gbifTaxon(name) {
  const m = await getJson(`${GBIF}/species/match?${qs({ name, kingdom: "Plantae", verbose: "false" })}`);
  expect(m && typeof m === "object", "GBIF match");
  if (!m.usageKey || m.matchType === "NONE" || m.kingdom !== "Plantae") return null;
  // A synonym points at the accepted name; we store the accepted one.
  const key = m.acceptedUsageKey || m.usageKey;
  const t = m.acceptedUsageKey ? await getJson(`${GBIF}/species/${key}`) : m;
  expect(t && (t.canonicalName || m.canonicalName), "GBIF taxon without a name");
  return {
    key: String(key),
    canonical: t.canonicalName || m.canonicalName,
    authorship: str(t.authorship) || null,
    rank: (t.rank || m.rank || "").toLowerCase() || null,
    kingdom: t.kingdom || "Plantae",
    order: t.order || null,
    family: t.family || null,
    genus: t.genus || null,
    matchedAsSynonym: m.acceptedUsageKey ? m.canonicalName : null,
    confidence: m.confidence ?? null,
  };
}

async function gbifSynonyms(key) {
  const data = await getJson(`${GBIF}/species/${key}/synonyms?limit=100`);
  expect(Array.isArray(data?.results), "GBIF synonyms");
  return [...new Set(data.results.map((s) => str(s.canonicalName)).filter(Boolean))].slice(0, 40);
}

async function gbifCommonNames(key) {
  const data = await getJson(`${GBIF}/species/${key}/vernacularNames?limit=200`);
  expect(Array.isArray(data?.results), "GBIF vernacular names");
  const counts = new Map();
  for (const v of data.results) {
    if (v.language !== "eng") continue;
    const name = str(v.vernacularName);
    if (!name || name.length > 60) continue;
    const k = normName(name);
    const e = counts.get(k) || { name: sentenceCase(name.toLowerCase().replace(/-/g, " ")), n: 0 };
    e.n++;
    counts.set(k, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.name).slice(0, 12);
}

async function wikipediaArticle(title, headers) {
  const data = await getJson(
    `${WIKI}?${qs({
      action: "query", format: "json", formatversion: "2", origin: "*", redirects: "1", titles: title,
      prop: "extracts|pageimages|pageprops|info|description|revisions",
      explaintext: "1", exsectionformat: "wiki", piprop: "original|thumbnail", pithumbsize: "640",
      ppprop: "wikibase_item|disambiguation", inprop: "url", rvprop: "ids",
    })}`,
    headers
  );
  expect(data?.query && Array.isArray(data.query.pages), "Wikipedia query");
  const page = data.query.pages[0];
  if (!page || page.missing || page.invalid || page.pageprops?.disambiguation !== undefined) return null;
  return page;
}

async function commonsPhoto(imageUrl, headers) {
  const m = String(imageUrl || "").match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/);
  if (!m) return null; // not on Commons (e.g. a local non-free file)
  const file = decodeURIComponent(m[1]);
  const data = await getJson(
    `${COMMONS}?${qs({
      action: "query", format: "json", formatversion: "2", origin: "*", titles: `File:${file}`,
      prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1600",
      iiextmetadatafilter: "Artist|Attribution|LicenseShortName|LicenseUrl",
    })}`,
    headers
  );
  const page = data?.query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  const license = stripHtml(meta.LicenseShortName?.value);
  if (!info?.url || !FREE_LICENSE.test(license)) return null; // unknown or non-free: don't use it
  const creator = (stripHtml(meta.Attribution?.value) || stripHtml(meta.Artist?.value)).slice(0, 200) || null;
  return {
    source: "commons",
    source_id: page.title || `File:${file}`,
    url: cleanUrl(info.thumburl || info.url),
    page_url: info.descriptionurl || null,
    creator,
    license,
    license_url: meta.LicenseUrl?.value ? String(meta.LicenseUrl.value).replace(/^http:/, "https:") : null,
    attribution: `${creator || "See file page"}, ${license}, via Wikimedia Commons`,
  };
}

async function wikidataEntity(qid, headers) {
  const data = await getJson(`${WIKIDATA}?${qs({ action: "wbgetentities", ids: qid, props: "claims", format: "json", origin: "*" })}`, headers);
  const e = data?.entities?.[qid];
  expect(e && e.claims, "Wikidata entity");
  const values = (p) => (e.claims[p] || []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v !== undefined);
  return {
    commonNames: values("P1843").filter((v) => v?.language === "en" || v?.language === "en-gb" || v?.language === "en-us").map((v) => sentenceCase(v.text)),
    gbif: values("P846").map(String)[0] || null,
    ncbi: values("P685").map(String)[0] || null,
    powo: values("P5037").map(String)[0] || null,
    inat: values("P3151").map(String)[0] || null,
  };
}

// Trefle growth values are Ellenberg-style indicator classes describing the plant's natural
// habitat. They are not care instructions, and we say so wherever they're shown.
async function trefleSpecies(name, token) {
  const list = await getJson(`${TREFLE}/species?${qs({ "filter[scientific_name]": name, token })}`);
  expect(Array.isArray(list?.data), "Trefle species list");
  const hit = list.data.find((s) => normName(s.scientific_name) === normName(name));
  if (!hit?.id) return null;
  const detail = await getJson(`${TREFLE}/species/${encodeURIComponent(hit.id)}?${qs({ token })}`);
  expect(detail?.data && typeof detail.data === "object", "Trefle species detail");
  return detail.data;
}

function trefleContent(t, now) {
  const g = t.growth || {};
  const src = {
    source: "trefle",
    source_url: `https://trefle.io/api/v1/species/${t.slug || t.id}`,
    source_record_id: String(t.id),
    ...LICENSES.trefle,
    attribution: `Data: Trefle.io (CC BY 4.0)${Array.isArray(t.sources) && t.sources.length ? `; upstream: ${t.sources.map((s) => s.name).filter(Boolean).slice(0, 4).join(", ")}` : ""}`,
    retrieved_at: now,
  };
  const out = [];
  const add = (field, body, data) => out.push({ field, section_key: "", title: null, body, data, position: 100 + out.length, ...src });
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const habitatNote = "Indicator value for the plant's natural habitat (Ellenberg scale), not a care instruction.";

  if (n(g.light) !== null) add("light", `Light indicator ${g.light} of 9 (1 = deep shade, 9 = full sun). ${habitatNote}`, { light: g.light, scale: "1-9" });
  if (n(g.atmospheric_humidity) !== null)
    add("humidity", `Air humidity indicator ${g.atmospheric_humidity} of 9 (1 = very dry, 9 = very humid). ${habitatNote}`, { atmospheric_humidity: g.atmospheric_humidity });
  const soil = [];
  if (n(g.soil_humidity) !== null) soil.push(`soil moisture indicator ${g.soil_humidity} of 12`);
  if (n(g.ph_minimum) !== null && n(g.ph_maximum) !== null) soil.push(`soil pH ${g.ph_minimum} to ${g.ph_maximum}`);
  if (n(g.soil_nutriments) !== null) soil.push(`nutrient indicator ${g.soil_nutriments} of 9`);
  if (soil.length) add("soil", `${sentenceCase(soil.join("; "))}. ${habitatNote}`, { soil_humidity: g.soil_humidity ?? null, ph_minimum: g.ph_minimum ?? null, ph_maximum: g.ph_maximum ?? null });
  const minT = n(g.minimum_temperature?.deg_c);
  const maxT = n(g.maximum_temperature?.deg_c);
  if (minT !== null || maxT !== null)
    add("temperature", [minT !== null && `Lowest tolerated temperature: ${minT} °C.`, maxT !== null && `Highest: ${maxT} °C.`].filter(Boolean).join(" "), { min_c: minT, max_c: maxT });
  if (str(g.sowing)) add("propagation", `Sowing: ${str(g.sowing)}`, null);
  const native = t.distributions?.native;
  if (Array.isArray(native) && native.length)
    add("distribution", `Native to: ${native.map((d) => d.name).filter(Boolean).slice(0, 30).join(", ")}.`, { native: native.map((d) => d.name).slice(0, 60) });
  const tox = str(t.specifications?.toxicity);
  if (tox) add("toxicity", `Trefle lists this plant's toxicity as "${tox}". Check a poison-control source before relying on it.`, { toxicity: tox });
  return out;
}

// ---------- One record ----------
/**
 * Build a record for a scientific (or common) name:
 *   { plant, names, external_ids, content, images, warnings }
 * Returns null when GBIF doesn't know the name as a plant and Wikipedia has no article.
 */
export async function buildEntry(name, { userAgent, collection = null, trefleToken = null, withTrefle = true } = {}) {
  const headers = userAgent ? { "User-Agent": userAgent, "Api-User-Agent": userAgent } : undefined;
  const now = new Date().toISOString();
  const warnings = [];
  const soft = (label) => (err) => {
    warnings.push(`${label}: ${err.message}`);
    return null;
  };

  const taxon = await gbifTaxon(name).catch(soft("GBIF"));
  const scientific = taxon?.canonical || speciesName(name) || name;
  // Wikipedia may file a plant under the species, or under the name the user typed
  // (e.g. GBIF's accepted subspecies "Streptocarpus ionanthus ionanthus" vs "Saintpaulia ionantha").
  let page = null;
  for (const title of [...new Set([scientific, speciesName(scientific), speciesName(name), name].filter(Boolean))]) {
    page = await wikipediaArticle(title, headers).catch(soft("Wikipedia"));
    if (page) break;
  }
  if (!taxon && !page) return null;

  const [synonyms, gbifNames, wd, photo, trefle] = await Promise.all([
    taxon ? gbifSynonyms(taxon.key).catch(soft("GBIF synonyms")) : null,
    taxon ? gbifCommonNames(taxon.key).catch(soft("GBIF names")) : null,
    page?.pageprops?.wikibase_item ? wikidataEntity(page.pageprops.wikibase_item, headers).catch(soft("Wikidata")) : null,
    page?.original?.source ? commonsPhoto(page.original.source, headers).catch(soft("Commons")) : null,
    trefleToken && withTrefle ? trefleSpecies(scientific, trefleToken).catch(soft("Trefle")) : null,
  ]);

  const { summary, sections } = splitSections(page?.extract);
  const wikiTitle = page?.title?.replace(/\s*\((plant|genus|flower|vegetable|herb)\)$/i, "") || "";
  const titleIsCommon = wikiTitle && normName(wikiTitle) !== normName(scientific) && !/^[A-Z][a-z]+ [a-z-]+$/.test(wikiTitle);
  const common_name =
    (titleIsCommon ? wikiTitle : leadCommonName(summary, scientific) || wd?.commonNames?.[0] || gbifNames?.[0]) || scientific;

  // Names, each with its source.
  const names = [{ name: scientific, kind: "accepted", source: taxon ? "gbif" : "wikipedia" }];
  if (taxon?.matchedAsSynonym) names.push({ name: taxon.matchedAsSynonym, kind: "synonym", source: "gbif" });
  for (const s of synonyms || []) names.push({ name: s, kind: "synonym", source: "gbif" });
  names.push({ name: common_name, kind: "common", source: titleIsCommon || leadCommonName(summary, scientific) ? "wikipedia" : wd?.commonNames?.length ? "wikidata" : "gbif" });
  for (const c of wd?.commonNames || []) names.push({ name: c, kind: "common", source: "wikidata" });
  for (const c of gbifNames || []) names.push({ name: c, kind: "common", source: "gbif" });
  const seen = new Set();
  const uniqueNames = names.filter((n) => {
    const k = `${n.kind}|${normName(n.name)}`;
    if (!normName(n.name) || seen.has(k) || (n.kind === "synonym" && normName(n.name) === normName(scientific))) return false;
    seen.add(k);
    return true;
  });

  const external_ids = [];
  if (taxon) external_ids.push({ source: "gbif", external_id: taxon.key, url: `https://www.gbif.org/species/${taxon.key}` });
  if (page?.pageprops?.wikibase_item)
    external_ids.push({ source: "wikidata", external_id: page.pageprops.wikibase_item, url: `https://www.wikidata.org/wiki/${page.pageprops.wikibase_item}` });
  if (page?.pageid) external_ids.push({ source: "wikipedia", external_id: `en:${page.pageid}`, url: page.fullurl || null });
  if (wd?.ncbi) external_ids.push({ source: "ncbi", external_id: wd.ncbi, url: `https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${wd.ncbi}` });
  if (wd?.powo) external_ids.push({ source: "powo", external_id: wd.powo, url: `https://powo.science.kew.org/taxon/${wd.powo}` });
  if (wd?.inat) external_ids.push({ source: "inaturalist", external_id: wd.inat, url: `https://www.inaturalist.org/taxa/${wd.inat}` });
  if (trefle?.id) external_ids.push({ source: "trefle", external_id: String(trefle.id), url: `https://trefle.io/api/v1/species/${trefle.slug || trefle.id}` });
  if (taxon && wd?.gbif && wd.gbif !== taxon.key) warnings.push(`Wikidata links GBIF ${wd.gbif}, GBIF matched ${taxon.key}`);

  // Content rows with provenance.
  const content = [];
  if (page) {
    const revUrl = page.revisions?.[0]?.revid
      ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title)}&oldid=${page.revisions[0].revid}`
      : page.fullurl;
    const wp = {
      source: "wikipedia",
      source_url: revUrl,
      source_record_id: page.revisions?.[0]?.revid ? String(page.revisions[0].revid) : null,
      ...LICENSES.wikipedia,
      attribution: `Wikipedia contributors, “${page.title}”, English Wikipedia`,
      retrieved_at: now,
    };
    if (summary) content.push({ field: "overview", section_key: "", title: null, body: summary, data: null, position: 0, ...wp });
    const keys = new Set();
    sections.forEach((s, i) => {
      let key = slugify(s.title) || `section-${i}`;
      while (keys.has(key)) key += "-2";
      keys.add(key);
      const mapped = s.level === 2 ? SECTION_FIELDS.find(([re]) => re.test(s.title))?.[1] : null;
      content.push({ field: "section", section_key: key, title: s.title, body: s.text, data: { level: s.level, maps_to: mapped || null }, position: i + 1, ...wp });
    });
  }
  if (taxon) {
    content.push({
      field: "taxonomy", section_key: "", title: null,
      body: [taxon.family && `Family ${taxon.family}`, taxon.genus && `genus ${taxon.genus}`].filter(Boolean).join(", "),
      data: { rank: taxon.rank, order: taxon.order, family: taxon.family, genus: taxon.genus, authorship: taxon.authorship },
      position: 90, source: "gbif", source_url: `https://www.gbif.org/species/${taxon.key}`, source_record_id: taxon.key,
      ...LICENSES.gbif, attribution: "GBIF Secretariat, GBIF Backbone Taxonomy", retrieved_at: now,
    });
  }
  if (trefle) content.push(...trefleContent(trefle, now));

  return {
    plant: {
      slug: slugify(scientific),
      scientific_name: scientific,
      authorship: taxon?.authorship || null,
      rank: taxon?.rank || null,
      kingdom: taxon?.kingdom || "Plantae",
      plant_order: taxon?.order || null,
      family: taxon?.family || null,
      genus: taxon?.genus || scientific.split(" ")[0],
      common_name,
      collection,
      description: page?.description ? sentenceCase(page.description) : null,
    },
    names: uniqueNames,
    external_ids,
    content,
    images: photo ? [{ ...photo, thumb_url: cleanUrl(page?.thumbnail?.source) || photo.url }] : [],
    warnings,
  };
}

/** Live species suggestions from GBIF (plants only), for names not stored yet. */
export async function suggestSpecies(q, limit = 8) {
  if (String(q).trim().length < 3) return [];
  const data = await getJson(`${GBIF}/species/suggest?${qs({ q, rank: "SPECIES", highertaxonKey: PLANTAE, limit: String(limit * 2) })}`);
  expect(Array.isArray(data), "GBIF suggest");
  const seen = new Set();
  return data
    .filter((s) => s.kingdom === "Plantae" && s.status === "ACCEPTED" && s.canonicalName)
    .filter((s) => !seen.has(s.canonicalName) && seen.add(s.canonicalName))
    .slice(0, limit)
    .map((s) => ({ scientific_name: s.canonicalName, family: s.family || null, slug: slugify(s.canonicalName) }));
}

/** Accepted GBIF key for a name (used to match identifications by stable id). */
export async function gbifAcceptedKey(name) {
  const t = await gbifTaxon(name).catch(() => null);
  return t ? { key: t.key, canonical: t.canonical } : null;
}
