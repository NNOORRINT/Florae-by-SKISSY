// Wiki administration for staff (public.staff_roles). The database enforces every rule:
// editors can draft and edit; only admins can review or publish. This page just mirrors that.
import { supabase as sb } from "./supabase.js";
import { esc, toast } from "./ui.js";
import { slugify } from "./wiki-source.js";

const root = document.getElementById("admin");
const FIELDS = ["overview", "light", "watering", "soil", "humidity", "temperature", "propagation", "toxicity", "distribution", "habitat"];
const CATEGORIES = ["disease", "pest", "nutrient", "watering", "light", "temperature", "physical_damage", "other"];
let role = null;
let tab = "plants";
const isAdmin = () => role === "admin";
const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const lines = (s) => String(s || "").split(/\n|,/).map((x) => x.trim()).filter(Boolean);

async function guard(promise, okMsg) {
  const { error, data } = await promise;
  if (error) {
    toast(error.code === "42501" ? "You don't have permission for that." : error.message);
    return null;
  }
  if (okMsg) toast(okMsg);
  return data ?? true;
}

// ---------- Access ----------
async function start() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    root.innerHTML = `<div class="wk-state"><b>Sign in first.</b><p><a href="/">Sign in to Florae</a>, then come back to this page.</p></div>`;
    return;
  }
  const { data: r } = await sb.rpc("wiki_my_role");
  role = r;
  if (!role) {
    root.innerHTML = `<div class="wk-state"><b>This page is for Florae staff.</b><p>Your account doesn't have an editor or admin role.</p></div>`;
    return;
  }
  render();
}

function render() {
  root.innerHTML = `
    <div class="view-head"><div><h1 class="display">Wiki admin</h1><p class="lead">Signed in as ${esc(role)}. ${isAdmin() ? "You can review and publish." : "You can draft; an admin reviews and publishes."}</p></div></div>
    <div class="wk-chips ad-tabs">${["plants", "health", "imports"]
      .map((t) => `<button type="button" data-t="${t}" class="${t === tab ? "active" : ""}">${{ plants: "Plants", health: "Health articles", imports: "Imports" }[t]}</button>`)
      .join("")}</div>
    <div id="adBody"></div>`;
  root.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => ((tab = b.dataset.t), render())));
  ({ plants: plantsTab, health: healthTab, imports: importsTab })[tab]();
}

// ---------- Plants ----------
async function plantsTab(q = "") {
  const body = document.getElementById("adBody");
  body.innerHTML = `<div class="fl"><input id="adQ" placeholder="Search plants, including drafts" value="${esc(q)}" /></div><div id="adList" class="muted">Loading…</div>`;
  const input = document.getElementById("adQ");
  let t;
  input.oninput = () => (clearTimeout(t), (t = setTimeout(() => list(input.value.trim()), 250)));
  list(q);

  async function list(query) {
    const rows = await guard(sb.rpc("wiki_search", { q: query, p_limit: 100, p_offset: 0 }));
    if (!rows) return;
    const slugs = rows.map((r) => r.slug);
    const { data: meta } = slugs.length ? await sb.from("plants").select("slug, status, last_reviewed_at").in("slug", slugs) : { data: [] };
    const bySlug = new Map((meta || []).map((m) => [m.slug, m]));
    document.getElementById("adList").innerHTML = rows.length
      ? `<table class="ad-table"><thead><tr><th>Plant</th><th>Status</th><th>Reviewed</th></tr></thead><tbody>${rows
          .map((r) => {
            const m = bySlug.get(r.slug) || {};
            return `<tr><td><button class="link-btn" data-slug="${esc(r.slug)}">${esc(r.common_name)}</button> <i class="muted">${esc(r.scientific_name)}</i></td><td>${esc(m.status || "")}</td><td>${m.last_reviewed_at ? fmt(m.last_reviewed_at) : "no"}</td></tr>`;
          })
          .join("")}</tbody></table>`
      : `<p class="muted">No plants. Run the import script first (see README).</p>`;
    document.querySelectorAll("[data-slug]").forEach((b) => (b.onclick = () => plantEditor(b.dataset.slug, query)));
  }
}

