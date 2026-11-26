// Accounts: sign in, sign up, password reset, profile and the account sheet.
import { supabase as sb } from "./supabase.js";
import { $, esc, toast, openSheet, closeSheets, avatar, busy, addPasswordToggles, hidePasswords } from "./ui.js";
import { GOOGLE_SIGN_IN } from "./config.js";

let mode = "signin";
let session = null;
let profile = null;
let hooks = { onSignedIn() {}, onSignedOut() {}, onProfileChange() {} };

export const getSession = () => session;
export const getProfile = () => profile;
export const myName = () => profile?.display_name || session?.user.email?.split("@")[0] || "Grower";

export async function authHeader() {
  const { data } = await sb.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

// ---------- Sign-in dialog (on the landing page) ----------
export function openAuth(m = "signin") {
  setMode(m);
  $("authDialog").classList.remove("hidden");
  document.body.classList.add("dialog-open");
  setTimeout(() => (m === "signup" ? $("authName") : $("authEmail")).focus(), 50);
}
export function closeAuth() {
  hidePasswords();
  $("authDialog").classList.add("hidden");
  document.body.classList.remove("dialog-open");
}

// ---------- Sign-in form ----------
const COPY = {
  signin: { title: "Welcome back", sub: "Sign in to check a plant or see your saved ones.", submit: "Sign in" },
  signup: { title: "Create your account", sub: "Free. Ten plant checks a day.", submit: "Create account" },
  forgot: { title: "Reset your password", sub: "We'll email you a link to choose a new one.", submit: "Send reset link" },
};

function setMode(m) {
  mode = m;
  hidePasswords();
  const c = COPY[m];
  $("authTitle").textContent = c.title;
  $("authSub").textContent = c.sub;
  $("authSubmit").textContent = c.submit;
  document.querySelectorAll("#authForm [data-show]").forEach((el) =>
    el.classList.toggle("hidden", !el.dataset.show.split(" ").includes(m))
  );
  document.querySelectorAll("#authSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("authSeg").classList.toggle("hidden", m === "forgot");
  $("googleWrap").classList.toggle("hidden", !GOOGLE_SIGN_IN || m === "forgot");
  $("forgotBtn").textContent = m === "forgot" ? "Back to sign in" : "Forgot your password?";
  $("forgotBtn").classList.toggle("hidden", m === "signup");
  $("authPassword").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("authCard").classList.remove("hidden");
  $("authSent").classList.add("hidden");
  showError("");
}

function showError(msg) {
  $("authError").textContent = msg;
  $("authError").classList.toggle("hidden", !msg);
}

function friendly(err) {
  const m = String(err?.message || "");
  if (err?.status === 429 || /rate limit|too many/i.test(m)) return "Too many attempts. Please wait a minute and try again.";
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again, or reset your password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for our link.";
  if (/already registered|already been registered/i.test(m)) return "There's already an account with this email. Try signing in.";
  if (/anonymous/i.test(m)) return "Something went wrong. Please refresh and try again.";
  if (/fetch|network/i.test(m)) return "Couldn't connect. Check your internet and try again.";
  return m || "Something went wrong. Please try again.";
}

function showSent(email, kind) {
  $("sentTitle").textContent = "Check your inbox";
  $("sentText").innerHTML =
    kind === "reset"
      ? `If <b>${esc(email)}</b> has an account, we've sent a link to set a new password.`
      : `We sent a confirmation link to <b>${esc(email)}</b>. Open it on this device to finish creating your account.`;
  $("authCard").classList.add("hidden");
  $("authSent").classList.remove("hidden");
}

async function submit(e) {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const name = $("authName").value.trim().replace(/\s+/g, " ");

  if (mode === "signup" && !name) return showError("Please tell us your name.");
  if (!/^\S+@\S+\.\S+$/.test(email)) return showError("Please enter a valid email address.");
  if (mode === "signin" && !password) return showError("Please enter your password.");
  if (mode === "signup" && password.length < 8) return showError("Please choose a password with at least 8 characters.");
  showError("");

  const done = busy($("authSubmit"), mode === "forgot" ? "Sending…" : "One moment…");
  try {
    if (mode === "signin") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else if (mode === "signup") {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { name: name.slice(0, 40) }, emailRedirectTo: location.origin },
      });
      if (error) throw error;
      if (!data.session) showSent(email, "confirm");
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      if (error) throw error;
      showSent(email, "reset");
    }
  } catch (err) {
    console.error(err);
    showError(friendly(err));
  } finally {
    done();
  }
}

