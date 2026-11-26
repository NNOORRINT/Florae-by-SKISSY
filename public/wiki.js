// Florae plant wiki: /wiki (directory) and /wiki/<slug> (one plant).
// Stored profiles come from Supabase (wiki_search / wiki_plant). A plant that isn't stored can
// still be opened: its page is assembled live from GBIF and Wikipedia and clearly labelled.
// All imported text is plain text and is escaped before it reaches the page.
import { supabase as sb } from "./supabase.js";
import { esc, icon } from "./ui.js";
import { buildEntry, suggestSpecies, nameFromSlug, slugify } from "./wiki-source.js";

const root = document.getElementById("wiki");
const PAGE_SIZE = 24;
const CARE = [
  ["light", "Light"],
  ["watering", "Water"],
  ["soil", "Soil"],
  ["humidity", "Humidity"],
  ["temperature", "Temperature"],
  ["propagation", "Propagation"],
];
const SOURCE_NAMES = { wikipedia: "Wikipedia", gbif: "GBIF", wikidata: "Wikidata", trefle: "Trefle", planty: "Florae editors", commons: "Wikimedia Commons" };

let facets = null;
let suggestTimer;
let suggestSeq = 0;
let searchSeq = 0;

// ---------- Helpers ----------
const paragraphs = (text) =>
  String(text || "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
const fmt = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");
const safeUrl = (u) => (/^https:\/\//.test(String(u || "")) ? u : null);
const link = (u, text) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${text}</a>` : text);

function setMeta(title, description) {
  document.title = title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", String(description || "").slice(0, 300));
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

function readParams() {
  const p = new URLSearchParams(location.search);
  return {
    q: p.get("q") || "",
    collection: p.get("c") || "",
    family: p.get("family") || "",
    img: p.get("img") === "1",
    care: p.get("care") === "1",
    page: Math.max(1, parseInt(p.get("page") || "1", 10) || 1),
  };
}

function writeParams(s, push = false) {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.collection) p.set("c", s.collection);
  if (s.family) p.set("family", s.family);
  if (s.img) p.set("img", "1");
  if (s.care) p.set("care", "1");
  if (s.page > 1) p.set("page", String(s.page));
  const url = `/wiki${p.toString() ? `?${p}` : ""}`;
  push ? history.pushState(null, "", url) : history.replaceState(null, "", url);
}

// ---------- Directory ----------
function card(e) {
  const via = e.match_kind && e.match_kind !== "accepted" && e.matched_name && e.matched_name !== e.common_name ? `<small>Matched ${e.match_kind === "synonym" ? "synonym" : "name"}: ${esc(e.matched_name)}</small>` : "";
  return `
    <a class="wk-card" href="/wiki/${esc(e.slug)}">
      <div class="img">${e.thumb_url ? `<img src="${esc(e.thumb_url)}" alt="" loading="lazy" />` : `<span class="wk-noimg">${icon("sprout")}<small>No photo yet</small></span>`}</div>
      <b>${esc(e.common_name)}</b>
      ${e.common_name !== e.scientific_name ? `<i>${esc(e.scientific_name)}</i>` : ""}
      <small>${esc(e.family || "")}</small>
      ${via}
    </a>`;
}

async function showIndex() {
  const s = readParams();
  setMeta("Plant wiki · Florae", "Plant profiles with sourced care information, built on Wikipedia, Wikidata, GBIF and Wikimedia Commons.");
  root.innerHTML = `
    <div class="wk-head">
      <h1 class="display">Plant wiki</h1>
      <p class="lead" id="wkLead">Plant profiles with their sources shown, from Wikipedia, Wikidata, GBIF and Wikimedia Commons.</p>
    </div>
    <form class="wk-search" id="wkForm" role="search">
      ${icon("search")}
      <input id="wkQ" type="search" autocomplete="off" spellcheck="false" placeholder="Common name, scientific name or synonym" aria-label="Search plants" value="${esc(s.q)}" />
    </form>
    <div class="wk-filters" id="wkFilters"></div>
    <div id="wkResults"><div class="wk-grid">${'<div class="wk-card"><div class="img skeleton"></div></div>'.repeat(8)}</div></div>
    <nav class="wk-pages" id="wkPages" aria-label="Pages"></nav>
    <div id="wkMore"></div>`;

  const input = document.getElementById("wkQ");
  let typing;
  input.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => update({ q: input.value.trim(), page: 1 }), 200);
    scheduleSuggest(input.value.trim());
  };
  document.getElementById("wkForm").onsubmit = (e) => {
    e.preventDefault();
    root.querySelector("#wkResults .wk-card[href]")?.click();
  };
  if (!matchMedia("(max-width: 760px)").matches && !s.q) input.focus();

  try {
    facets = facets || (await rpc("wiki_facets", {}));
  } catch (err) {
    console.warn("wiki_facets:", err.message);
    facets = null;
  }
  renderFilters(s);
  await renderResults(s);
  scheduleSuggest(s.q);
}

function update(change) {
  const s = { ...readParams(), ...change };
  writeParams(s);
  renderFilters(s);
  renderResults(s);
}

function renderFilters(s) {
  const el = document.getElementById("wkFilters");
  if (!el) return;
  if (!facets?.total) return (el.innerHTML = "");
  const cols = facets.collections || [];
  const fams = facets.families || [];
  el.innerHTML = `
    <div class="wk-chips">
      <button type="button" data-c="" class="${!s.collection ? "active" : ""}">All<small>${facets.total}</small></button>
      ${cols.map((c) => `<button type="button" data-c="${esc(c.name)}" class="${s.collection === c.name ? "active" : ""}">${esc(c.name)}<small>${c.count}</small></button>`).join("")}
    </div>
    <div class="wk-selects">
      <label><span>Family</span>
        <select id="wkFamily"><option value="">Any family</option>${fams
          .map((f) => `<option value="${esc(f.name)}" ${s.family === f.name ? "selected" : ""}>${esc(f.name)} (${f.count})</option>`)
          .join("")}</select>
      </label>
      <label class="wk-check"><input type="checkbox" id="wkImg" ${s.img ? "checked" : ""} /> With photo</label>
      <label class="wk-check"><input type="checkbox" id="wkCare" ${s.care ? "checked" : ""} /> With care data</label>
    </div>`;
  el.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => update({ collection: b.dataset.c, page: 1 })));
  document.getElementById("wkFamily").onchange = (e) => update({ family: e.target.value, page: 1 });
  document.getElementById("wkImg").onchange = (e) => update({ img: e.target.checked, page: 1 });
  document.getElementById("wkCare").onchange = (e) => update({ care: e.target.checked, page: 1 });
}

async function renderResults(s) {
  const el = document.getElementById("wkResults");
  const pages = document.getElementById("wkPages");
  if (!el) return;
  const seq = ++searchSeq;
  let rows;
  try {
    rows = await rpc("wiki_search", {
      q: s.q,
      p_family: s.family || null,
      p_collection: s.collection || null,
      p_has_image: s.img,
      p_has_care: s.care,
      p_limit: PAGE_SIZE,
      p_offset: (s.page - 1) * PAGE_SIZE,
    });
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error("wiki_search:", err.message);
    el.innerHTML = `<div class="wk-state"><b>The plant wiki isn't available right now.</b><p>You can still search above: plants are looked up live from GBIF and Wikipedia.</p></div>`;
    pages.innerHTML = "";
    return;
  }
  if (seq !== searchSeq) return;

  const total = rows[0]?.total ? Number(rows[0].total) : 0;
  if (!rows.length) {
    const filtered = s.q || s.family || s.collection || s.img || s.care;
    el.innerHTML = filtered
      ? `<div class="wk-state"><b>No stored plants match${s.q ? ` “${esc(s.q)}”` : ""}.</b><p>${s.q ? "Check the spelling, try the scientific name, or open one of the species below." : "Try removing a filter."}</p></div>`
      : `<div class="wk-state"><b>No plants have been published yet.</b><p>Search above to look a plant up live from GBIF and Wikipedia.</p></div>`;
    pages.innerHTML = "";
    return;
  }
  const from = (s.page - 1) * PAGE_SIZE + 1;
  el.innerHTML = `<p class="wk-count">${total} plant${total === 1 ? "" : "s"}${total > PAGE_SIZE ? `, showing ${from} to ${from + rows.length - 1}` : ""}</p>
    <div class="wk-grid">${rows.map(card).join("")}</div>`;

  const last = Math.ceil(total / PAGE_SIZE);
  pages.innerHTML =
    last > 1
      ? `<button type="button" class="btn outline small" data-p="${s.page - 1}" ${s.page <= 1 ? "disabled" : ""}>Previous</button>
         <span>Page ${s.page} of ${last}</span>
         <button type="button" class="btn outline small" data-p="${s.page + 1}" ${s.page >= last ? "disabled" : ""}>Next</button>`
      : "";
  pages.querySelectorAll("[data-p]").forEach(
    (b) =>
      (b.onclick = () => {
        update({ page: Number(b.dataset.p) });
        root.scrollIntoView({ behavior: "smooth" });
      })
  );
}

