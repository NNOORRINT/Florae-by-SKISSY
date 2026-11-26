// Renders a diagnosis.
import { esc, label, icon, fmtDate } from "./ui.js";
import { slugify, speciesName } from "./wiki-source.js";

export const HEALTH = {
  healthy: ["ok", "Healthy", "Nothing to do but keep going"],
  minor_issues: ["warn", "Minor issues", "Keep an eye on it"],
  needs_attention: ["warn", "Needs attention", "Act this week"],
  critical: ["bad", "Needs help now", "Act today"],
};

const STAGES = [
  ["seed_or_germination", "Seed"],
  ["seedling", "Seedling"],
  ["vegetative", "Leafy"],
  ["budding", "Buds"],
  ["flowering", "Flower"],
  ["fruiting", "Fruit"],
  ["ready_to_harvest", "Harvest"],
];

const WHEN = { today: "Today", this_week: "This week", ongoing: "From now on" };
const CONFIDENCE = { high: "Confident match", medium: "Likely match", low: "Best guess" };

const SOURCE = { wikipedia: "Wikipedia", gbif: "GBIF", wikidata: "Wikidata", trefle: "Trefle", planty: "Florae editors" };
const httpsOnly = (u) => (/^https:\/\//.test(String(u || "")) ? u : null);

function sourcedFact(f) {
  const where = f.kind === "health"
    ? `Reviewed health article: ${esc(f.label)}`
    : `${esc(SOURCE[f.source] || f.source || "")}${f.license ? `, ${esc(f.license)}` : ""} · ${f.reviewed ? "reviewed by Florae" : "not reviewed by Florae"}`;
  const href = f.kind === "plant" && f.plant_slug ? `/wiki/${encodeURIComponent(f.plant_slug)}` : httpsOnly(f.source_url);
  return `<li><p>${esc(f.statement)}</p><small>${href ? `<a href="${esc(href)}">${where}</a>` : where}</small></li>`;
}

// Link to the wiki only when the server matched the identification to one stored plant.
function wikiLink(r) {
  const m = r.wiki_match;
  if (!m) {
    // Checks saved before the wiki existed: link only confident identifications.
    const sp = speciesName(r.plant.scientific_name);
    return sp && r.plant.confidence === "high"
      ? `<a class="index-link" href="/wiki/${slugify(sp)}"><span><small>In the plant wiki</small><b>Read about ${esc(r.plant.common_name)}</b></span>${icon("arrow")}</a>`
      : "";
  }
  if (m.status === "matched" && m.plant)
    return `<a class="index-link" href="/wiki/${esc(m.plant.slug)}"><span><small>In the plant wiki${m.plant.match_kind === "synonym" ? ` (listed as ${esc(m.plant.scientific_name)})` : ""}</small><b>Read about ${esc(m.plant.common_name)}</b></span>${icon("arrow")}</a>`;
  if (m.status === "uncertain" && m.candidates?.length)
    return section("Possible matches", `<p class="muted small">We're not sure enough to pick one. Compare these, or take a closer photo of a leaf and any flowers.</p>
      <ul class="wk-list">${m.candidates
        .map((c) => `<li><a href="/wiki/${esc(c.slug)}"><i>${esc(c.scientific_name)}</i><small>${esc(c.common_name || "")}${c.stored ? "" : " · not in our wiki yet"}${c.why ? ` · ${esc(c.why)}` : ""}</small>${icon("arrow")}</a></li>`)
        .join("")}</ul>`);
  if (m.status === "not_stored" && m.candidates?.[0])
    return `<a class="index-link" href="/wiki/${esc(m.candidates[0].slug)}"><span><small>Not in our wiki yet · opens a live page from GBIF and Wikipedia</small><b>Look up ${esc(m.candidates[0].scientific_name)}</b></span>${icon("arrow")}</a>`;
  return "";
}

const section = (title, body) => `<section class="rsec"><h2>${title}</h2>${body}</section>`;

// The AI's own words, signed with Florae's avatar so it's always clear who is talking.
// `html` must already be escaped.
export const aiSays = (html) => `
  <div class="ai-msg">
    <img class="ai-avatar" src="/planty-avatar.svg" alt="" width="44" height="44" />
    <div class="ai-bubble">
      <p class="ai-name"><b>Florae</b><span>AI reply · can be wrong</span></p>
      <p class="verdict-text">${html}</p>
    </div>
  </div>`;

export function renderResult(el, r, photo, { date = new Date() } = {}) {
  if (!r.is_plant) {
    el.innerHTML = `
      <div class="result-grid">
        <figure class="result-photo"><div class="frame">${photo ? `<img src="${esc(photo)}" alt="" />` : ""}</div></figure>
        <div class="result-body">
          <p class="kicker">No plant found</p>
          <h1 class="display">We couldn't find a plant in this photo.</h1>
          ${aiSays(esc(r.better_photo_tips || "Try again with the plant filling most of the frame, in good light."))}
        </div>
      </div>`;
    return;
  }

  const [hClass, hText, hAdvice] = HEALTH[r.health.status] || ["plain", label(r.health.status), ""];

  const issues = r.problems.length
    ? `<ul class="issues">${r.problems
        .map(
          (p) => `
          <li>
            <div class="issue-head"><h3>${p.certainty === "possible" ? "Possibly: " : ""}${esc(p.name)}</h3><small>${label(p.category)} · <span class="sev ${p.severity}">${label(p.severity)}</span></small></div>
            <p>${esc(p.evidence)}</p>
            <p class="cause">${p.certainty ? "Possible cause" : "Likely cause"}: ${esc(p.likely_cause)}</p>
          </li>`
        )
        .join("")}</ul>`
    : `<ul class="issues"><li><div class="issue-head"><h3>Nothing unusual</h3></div><p>No signs of pests, disease or stress in this photo.</p></li></ul>`;

  const plan = ["today", "this_week", "ongoing"]
    .map((w) => [w, r.next_steps.filter((s) => s.when === w)])
    .filter(([, list]) => list.length)
    .map(
      ([w, list]) => `
      <p class="plan-when ${w}">${WHEN[w]}</p>
      <ul class="todo">${list
        .map(
          (s) => `
          <li role="checkbox" aria-checked="false" tabindex="0">
            <span class="check">${icon("check")}</span>
            <div><b>${esc(s.action)}</b><span>${esc(s.why)}</span></div>
          </li>`
        )
        .join("")}</ul>`
    )
    .join("");

  const idx = STAGES.findIndex(([k]) => k === r.growth_stage.stage);
  const stages =
    idx >= 0
      ? `<ol class="stages">${STAGES.map(([, l], i) => `<li class="${i < idx ? "past" : i === idx ? "now" : ""}"><i></i>${l}</li>`).join("")}</ol>`
      : `<p class="stage-name">${label(r.growth_stage.stage)}</p>`;
  const stage = `${stages}
    <p>${esc(r.growth_stage.explanation)}</p>
    <p class="muted">Next: ${esc(r.growth_stage.what_comes_next)}</p>`;

  const care = `
    <dl class="care">
      <div><dt>${icon("drop")}Water</dt><dd>${esc(r.care_guide.water)}</dd></div>
      <div><dt>${icon("sun")}Light</dt><dd>${esc(r.care_guide.light)}</dd></div>
      <div><dt>${icon("soil")}Soil</dt><dd>${esc(r.care_guide.soil)}</dd></div>
      <div><dt>${icon("food")}Feeding</dt><dd>${esc(r.care_guide.fertilizer)}</dd></div>
    </dl>`;

  const indexLink = wikiLink(r);

  const observations = r.observations?.length
    ? section("What we see in your photo", `<ul class="plain-list">${r.observations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
        <p class="muted small">Florae's own reading of this photo.</p>`)
    : "";
  const facts = r.sourced_facts?.length
    ? section("From the plant wiki", `<ul class="sourced">${r.sourced_facts.map(sourcedFact).join("")}</ul>`)
    : "";
  const questions = r.follow_up_questions?.length
    ? `<div class="note"><b>To narrow this down</b><ul class="plain-list">${r.follow_up_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
        <p class="muted small">Add the answers as a note, or a closer photo, and check again.</p></div>`
    : "";

  el.innerHTML = `
    <div class="result-grid">
      <figure class="result-photo">
        <div class="frame">${photo ? `<img src="${esc(photo)}" alt="Your ${esc(r.plant.common_name)}" />` : `<div class="ph">${icon("sprout")}</div>`}</div>
        <figcaption>Checked ${fmtDate(date)}</figcaption>
      </figure>

      <div class="result-body">
        <h1 class="display">${esc(r.plant.common_name)}</h1>
        <p class="sci">${esc(r.plant.scientific_name)}</p>
        <p class="result-meta"><span>${CONFIDENCE[r.plant.confidence] || ""}</span>${r.growth_stage.stage !== "unknown" ? `<span>${label(r.growth_stage.stage)}</span>` : ""}</p>

        <div class="status"><span class="hdot ${hClass}"></span><b>${esc(hText)}</b><span>${esc(hAdvice)}</span></div>
        ${aiSays(`${esc(r.health.summary)}${r.plant.description ? `<span class="about">${esc(r.plant.description)}</span>` : ""}`)}

        ${observations}
        ${section(r.observations ? "Possible problems" : "What we noticed", issues)}
        ${questions}
        ${plan ? section("What to do", plan) : ""}
        ${section("Growth stage", stage)}
        ${section("Care", care)}
        ${facts}

        ${r.when_to_get_expert_help ? `<div class="note expert"><b>When to ask an expert</b><p>${esc(r.when_to_get_expert_help)}</p></div>` : ""}
        ${r.better_photo_tips ? `<div class="note"><b>For a better answer next time</b><p>${esc(r.better_photo_tips)}</p></div>` : ""}
        ${indexLink}
      </div>
    </div>`;

  el.querySelectorAll(".todo li").forEach((li) => {
    const toggle = () => {
      li.classList.toggle("done");
      li.setAttribute("aria-checked", li.classList.contains("done"));
    };
    li.onclick = toggle;
    li.onkeydown = (e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle());
  });
}
