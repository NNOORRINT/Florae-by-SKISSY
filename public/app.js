// Planty by Skissy: app start, navigation and the scan flow.
import { $, esc, icon, toast, closeSheets, fileToDataUrl, hydrateIcons, avatar } from "./ui.js";
import { supabase as sb } from "./supabase.js";
import { initAuth, authHeader, myName, openAccount } from "./auth.js";
import { renderResult, HEALTH } from "./result.js";
import { renderGarden, saveScan, deleteScan, recentScans, resetGarden } from "./garden.js";
import { initCommunity, showCommunity, openComposer, resetCommunity } from "./community.js";

hydrateIcons();

let currentPhoto = null; // photo being checked (data URL) or a saved photo's URL
let currentResult = null; // diagnosis on screen
let currentScan = null; // the saved check on screen, when opened from My plants
let resultFrom = "scan"; // where "Back" goes from a result
let currentView = "scan";
let currentStep = "home";

// ---------- Navigation ----------
function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-current", on ? "page" : "false");
  });
  updateBack();
  window.scrollTo(0, 0);
  if (name === "community") showCommunity();
  if (name === "garden") renderGarden({ onOpen: (s) => openSaved(s, "garden"), onScan: goHome });
  if (name === "scan" && currentStep === "home") refreshHome();
}

function showStep(step) {
  currentStep = step;
  document.querySelectorAll("#view-scan .step").forEach((s) => s.classList.toggle("active", s.id === `scan-${step}`));
  updateBack();
  window.scrollTo(0, 0);
}

function updateBack() {
  $("backBtn").classList.toggle("hidden", !(currentView === "scan" && ["preview", "result"].includes(currentStep)));
}

function goHome() {
  showStep("home");
  showView("scan");
}

document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));
$("backBtn").onclick = () => {
  if (currentStep === "result" && resultFrom === "garden") {
    showStep("home");
    showView("garden");
  } else goHome();
};
$("accountBtn").onclick = openAccount;

