// "My plants": every check is saved to the user's account in Supabase.
// Photos live in a private bucket; only the owner can see them.
import { supabase as sb } from "./supabase.js";
import { $, esc, icon, toast, shrinkDataUrl, fmtDate } from "./ui.js";
import { getSession } from "./auth.js";
import { HEALTH } from "./result.js";

const BUCKET = "scan-photos";
const LEGACY_KEY = "planty-history"; // checks saved on the device by older versions
const LEGACY_DISMISSED = "planty-history-dismissed";
const URL_TTL = 60 * 60 * 6; // signed photo links last 6 hours

let cache = null;
let cachedAt = 0;

export function resetGarden() {
  cache = null;
}

async function load() {
  if (cache && Date.now() - cachedAt < 60 * 60 * 1000) return cache;
  const { data, error } = await sb
    .from("scans")
    .select("id, plant_name, scientific_name, health_status, photo_path, result, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  const urls = {};
  const paths = data.map((s) => s.photo_path).filter(Boolean);
  if (paths.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, URL_TTL);
    signed?.forEach((s) => s.signedUrl && (urls[s.path] = s.signedUrl));
  }
  cache = data.map((s) => ({ ...s, photo_url: urls[s.photo_path] || null }));
  cachedAt = Date.now();
  return cache;
}

export async function recentScans(n = 4) {
  return (await load()).slice(0, n);
}

export async function saveScan(photo, result, notes = "", date = null) {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("Please sign in again.");

  let photo_path = null;
  try {
    const small = await shrinkDataUrl(photo, 900, 0.8);
    const blob = await (await fetch(small)).blob();
    const path = `${uid}/${crypto.randomUUID()}.jpg`;
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
    if (error) console.warn("Photo upload failed:", error.message);
    else photo_path = path;
  } catch (err) {
    console.warn(err);
  }

  const row = {
    plant_name: (result.plant?.common_name || "Unknown plant").slice(0, 120),
    scientific_name: (result.plant?.scientific_name || "").slice(0, 160) || null,
    health_status: (result.health?.status || "unknown").slice(0, 40),
    photo_path,
    result,
    notes: notes ? notes.slice(0, 1000) : null,
  };
  if (date) row.created_at = date;

  const { data, error } = await sb.from("scans").insert(row).select("id").single();
  if (error) {
    if (photo_path) sb.storage.from(BUCKET).remove([photo_path]);
    throw error;
  }
  cache = null;
  return { id: data.id, photo_path };
}

export async function deleteScan(scan) {
  const { error } = await sb.from("scans").delete().eq("id", scan.id);
  if (error) throw error;
  if (scan.photo_path) await sb.storage.from(BUCKET).remove([scan.photo_path]);
  cache = null;
}

// ---------- Old checks saved on this device ----------
function legacyChecks() {
  if (localStorage.getItem(LEGACY_DISMISSED)) return [];
  try {
    return (JSON.parse(localStorage.getItem(LEGACY_KEY)) || []).filter((h) => h.result?.is_plant && h.photo);
  } catch {
    return [];
  }
}

async function importLegacy(btn, rerender) {
  const list = legacyChecks();
  btn.disabled = true;
  let ok = 0;
  for (const h of list.reverse()) {
    btn.textContent = `Adding ${ok + 1} of ${list.length}…`;
    try {
      await saveScan(h.photo, h.result, "", h.date);
      ok++;
    } catch (err) {
      console.error(err);
    }
  }
  if (ok === list.length) localStorage.removeItem(LEGACY_KEY);
  toast(ok ? `Added ${ok} check${ok === 1 ? "" : "s"} to your account 🌱` : "Couldn't add your old checks. Try again later.");
  rerender();
}

// ---------- Render ----------
export function tile(s) {
  const [cls, txt] = HEALTH[s.health_status] || ["plain", ""];
  return `
    <button class="tile" data-id="${s.id}">
      ${s.photo_url ? `<img src="${esc(s.photo_url)}" alt="" loading="lazy" />` : `<span class="ph">${icon("sprout")}</span>`}
      <b>${esc(s.plant_name)}</b>
      <span class="tile-meta"><span class="hdot ${cls}"></span>${esc(txt)}</span>
      <span class="tile-date">${fmtDate(s.created_at)}</span>
    </button>`;
}

export async function renderGarden({ onOpen, onScan }) {
  const el = $("garden");
  if (!cache) el.innerHTML = `<div class="herbarium">${'<div class="tile skeleton"></div>'.repeat(4)}</div>`;

  let list;
  try {
    list = await load();
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty">${icon("sprout")}<b>Couldn't load your plants</b>Check your connection and try again.</div>`;
    return;
  }

  const legacy = legacyChecks();
  const banner = legacy.length
    ? `<div class="card import-card">
        ${icon("info")}
        <div><b>${legacy.length} older check${legacy.length === 1 ? "" : "s"} on this device</b>
        <p>Add ${legacy.length === 1 ? "it" : "them"} to your account so ${legacy.length === 1 ? "it's" : "they're"} safe on every device.</p>
        <div class="row"><button id="importBtn" class="btn primary small">Add to my account</button>
        <button id="dismissImport" class="btn ghost small">Not now</button></div></div>
      </div>`
    : "";

  const rerender = () => renderGarden({ onOpen, onScan });

  if (!list.length) {
    el.innerHTML = `${banner}
      <div class="empty">${icon("sprout")}<b>Your herbarium is empty</b>Every plant you check is saved here.</div>
      <button class="btn primary block" id="gardenScan">${icon("camera")}Check your first plant</button>`;
    $("gardenScan").onclick = onScan;
  } else {
    const attention = list.filter((s) => ["needs_attention", "critical"].includes(s.health_status)).length;
    const species = new Set(list.map((s) => s.plant_name.toLowerCase())).size;
    el.innerHTML = `${banner}
      <div class="stats">
        <div><b>${list.length}</b><span>check${list.length === 1 ? "" : "s"}</span></div>
        <div><b>${species}</b><span>kind${species === 1 ? "" : "s"} of plant</span></div>
        <div class="${attention ? "warn" : ""}"><b>${attention}</b><span>need${attention === 1 ? "s" : ""} attention</span></div>
      </div>
      <div class="herbarium">${list.map(tile).join("")}</div>`;
    el.querySelectorAll(".tile").forEach((t) => (t.onclick = () => onOpen(list.find((s) => s.id === t.dataset.id))));
  }

  if (legacy.length) {
    $("importBtn").onclick = (e) => importLegacy(e.target, rerender);
    $("dismissImport").onclick = () => {
      localStorage.setItem(LEGACY_DISMISSED, "1");
      rerender();
    };
  }
}
