// Renders a diagnosis as a "field journal" page.
import { esc, label, icon, fmtDate } from "./ui.js";

export const HEALTH = {
  healthy: ["ok", "Healthy", "Looking good"],
  minor_issues: ["warn", "Minor issues", "Keep an eye on it"],
  needs_attention: ["warn", "Needs attention", "Act this week"],
  critical: ["bad", "Needs help now", "Act today"],
};

const STAGES = [
  ["seed_or_germination", "Seed"],
  ["seedling", "Sprout"],
  ["vegetative", "Leafy"],
  ["budding", "Buds"],
  ["flowering", "Bloom"],
  ["fruiting", "Fruit"],
  ["ready_to_harvest", "Harvest"],
];

const WHEN = { today: "Today", this_week: "This week", ongoing: "Ongoing" };

const CATEGORY_ICON = {
  disease: "alert",
  pest: "bug",
  nutrient: "food",
  watering: "drop",
  light: "sun",
  temperature: "thermo",
  physical_damage: "bandage",
  other: "info",
};

const CONFIDENCE = { high: "Confident match", medium: "Likely match", low: "Best guess" };

function seal(status, date) {
  const [cls, text] = HEALTH[status] || ["plain", label(status)];
  const id = "seal-" + Math.random().toString(36).slice(2, 8);
  const ring = `${text} · checked by planty · ${fmtDate(date)} · `.toUpperCase();
  const mid = cls === "ok" ? "check" : cls === "bad" ? "alert" : "eye";
  return `
    <div class="seal ${cls}" role="img" aria-label="Health: ${esc(text)}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs><path id="${id}" d="M60,60 m-45,0 a45,45 0 1,1 90,0 a45,45 0 1,1 -90,0"/></defs>
        <circle cx="60" cy="60" r="58" class="seal-fill"/>
        <circle cx="60" cy="60" r="33" class="seal-inner"/>
        <text class="seal-ring"><textPath href="#${id}" textLength="280" lengthAdjust="spacing">${esc(ring)}</textPath></text>
      </svg>
      <span class="seal-mid">${icon(mid)}</span>
    </div>`;
}

function section(n, title, body) {
  return `<section class="sec-block"><h3 class="sec"><span>${String(n).padStart(2, "0")}</span>${title}</h3>${body}</section>`;
}