// ---------- Home ----------
function greet() {
  const h = new Date().getHours();
  const first = myName().split(" ")[0];
  $("greeting").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${first}`;
  $("accountBtn").innerHTML = avatar(myName());
}

function showQuota(left) {
  if (typeof left !== "number") return ($("quotaLine").innerHTML = "");
  $("quotaLine").innerHTML =
    left > 0
      ? `<span class="leaf-dot"></span><b>${left}</b>&nbsp;free check${left === 1 ? "" : "s"} left today`
      : `<span class="leaf-dot off"></span>You've used today's free checks. Back tomorrow!`;
}

async function refreshHome() {
  greet();
  sb.rpc("scan_quota").then(({ data, error }) => showQuota(error ? null : data));

  let list = [];
  try {
    list = await recentScans(6);
  } catch {
    /* table may not exist yet */
  }
  $("recent").innerHTML = list.length
    ? `<div class="recent-head"><h3>Recently checked</h3><button class="text-btn" id="seeAll">See all</button></div>
       <div class="recent-row">${list
         .map((s) => {
           const [cls] = HEALTH[s.health_status] || ["plain"];
           return `<button class="mini" data-id="${s.id}">
             ${s.photo_url ? `<img src="${esc(s.photo_url)}" alt="" loading="lazy" />` : `<span class="ph">${icon("sprout")}</span>`}
             <span class="hdot ${cls}"></span><b>${esc(s.plant_name)}</b></button>`;
         })
         .join("")}</div>`
    : "";
  $("recent").querySelectorAll(".mini").forEach((b) => (b.onclick = () => openSaved(list.find((s) => s.id === b.dataset.id), "scan")));
  $("seeAll")?.addEventListener("click", () => showView("garden"));
}

// ---------- Taking / choosing a photo ----------
async function handleFile(file) {
  try {
    currentPhoto = await fileToDataUrl(file);
    currentScan = null;
    $("previewImg").src = currentPhoto;
    $("notes").value = "";
    $("notes").classList.add("hidden");
    $("noteToggle").classList.remove("hidden");
    showView("scan");
    showStep("preview");
  } catch (err) {
    toast(err.message);
  }
}
for (const id of ["cameraInput", "galleryInput"]) {
  $(id).onchange = (e) => {
    handleFile(e.target.files[0]);
    e.target.value = "";
  };
}
$("noteToggle").onclick = () => {
  $("noteToggle").classList.add("hidden");
  $("notes").classList.remove("hidden");
  $("notes").focus();
};
$("retakeBtn").onclick = goHome;
$("againBtn").onclick = goHome;

// ---------- Ask the AI ----------
function progress(i) {
  $("loadingSteps").querySelectorAll("li").forEach((li, j) => {
    li.className = j < i ? "done" : j === i ? "now" : "";
    li.querySelector(".dot").innerHTML = j < i ? icon("check") : "";
  });
}

async function analyze() {
  $("loadingImg").src = currentPhoto;
  showStep("loading");
  let i = 0;
  progress(0);
  const ticker = setInterval(() => progress((i = Math.min(i + 1, 3))), 6000);
  const notes = $("notes").value.trim();

  try {
    const res = await fetch("/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ image: currentPhoto.split(",")[1], mediaType: "image/jpeg", notes }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      await sb.auth.signOut();
      throw new Error("Please sign in again.");
    }
    if (!res.ok) {
      if (typeof data.remaining === "number") showQuota(data.remaining);
      throw new Error(data.error || "Something went wrong. Please try again.");
    }

    currentResult = data.result;
    showQuota(data.remaining);
    progress(4);
    renderResult($("result"), currentResult, currentPhoto);
    resultFrom = "scan";
    $("shareBtn").classList.toggle("hidden", !currentResult.is_plant);
    $("deleteScanBtn").classList.add("hidden");
    showStep("result");

    if (currentResult.is_plant) {
      saveScan(currentPhoto, currentResult, notes)
        .then(() => toast("Saved to My plants 🌱"))
        .catch((err) => {
          console.error(err);
          toast("Couldn't save this check to My plants.");
        });
    }
  } catch (err) {
    showStep("preview");
    toast(err.message === "Failed to fetch" ? "Couldn't reach Planty. Check your connection." : err.message);
  } finally {
    clearInterval(ticker);
  }
}
$("analyzeBtn").onclick = analyze;

// ---------- Saved checks ----------
function openSaved(scan, from) {
  if (!scan) return;
  currentScan = scan;
  currentResult = scan.result;
  currentPhoto = scan.photo_url;
  resultFrom = from;
  renderResult($("result"), scan.result, scan.photo_url, { date: scan.created_at });
  $("shareBtn").classList.toggle("hidden", !scan.result?.is_plant);
  $("deleteScanBtn").classList.remove("hidden");
  showView("scan");
  showStep("result");
}

$("deleteScanBtn").onclick = async () => {
  if (!currentScan || !confirm("Remove this check from My plants?")) return;
  try {
    await deleteScan(currentScan);
    toast("Removed");
    currentScan = null;
    showStep("home");
    showView(resultFrom === "garden" ? "garden" : "scan");
  } catch {
    toast("Couldn't remove it. Please try again.");
  }
};

$("shareBtn").onclick = () => {
  if (!currentResult?.is_plant) return;
  openComposer({ photo: currentPhoto, plantName: currentResult.plant.common_name });
};

// ---------- Start ----------
function enterApp() {
  document.body.classList.remove("booting");
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  closeSheets();
  showStep("home");
  showView("scan");
}

function leaveApp() {
  document.body.classList.remove("booting");
  currentPhoto = currentResult = currentScan = null;
  resetGarden();
  resetCommunity();
  closeSheets();
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
  window.scrollTo(0, 0);
}

initCommunity({ goToCommunity: () => showView("community") });
initAuth({ onSignedIn: enterApp, onSignedOut: leaveApp, onProfileChange: greet });