// ---------- Profile ----------
async function loadProfile() {
  const user = session.user;
  const fallback = (user.user_metadata?.name || user.user_metadata?.full_name || user.email?.split("@")[0] || "Grower").slice(0, 40);
  const { data, error } = await sb.from("profiles").select("id, display_name").eq("id", user.id).maybeSingle();
  if (error) {
    console.warn("Profiles table not ready (run supabase/002_accounts.sql):", error.message);
    profile = { id: user.id, display_name: fallback };
    return;
  }
  if (data) {
    profile = data;
    return;
  }
  const { data: created } = await sb.from("profiles").insert({ id: user.id, display_name: fallback }).select().maybeSingle();
  profile = created || { id: user.id, display_name: fallback };
}

// ---------- Account sheet ----------
export async function openAccount() {
  $("accountAvatar").innerHTML = avatar(myName(), "lg");
  $("accountTitle").textContent = myName();
  $("accountEmail").textContent = session?.user.email || "";
  $("accountName").value = myName();
  $("accountQuota").innerHTML = "";
  openSheet("accountSheet");
  const { data, error } = await sb.rpc("scan_quota");
  if (!error && typeof data === "number") {
    $("accountQuota").innerHTML = `<b>${data}</b><span>free plant check${data === 1 ? "" : "s"} left today.<br />Resets every day at midnight UTC.</span>`;
  }
}

async function saveName() {
  const name = $("accountName").value.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return $("accountName").focus();
  const done = busy($("saveNameBtn"), "Saving…");
  const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", session.user.id);
  done();
  if (error) return toast("Couldn't save your name. Please try again.");
  profile = { ...profile, display_name: name };
  $("accountTitle").textContent = name;
  $("accountAvatar").innerHTML = avatar(name, "lg");
  hooks.onProfileChange();
  toast("Name saved");
}

async function savePassword() {
  const password = $("newPassword").value;
  if (password.length < 8) return toast("Please use at least 8 characters.");
  const done = busy($("savePasswordBtn"), "Saving…");
  const { error } = await sb.auth.updateUser({ password });
  done();
  if (error) return toast(friendly(error));
  $("newPassword").value = "";
  closeSheets();
  toast("Password updated");
}

// ---------- Session changes ----------
async function handle(event, s) {
  const user = s?.user;

  // Old versions of Florae used anonymous "nickname" sessions; those can't be used any more.
  if (user?.is_anonymous) {
    await sb.auth.signOut();
    return;
  }

  if (user) {
    const isNew = session?.user.id !== user.id;
    session = s;
    if (isNew) {
      closeAuth();
      await loadProfile();
      hooks.onSignedIn();
    }
    if (event === "PASSWORD_RECOVERY") {
      openSheet("passwordSheet");
      setTimeout(() => $("newPassword").focus(), 300);
    }
    return;
  }

  session = null;
  profile = null;
  setMode("signin");
  hooks.onSignedOut();
  // Links that need an account (e.g. /#community from the wiki) open the sign-in dialog.
  if (["#community", "#garden", "#signin"].includes(location.hash)) openAuth("signin");
}

export function initAuth(opts) {
  hooks = { ...hooks, ...opts };
  addPasswordToggles();

  // Errors from email links, e.g. an expired confirmation link.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("error_description")) {
    const msg = hash.get("error_description").replace(/\+/g, " ") + ". Please try again.";
    setTimeout(() => {
      openAuth("signin");
      showError(msg);
    }, 600);
    history.replaceState(null, "", location.pathname);
  }

  $("authForm").addEventListener("submit", submit);
  document.querySelectorAll("[data-auth]").forEach((b) => (b.onclick = () => openAuth(b.dataset.auth)));
  document.querySelectorAll("[data-auth-close]").forEach((b) => (b.onclick = closeAuth));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !$("authDialog").classList.contains("hidden") && closeAuth());
  document.querySelectorAll("#authSeg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("forgotBtn").onclick = () => setMode(mode === "forgot" ? "signin" : "forgot");
  $("sentBack").onclick = () => setMode("signin");
  $("googleBtn").onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } });
    if (error) showError(friendly(error));
  };
  $("saveNameBtn").onclick = saveName;
  $("accountName").onkeydown = (e) => e.key === "Enter" && saveName();
  $("savePasswordBtn").onclick = savePassword;
  $("signOutBtn").onclick = async () => {
    closeSheets();
    await sb.auth.signOut();
  };
  setMode("signin");

  // Don't call Supabase inside this callback directly (it can deadlock); defer instead.
  sb.auth.onAuthStateChange((event, s) => setTimeout(() => handle(event, s), 0));
}