// Species from GBIF that aren't stored yet.
function scheduleSuggest(q) {
  clearTimeout(suggestTimer);
  const more = document.getElementById("wkMore");
  if (!more) return;
  if (q.length < 3) return (more.innerHTML = "");
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    let found = [];
    try {
      found = await suggestSpecies(q, 8);
    } catch {
      /* GBIF unreachable: show nothing */
    }
    if (seq !== suggestSeq) return;
    const stored = new Set([...root.querySelectorAll("#wkResults .wk-card[href]")].map((a) => a.getAttribute("href").slice(6)));
    found = found.filter((s) => !stored.has(s.slug));
    more.innerHTML = found.length
      ? `<section class="wk-more">
          <h2>More species from GBIF</h2>
          <p>Not stored in the wiki yet. Opening one builds a page live from GBIF and Wikipedia.</p>
          <ul class="wk-list">${found
            .map((s) => `<li><a href="/wiki/${esc(s.slug)}"><i>${esc(s.scientific_name)}</i><small>${esc(s.family || "")}</small>${icon("arrow")}</a></li>`)
            .join("")}</ul>
        </section>`
      : "";
  }, 400);
}

// ---------- Plant page ----------
async function loadPlant(slug) {
  let stored = null;
  let dbError = null;
  try {
    stored = await rpc("wiki_plant", { p_slug: slug });
  } catch (err) {
    dbError = err;
    console.warn("wiki_plant:", err.message);
  }
  if (stored?.plant) return { rec: stored, live: false };

  const key = `planty-wiki:${slug}`;
  const cached = sessionStorage.getItem(key);
  if (cached) return { rec: JSON.parse(cached), live: true };

  const raw = await buildEntry(nameFromSlug(slug));
  if (!raw) return { rec: null, dbError };
  // A synonym can resolve to an accepted name that is stored.
  if (raw.plant.slug !== slug && !dbError) {
    const again = await rpc("wiki_plant", { p_slug: raw.plant.slug }).catch(() => null);
    if (again?.plant) return { rec: again, live: false };
  }
  const now = new Date().toISOString();
  const rec = {
    plant: { ...raw.plant, short_description: raw.plant.description, status: "live" },
    names: raw.names,
    external_ids: raw.external_ids,
    content: raw.content.map((c, i) => ({ ...c, id: `live-${i}`, origin: "import", status: "published", review_status: "unreviewed", retrieved_at: c.retrieved_at || now })),
    images: raw.images.map((im) => ({ ...im, is_primary: true })),
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(rec));
  } catch {
    /* storage full */
  }
  return { rec, live: true };
}