async function plantEditor(slug, backQuery) {
  const body = document.getElementById("adBody");
  const rec = await guard(sb.rpc("wiki_plant", { p_slug: slug }));
  if (!rec?.plant) return;
  const { data: row } = await sb.from("plants").select("id, status, common_name, locked_fields, last_reviewed_at, editor_note").eq("slug", slug).single();
  const p = { ...rec.plant, ...row };
  const content = rec.content || [];

  body.innerHTML = `
    <p><button class="link-btn" id="adBack">← All plants</button> · <a href="/wiki/${esc(slug)}" target="_blank">Open public page</a></p>
    <h2 class="ad-h">${esc(p.common_name)} <i class="muted">${esc(p.scientific_name)}</i></h2>
    <p>Status: <b>${esc(p.status)}</b> · Last reviewed: ${fmt(p.last_reviewed_at)}</p>
    <div class="ad-row">
      ${isAdmin() ? `<button class="btn ${p.status === "published" ? "outline" : "primary"} small" id="adPub">${p.status === "published" ? "Unpublish" : "Publish"}</button>
      <button class="btn outline small" id="adRev">Mark profile reviewed now</button>` : `<span class="muted small">Publishing and reviewing need an admin.</span>`}
    </div>

    <h3 class="ad-sub">Common name</h3>
    <div class="ad-row"><input class="field" id="adName" value="${esc(p.common_name)}" />
      <label class="wk-check"><input type="checkbox" id="adLock" ${p.locked_fields?.includes("common_name") ? "checked" : ""}/> Keep this name on re-import</label>
      <button class="btn outline small" id="adSaveName">Save</button></div>

    <h3 class="ad-sub">Content</h3>
    <table class="ad-table"><thead><tr><th>Field</th><th>Source</th><th>Text</th><th>Review</th><th></th></tr></thead><tbody>${content
      .map(
        (c) => `<tr>
          <td>${esc(c.field === "section" ? c.title : c.field)}</td>
          <td>${esc(c.origin === "editorial" ? `editor (${c.status})` : c.source)}</td>
          <td class="ad-text">${esc(c.body.slice(0, 180))}${c.body.length > 180 ? "…" : ""}</td>
          <td>${c.review_status === "reviewed" ? `reviewed ${fmt(c.reviewed_at)}` : "unreviewed"}</td>
          <td>${isAdmin() && c.review_status !== "reviewed" ? `<button class="link-btn" data-review="${c.id}">Mark reviewed</button>` : ""}
              ${isAdmin() && c.origin === "editorial" && c.status === "draft" && c.review_status === "reviewed" ? `<button class="link-btn" data-publish="${c.id}">Publish</button>` : ""}</td>
        </tr>`
      )
      .join("")}</tbody></table>
    <p class="muted small">Imported rows marked reviewed are never overwritten by later imports.</p>

    <h3 class="ad-sub">Add editorial content</h3>
    <p class="muted small">Written by staff, stored separately from imported text, shown only after an admin reviews and publishes it. Cite where it comes from.</p>
    <div class="ad-form">
      <label class="fl"><span>Field</span><select id="adField">${FIELDS.map((f) => `<option>${f}</option>`).join("")}</select></label>
      <label class="fl"><span>Text</span><textarea class="field" id="adBody2" rows="4"></textarea></label>
      <label class="fl"><span>Source URL</span><input id="adSrc" placeholder="https://…" /></label>
      <label class="fl"><span>Source and licence (attribution)</span><input id="adAttr" placeholder="e.g. RHS, own testing notes" /></label>
      <label class="wk-check"><input type="checkbox" id="adAi" /> Drafted with AI (can't be marked reviewed or published)</label>
      <button class="btn primary small" id="adAdd">Save as draft</button>
    </div>

    <h3 class="ad-sub">Images</h3>
    ${(rec.images || [])
      .map(
        (i) => `<div class="ad-img"><img src="${esc(i.thumb_url || i.url)}" alt="" /><div><p class="small">${esc(i.creator || "see file page")}, ${esc(i.license)}${i.is_primary ? " · main photo" : ""}${i.hidden ? " · hidden" : ""}</p>
          <button class="link-btn" data-hide="${i.id}" data-hidden="${i.hidden}">${i.hidden ? "Show" : "Hide"}</button></div></div>`
      )
      .join("") || `<p class="muted small">No images.</p>`}`;

  const again = () => plantEditor(slug, backQuery);
  document.getElementById("adBack").onclick = () => plantsTab(backQuery);
  document.getElementById("adPub")?.addEventListener("click", async () => {
    if (await guard(sb.from("plants").update({ status: p.status === "published" ? "draft" : "published" }).eq("id", p.id), "Saved")) again();
  });
  document.getElementById("adRev")?.addEventListener("click", async () => {
    if (await guard(sb.from("plants").update({ last_reviewed_at: new Date().toISOString() }).eq("id", p.id), "Marked reviewed")) again();
  });
  document.getElementById("adSaveName").onclick = async () => {
    const name = document.getElementById("adName").value.trim();
    if (!name) return;
    const locked = new Set(p.locked_fields || []);
    document.getElementById("adLock").checked ? locked.add("common_name") : locked.delete("common_name");
    if (await guard(sb.from("plants").update({ common_name: name, locked_fields: [...locked] }).eq("id", p.id), "Saved")) again();
  };
  body.querySelectorAll("[data-review]").forEach(
    (b) => (b.onclick = async () => (await guard(sb.from("plant_content").update({ review_status: "reviewed" }).eq("id", b.dataset.review), "Marked reviewed")) && again())
  );
  body.querySelectorAll("[data-publish]").forEach(
    (b) => (b.onclick = async () => (await guard(sb.from("plant_content").update({ status: "published" }).eq("id", b.dataset.publish), "Published")) && again())
  );
  body.querySelectorAll("[data-hide]").forEach(
    (b) => (b.onclick = async () => (await guard(sb.from("plant_images").update({ hidden: b.dataset.hidden !== "true" }).eq("id", b.dataset.hide), "Saved")) && again())
  );
  document.getElementById("adAdd").onclick = async () => {
    const text = document.getElementById("adBody2").value.trim();
    const src = document.getElementById("adSrc").value.trim();
    const attribution = document.getElementById("adAttr").value.trim();
    if (!text || !attribution) return toast("Add the text and where it comes from.");
    if (src && !/^https:\/\//.test(src)) return toast("The source URL must start with https://");
    const { data: s } = await sb.auth.getSession();
    const ok = await guard(
      sb.from("plant_content").insert({
        plant_id: p.id,
        field: document.getElementById("adField").value,
        section_key: "",
        body: text,
        origin: "editorial",
        source: "planty",
        source_url: src || null,
        attribution,
        status: "draft",
        ai_generated: document.getElementById("adAi").checked,
        created_by: s.session.user.id,
      }),
      "Draft saved"
    );
    if (ok) again();
  };
}

// ---------- Health articles ----------
async function healthTab() {
  const body = document.getElementById("adBody");
  const { data, error } = await sb.from("health_articles").select("*").order("updated_at", { ascending: false });
  if (error) return (body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`);
  body.innerHTML = `
    <p class="muted small">Symptom and care articles, separate from plant profiles. The photo check only uses articles that are reviewed and published. An article drafted with AI can't be reviewed or published.</p>
    <table class="ad-table"><thead><tr><th>Title</th><th>Status</th><th>Review</th><th></th></tr></thead><tbody>${data
      .map((a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.status)}</td><td>${a.review_status === "reviewed" ? fmt(a.last_reviewed_at) : "unreviewed"}${a.ai_generated ? " · AI draft" : ""}</td><td><button class="link-btn" data-edit="${a.id}">Edit</button></td></tr>`)
      .join("") || `<tr><td colspan="4" class="muted">No articles yet.</td></tr>`}</tbody></table>
    <button class="btn primary small" id="adNew">New article</button>
    <div id="adEditor"></div>`;
  document.getElementById("adNew").onclick = () => articleEditor(null);
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => articleEditor(data.find((a) => a.id === b.dataset.edit))));
}

function articleEditor(a) {
  const el = document.getElementById("adEditor");
  const v = a || { title: "", slug: "", summary: "", body: "", symptoms: [], categories: [], sources: [], status: "draft", review_status: "unreviewed", ai_generated: false };
  el.innerHTML = `
    <div class="ad-form">
      <h3 class="ad-sub">${a ? "Edit article" : "New article"}</h3>
      <label class="fl"><span>Title</span><input id="haTitle" value="${esc(v.title)}" /></label>
      <label class="fl"><span>Summary</span><textarea class="field" id="haSummary" rows="2">${esc(v.summary)}</textarea></label>
      <label class="fl"><span>Article</span><textarea class="field" id="haBody" rows="10">${esc(v.body)}</textarea></label>
      <label class="fl"><span>Symptoms it covers (one per line)</span><textarea class="field" id="haSym" rows="3">${esc(v.symptoms.join("\n"))}</textarea></label>
      <div class="fl"><span>Problem types</span><div class="ad-row">${CATEGORIES.map((c) => `<label class="wk-check"><input type="checkbox" value="${c}" class="haCat" ${v.categories.includes(c) ? "checked" : ""}/> ${c.replace("_", " ")}</label>`).join("")}</div></div>
      <label class="fl"><span>Sources (one per line: title | https://url | licence)</span><textarea class="field" id="haSrc" rows="3">${esc(v.sources.map((s) => [s.title, s.url, s.license].filter(Boolean).join(" | ")).join("\n"))}</textarea></label>
      <label class="wk-check"><input type="checkbox" id="haAi" ${v.ai_generated ? "checked" : ""}/> Drafted with AI</label>
      <p class="small">Status: ${esc(v.status)} · ${esc(v.review_status)}</p>
      <div class="ad-row">
        <button class="btn primary small" id="haSave">Save draft</button>
        ${a && isAdmin() && v.review_status !== "reviewed" ? `<button class="btn outline small" id="haReview">Mark reviewed</button>` : ""}
        ${a && isAdmin() && v.review_status === "reviewed" ? `<button class="btn outline small" id="haPublish">${v.status === "published" ? "Unpublish" : "Publish"}</button>` : ""}
      </div>
    </div>`;
  const read = () => ({
    title: document.getElementById("haTitle").value.trim(),
    slug: a?.slug || slugify(document.getElementById("haTitle").value),
    summary: document.getElementById("haSummary").value.trim(),
    body: document.getElementById("haBody").value.trim(),
    symptoms: lines(document.getElementById("haSym").value.replace(/,/g, "\n")),
    categories: [...document.querySelectorAll(".haCat:checked")].map((c) => c.value),
    sources: document.getElementById("haSrc").value.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([title, url, license]) => ({ title, url: /^https:\/\//.test(url || "") ? url : null, license: license || null })),
    ai_generated: document.getElementById("haAi").checked,
  });
  document.getElementById("haSave").onclick = async () => {
    const row = read();
    if (!row.title || !row.body) return toast("Add a title and the article text.");
    const ok = a ? await guard(sb.from("health_articles").update(row).eq("id", a.id), "Saved") : await guard(sb.from("health_articles").insert({ ...row, status: "draft" }), "Draft saved");
    if (ok) healthTab();
  };
  document.getElementById("haReview")?.addEventListener("click", async () => (await guard(sb.from("health_articles").update({ review_status: "reviewed" }).eq("id", a.id), "Marked reviewed")) && healthTab());
  document.getElementById("haPublish")?.addEventListener("click", async () =>
    (await guard(sb.from("health_articles").update({ status: v.status === "published" ? "draft" : "published" }).eq("id", a.id), "Saved")) && healthTab()
  );
}

// ---------- Imports ----------
async function importsTab() {
  const body = document.getElementById("adBody");
  const { data: runs, error } = await sb.from("wiki_import_runs").select("*").order("started_at", { ascending: false }).limit(20);
  if (error) return (body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`);
  const { data: fails } = runs.length ? await sb.from("wiki_import_failures").select("*").in("run_id", runs.map((r) => r.id)) : { data: [] };
  body.innerHTML = `
    <p class="muted small">Imports run from the command line with the server-side key: <code>npm run import-wiki</code>. They are listed here when they finish.</p>
    ${runs
      .map((r) => {
        const f = (fails || []).filter((x) => x.run_id === r.id);
        return `<div class="ad-run"><b>${fmt(r.started_at)}</b> · ${esc(r.status)} · ${r.total} processed, ${r.created} created, ${r.updated} updated, ${r.failed} failed, ${r.preserved} reviewed rows kept
          ${f.length ? `<ul>${f.map((x) => `<li>${esc(x.input_name)} (${esc(x.stage || "")}): ${esc(x.error)}</li>`).join("")}</ul>` : ""}</div>`;
      })
      .join("") || `<p class="muted">No imports yet.</p>`}`;
}

start();