export function renderResult(el, r, photo, { date = new Date() } = {}) {
  if (!r.is_plant) {
    el.innerHTML = `
      <article class="specimen">
        <div class="specimen-photo">${photo ? `<img src="${esc(photo)}" alt="" />` : ""}</div>
        <div class="specimen-tag">
          <span class="eyebrow">No plant found</span>
          <h2 class="specimen-name">Hmm, we couldn't<br />see a plant.</h2>
        </div>
      </article>
      <p class="verdict">${esc(r.better_photo_tips || "Try again with the plant filling most of the picture, in good light.")}</p>`;
    return;
  }

  const [hClass, , hAdvice] = HEALTH[r.health.status] || ["plain", "", ""];
  let n = 0;

  // 01 What we noticed
  const issues = r.problems.length
    ? r.problems
        .map(
          (p) => `
        <div class="card issue">
          <span class="issue-ico ${p.severity}">${icon(CATEGORY_ICON[p.category] || "info")}</span>
          <div>
            <span class="issue-meta">${label(p.category)} · <b class="sev ${p.severity}">${label(p.severity)}</b></span>
            <h4>${esc(p.name)}</h4>
            <p>${esc(p.evidence)}</p>
            <p class="cause"><b>Likely cause:</b> ${esc(p.likely_cause)}</p>
          </div>
        </div>`
        )
        .join("")
    : `<div class="card healthy-card"><span class="issue-ico low">${icon("check")}</span><div><h4>Nothing unusual spotted</h4><p>Your plant looks happy. Keep doing what you're doing.</p></div></div>`;

  // 02 Your plan
  const groups = ["today", "this_week", "ongoing"]
    .map((w) => [w, r.next_steps.filter((s) => s.when === w)])
    .filter(([, list]) => list.length);
  const plan = groups
    .map(
      ([w, list]) => `
      <div class="plan-group">
        <p class="plan-when ${w}">${icon(w === "today" ? "alert" : "calendar")}${WHEN[w]}</p>
        <ul class="todo">
          ${list
            .map(
              (s) => `
            <li role="checkbox" aria-checked="false" tabindex="0">
              <span class="check">${icon("check")}</span>
              <div><b>${esc(s.action)}</b><span>${esc(s.why)}</span></div>
            </li>`
            )
            .join("")}
        </ul>
      </div>`
    )
    .join("");

  // 03 Growth stage
  const idx = STAGES.findIndex(([k]) => k === r.growth_stage.stage);
  const vine =
    idx >= 0
      ? `<div class="vine" style="--p:${idx / (STAGES.length - 1)}">
          ${STAGES.map(([, l], i) => `<div class="node ${i < idx ? "past" : i === idx ? "now" : ""}"><i></i><small>${l}</small></div>`).join("")}
        </div>`
      : "";
  const stage = `
    <div class="card stage-card">
      <span class="stage-name">${label(r.growth_stage.stage)}</span>
      ${vine}
      <p>${esc(r.growth_stage.explanation)}</p>
      <p class="next"><b>Coming next:</b> ${esc(r.growth_stage.what_comes_next)}</p>
    </div>`;

  // 04 Care basics
  const care = `
    <div class="care">
      <div class="care-tile water">${icon("drop")}<b>Water</b><p>${esc(r.care_guide.water)}</p></div>
      <div class="care-tile light">${icon("sun")}<b>Light</b><p>${esc(r.care_guide.light)}</p></div>
      <div class="care-tile soil">${icon("soil")}<b>Soil</b><p>${esc(r.care_guide.soil)}</p></div>
      <div class="care-tile food">${icon("food")}<b>Feeding</b><p>${esc(r.care_guide.fertilizer)}</p></div>
    </div>`;

  el.innerHTML = `
    <article class="specimen">
      <div class="specimen-photo">
        ${photo ? `<img src="${esc(photo)}" alt="Photo of your ${esc(r.plant.common_name)}" />` : `<div class="ph">${icon("sprout")}</div>`}
        ${seal(r.health.status, date)}
      </div>
      <div class="specimen-tag">
        <span class="eyebrow">Specimen · ${fmtDate(date)}</span>
        <h2 class="specimen-name">${esc(r.plant.common_name)}</h2>
        <p class="sci">${esc(r.plant.scientific_name)}</p>
        <span class="conf ${r.plant.confidence}">${CONFIDENCE[r.plant.confidence] || ""}</span>
      </div>
    </article>

    <div class="verdict ${hClass}">
      <span class="verdict-label">${esc(hAdvice)}</span>
      <p>${esc(r.health.summary)}</p>
    </div>
    ${r.plant.description ? `<p class="about">${esc(r.plant.description)}</p>` : ""}

    ${section(++n, "What we noticed", issues)}
    ${plan ? section(++n, "Your plan", plan) : ""}
    ${section(++n, "Growth stage", stage)}
    ${section(++n, "Care basics", care)}

    ${r.when_to_get_expert_help ? `<div class="card note-card expert">${icon("info")}<div><b>When to ask an expert</b><p>${esc(r.when_to_get_expert_help)}</p></div></div>` : ""}
    ${r.better_photo_tips ? `<div class="card note-card">${icon("camera")}<div><b>For a sharper answer</b><p>${esc(r.better_photo_tips)}</p></div></div>` : ""}`;

  el.querySelectorAll(".todo li").forEach((li) => {
    const toggle = () => {
      li.classList.toggle("done");
      li.setAttribute("aria-checked", li.classList.contains("done"));
    };
    li.onclick = toggle;
    li.onkeydown = (e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle());
  });
}