function provenance(c) {
  const who = SOURCE_NAMES[c.source] || c.source;
  const review =
    c.origin === "editorial"
      ? c.review_status === "reviewed"
        ? `reviewed ${fmt(c.reviewed_at)}`
        : "not yet reviewed"
      : c.review_status === "reviewed"
        ? `checked by Florae ${fmt(c.reviewed_at)}`
        : "imported, not reviewed by Florae";
  return `<span class="wk-prov">${link(c.source_url, esc(who))}${c.license ? ` · ${link(c.license_url, esc(c.license))}` : ""} · ${review}</span>`;
}

async function showPlant(slug) {
  root.innerHTML = `
    <p class="wk-crumbs"><a href="/wiki">Plant wiki</a></p>
    <div class="skeleton" style="height:56px;max-width:420px"></div>
    <div class="skeleton" style="height:420px"></div>`;
  window.scrollTo(0, 0);

  let res;
  try {
    res = await loadPlant(slug);
  } catch (err) {
    console.error(err);
    res = { rec: null, failed: true };
  }
  const r = res.rec;
  if (!r) return showNotFound(slug, res.failed);
  const p = r.plant;
  if (p.slug && p.slug !== slug) history.replaceState(null, "", `/wiki/${p.slug}`);

  const content = Array.isArray(r.content) ? r.content : [];
  const byField = (f) => content.filter((c) => c.field === f).sort((a, b) => (a.origin === "editorial" ? -1 : 1) - (b.origin === "editorial" ? -1 : 1));
  const overview = byField("overview");
  const sections = content.filter((c) => c.field === "section").sort((a, b) => a.position - b.position);
  const sci = p.scientific_name;
  setMeta(`${p.common_name}${p.common_name !== sci ? ` (${sci})` : ""} · Florae plant wiki`, overview[0]?.body || p.short_description || p.common_name);

  // Photo
  const img = (r.images || []).find((i) => !i.hidden) || null;
  const photo = img
    ? `<figure class="wk-hero">
        <img src="${esc(img.url)}" alt="${esc(p.common_name)}" />
        <figcaption>Photo: ${link(img.page_url, esc(img.creator || "see the file page"))}, ${link(img.license_url, esc(img.license))}, via Wikimedia Commons</figcaption>
      </figure>`
    : `<div class="wk-hero wk-hero-empty">${icon("image")}<span>No freely licensed photo yet</span></div>`;

  // Care and conditions, with provenance on every line
  const careRows = CARE.map(([field, label]) => {
    const rows = byField(field).filter((c) => c.body);
    return rows.length
      ? `<div class="wk-care-row"><dt>${label}</dt><dd>${rows.map((c) => `<div class="wk-fact">${paragraphs(c.body)}${provenance(c)}</div>`).join("")}</dd></div>`
      : "";
  }).join("");
  const missingCare = CARE.filter(([f]) => !byField(f).some((c) => c.body)).map(([, l]) => l.toLowerCase());
  const extra = ["toxicity", "distribution", "habitat"]
    .flatMap((f) => byField(f).map((c) => ({ ...c, label: { toxicity: "Toxicity", distribution: "Distribution", habitat: "Habitat" }[f] })))
    .map((c) => `<div class="wk-care-row"><dt>${c.label}</dt><dd><div class="wk-fact">${paragraphs(c.body)}${provenance(c)}</div></dd></div>`)
    .join("");
  const care = `
    <section class="wk-care" id="care">
      <h2>Care and growing conditions</h2>
      ${careRows || extra ? `<dl>${careRows}${extra}</dl>` : ""}
      ${missingCare.length ? `<p class="wk-missing">No sourced information yet for ${missingCare.join(", ")}. We leave these empty rather than guess.</p>` : ""}
    </section>`;

  // Wikipedia article sections
  const ids = new Set();
  const idFor = (t) => {
    let id = slugify(t) || "section";
    while (ids.has(id)) id += "-2";
    ids.add(id);
    return id;
  };
  const articleSections = sections
    .map((c) => {
      c.anchor = idFor(c.title);
      const level = c.data?.level || 2;
      const tag = level <= 2 ? "h2" : level === 3 ? "h3" : "h4";
      return `<${tag} id="${c.anchor}">${esc(c.title)}</${tag}>${paragraphs(c.body)}`;
    })
    .join("");
  const wp = content.find((c) => c.source === "wikipedia");
  const toc = [{ anchor: "care", title: "Care and growing conditions", level: 2 }, ...sections.filter((c) => (c.data?.level || 2) <= 3)];

  // Names and ids
  const names = r.names || [];
  const synonyms = names.filter((n) => n.kind === "synonym").map((n) => n.name);
  const commons = names.filter((n) => n.kind === "common" && n.name.toLowerCase() !== p.common_name.toLowerCase()).map((n) => n.name);
  const ext = (r.external_ids || []).filter((e) => safeUrl(e.url));
  const EXT_NAMES = { gbif: "GBIF", wikidata: "Wikidata", wikipedia: "Wikipedia", trefle: "Trefle", ncbi: "NCBI Taxonomy", powo: "Plants of the World Online", inaturalist: "iNaturalist" };

  // Sources and licences
  const sourceLines = new Map();
  for (const c of content) {
    const k = `${c.source}|${c.license}`;
    if (!sourceLines.has(k)) sourceLines.set(k, c);
  }
  const credits = [...sourceLines.values()]
    .map(
      (c) =>
        `<li>${esc(c.attribution || SOURCE_NAMES[c.source] || c.source)}${c.license ? `, ${link(c.license_url, esc(c.license))}` : ""}${c.source_url ? ` (${link(c.source_url, "source")})` : ""}${c.retrieved_at ? `, retrieved ${fmt(c.retrieved_at)}` : ""}.${
          c.source === "wikipedia" ? " Reference lists and links are left out; the wording is unchanged." : ""
        }</li>`
    )
    .join("");

  const fact = (dt, dd) => (dd ? `<div><dt>${dt}</dt><dd>${dd}</dd></div>` : "");
  const familyLink = p.family ? `<a href="/wiki?family=${encodeURIComponent(p.family)}">${esc(p.family)}</a>` : "";
  const reviewNote = res.live
    ? "Not stored in Florae's wiki"
    : p.last_reviewed_at
      ? `Profile last reviewed ${fmt(p.last_reviewed_at)}`
      : "Imported content, not yet reviewed by Florae";

  root.innerHTML = `
    <p class="wk-crumbs"><a href="/wiki">Plant wiki</a>${p.family ? `<span>/</span>${familyLink}` : ""}${p.collection ? `<span>/</span><a href="/wiki?c=${encodeURIComponent(p.collection)}">${esc(p.collection)}</a>` : ""}</p>
    <h1 class="display wk-title">${esc(p.common_name)}</h1>
    ${p.common_name !== sci ? `<p class="wk-sci">${esc(sci)}${p.authorship ? ` <span class="wk-auth">${esc(p.authorship)}</span>` : ""}</p>` : ""}
    <p class="wk-desc">${esc(p.short_description || "")}</p>
    ${res.live ? `<p class="wk-live">This plant isn't stored in Florae's wiki yet, so this page was put together just now from GBIF and Wikipedia. Nothing on it has been reviewed.</p>` : ""}
    ${photo}

    <div class="wk-layout">
      <nav class="wk-toc" aria-label="Contents"><p>Contents</p><ol>${toc
        .map((s) => `<li class="${(s.data?.level || s.level || 2) > 2 ? "sub" : ""}"><a href="#${s.anchor}">${esc(s.title)}</a></li>`)
        .join("")}</ol></nav>

      <article class="wk-article">
        ${overview.length ? `<div class="wk-lead">${paragraphs(overview[0].body)}</div>${provenance(overview[0])}` : `<p class="muted">There's no Wikipedia article for this plant yet.</p>`}
        ${care}
        ${articleSections ? `<div class="wk-sections">${articleSections}${wp ? provenance(wp) : ""}</div>` : ""}
        <section class="wk-sources">
          <h2 class="wk-section-title">Sources and licences</h2>
          <ul>${credits}${img ? `<li>Photo: ${esc(img.creator || "see the file page")}, ${link(img.license_url, esc(img.license))}, ${link(img.page_url, "Wikimedia Commons")}.</li>` : ""}</ul>
          <p>${esc(reviewNote)}.</p>
        </section>
      </article>

      <aside class="wk-aside">
        <h2 class="wk-section-title">At a glance</h2>
        <dl class="wk-facts">
          ${fact(p.rank && p.rank !== "species" ? esc(p.rank.charAt(0).toUpperCase() + p.rank.slice(1)) : "Species", `<i>${esc(sci)}</i>`)}
          ${fact("Genus", p.genus ? `<i>${esc(p.genus)}</i>` : "")}
          ${fact("Family", familyLink)}
          ${fact("Order", esc(p.plant_order || ""))}
          ${fact("Group", p.collection ? esc(p.collection) : "")}
        </dl>
        ${commons.length ? `<h2 class="wk-section-title">Also called</h2><p class="wk-names">${commons.slice(0, 10).map(esc).join(", ")}</p>` : ""}
        ${synonyms.length ? `<h2 class="wk-section-title">Synonyms</h2><p class="wk-names"><i>${synonyms.slice(0, 12).map(esc).join(", ")}</i>${synonyms.length > 12 ? ` and ${synonyms.length - 12} more` : ""}</p>` : ""}
        ${ext.length ? `<h2 class="wk-section-title">Elsewhere</h2><ul class="wk-out">${ext.map((e) => `<li>${link(e.url, esc(EXT_NAMES[e.source] || e.source))}</li>`).join("")}</ul>` : ""}
        <div class="wk-cta">
          <p>Growing one? Photograph it and Florae will tell you how it's doing.</p>
          <a class="btn primary" href="/">Check your plant</a>
        </div>
      </aside>
    </div>`;

  spyOnSections(root.querySelectorAll(".wk-toc a"));
}

function showNotFound(slug, failed) {
  setMeta("Not found · Florae plant wiki", "This plant could not be found.");
  root.innerHTML = `
    <p class="wk-crumbs"><a href="/wiki">Plant wiki</a></p>
    <div class="wk-notfound">
      <h1 class="display small">${failed ? "We couldn't load this plant." : `We couldn't find “${esc(nameFromSlug(slug))}”.`}</h1>
      <p class="lead">${
        failed
          ? "The plant databases we use didn't respond. Check your connection and try again in a moment."
          : "It isn't stored in the wiki, and GBIF and Wikipedia don't list a plant by that name. Try its scientific name, or search the wiki."
      }</p>
      <a class="btn outline" href="/wiki?q=${encodeURIComponent(nameFromSlug(slug))}">Search the wiki</a>
    </div>`;
}

let spy;
function spyOnSections(links) {
  spy?.disconnect();
  if (!links.length || !("IntersectionObserver" in window)) return;
  const byId = new Map([...links].map((a) => [a.getAttribute("href").slice(1), a]));
  spy = new IntersectionObserver(
    (entries) => {
      const v = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!v) return;
      links.forEach((a) => a.classList.remove("on"));
      byId.get(v.target.id)?.classList.add("on");
    },
    { rootMargin: "-80px 0px -70% 0px" }
  );
  byId.forEach((_, id) => {
    const h = document.getElementById(id);
    if (h) spy.observe(h);
  });
}

// ---------- Routing ----------
function route() {
  const m = location.pathname.match(/^\/wiki\/?(.*)$/);
  const slug = m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : "";
  if (slug) showPlant(slugify(slug));
  else showIndex();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !/^\/wiki(\/|$)/.test(url.pathname)) return;
  if (url.hash && url.pathname === location.pathname) return;
  e.preventDefault();
  history.pushState(null, "", url.pathname + url.search);
  route();
  window.scrollTo(0, 0);
});
window.addEventListener("popstate", route);

route();
