// Small shared helpers: DOM, escaping, icons, toasts, bottom sheets, image resizing.
export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const label = (s) => String(s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// ---------- Icons (24×24 line icons) ----------
const PATHS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
  sprout: '<path d="M12 21V11"/><path d="M12 11C12 7 9 4 4 4c0 5 3 7 8 7z"/><path d="M12 13c0-3 2.5-6 8-6 0 4.5-3 6-8 6z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  soil: '<path d="M3 14h18"/><path d="M5 14l1.5 6h11L19 14"/><path d="M12 14V8"/><path d="M12 9c0-2 1.5-4 4-4 0 2.5-1.5 4-4 4z"/>',
  food: '<path d="M8 3h8l-1 5H9z"/><path d="M9 8l-3 13h12L15 8"/><path d="M10 14h4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  bug: '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M12 7V4M9 3.5l1.5 3.5M15 3.5L13.5 7M8 11H4M8 16H4M16 11h4M16 16h4"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
  thermo: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/>',
  bandage: '<rect x="2" y="8" width="20" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M10 10h.01M14 14h.01M10 14h.01M14 10h.01"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  eyeOff: '<path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',
};
export const icon = (name, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ""}</svg>`;

// Fill every <span data-icon="name"> on the page.
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}

// ---------- Show / hide password ----------
function setPasswordVisible(input, btn, show) {
  input.type = show ? "text" : "password";
  btn.innerHTML = icon(show ? "eyeOff" : "eye");
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  btn.setAttribute("aria-pressed", String(show));
}

// Add an eye button to every password field (once per field).
export function addPasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]:not([data-pw])').forEach((input) => {
    input.dataset.pw = "1";
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle";
    setPasswordVisible(input, btn, false);
    btn.addEventListener("click", () => {
      const end = input.selectionEnd;
      setPasswordVisible(input, btn, input.type === "password");
      input.focus();
      try {
        input.setSelectionRange(end, end);
      } catch {
        /* some browsers refuse on type switch */
      }
    });
    wrap.appendChild(btn);
  });
}

// Hide every revealed password again (when a form resets or closes).
export function hidePasswords(root = document) {
  root.querySelectorAll("input[data-pw]").forEach((input) => {
    const btn = input.parentNode.querySelector(".pw-toggle");
    if (btn) setPasswordVisible(input, btn, false);
  });
}

// ---------- Toast ----------
let toastTimer;
export function toast(msg, ms = 3400) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------- Bottom sheets ----------
export function openSheet(id) {
  document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open"));
  $("sheetBackdrop")?.classList.remove("hidden");
  $(id).classList.add("open");
}
export function closeSheets() {
  hidePasswords();
  document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open"));
  $("sheetBackdrop")?.classList.add("hidden");
}
$("sheetBackdrop")?.addEventListener("click", closeSheets);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheets());
document.querySelectorAll("[data-close-sheet]").forEach((b) => b.addEventListener("click", closeSheets));

// ---------- Busy buttons ----------
export function busy(btn, text) {
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = text;
  return () => {
    btn.disabled = false;
    btn.innerHTML = prev;
  };
}

// ---------- Images ----------
// Read an image file and shrink it to at most `max` px on its longest side.
export function fileToDataUrl(file, max = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("Please choose an image file."));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(resizeImage(img, img.naturalWidth, img.naturalHeight, max, quality));
    };
    img.onerror = () => reject(new Error("Couldn't read that image. Try a JPEG or PNG."));
    img.src = URL.createObjectURL(file);
  });
}

export function resizeImage(source, w, h, max, quality = 0.85) {
  const c = document.createElement("canvas");
  const scale = Math.min(1, max / Math.max(w, h));
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

// Shrink a data URL or an https image URL. Falls back to the original on failure.
export function shrinkDataUrl(src, max, quality = 0.75) {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        resolve(resizeImage(img, img.naturalWidth, img.naturalHeight, max, quality));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// ---------- Dates ----------
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
export const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// ---------- Avatars ----------
const AVATAR_COLORS = ["#27412e", "#5b6b4a", "#8a5a3c", "#46606e", "#6e5468", "#8a6a2c", "#3e625a"];
export function avatar(name, cls = "") {
  const n = String(name || "?");
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return `<span class="avatar ${cls}" style="background:${color}">${esc([...n.trim()][0]?.toUpperCase() || "?")}</span>`;
}
