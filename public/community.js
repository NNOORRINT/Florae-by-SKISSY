// Planty community: posts with photos, likes, replies and reports, stored in Supabase.
import { supabase as sb } from "./supabase.js";
import { $, esc, icon, toast, openSheet, closeSheets, fileToDataUrl, shrinkDataUrl, timeAgo, avatar, busy } from "./ui.js";
import { getSession, myName } from "./auth.js";

const BUCKET = "post-images";
const PAGE_SIZE = 30;

let goToCommunity = () => {};
let composePhoto = null; // photo (data URL or https URL) attached to the post being written
let openPostId = null;
let feedCache = [];
let myLikes = new Set();
let detailComments = [];

const me = () => getSession()?.user.id ?? null;
const count = (rel) => rel?.[0]?.count ?? 0;

export function resetCommunity() {
  feedCache = [];
  myLikes = new Set();
  openPostId = null;
  $("feed").innerHTML = "";
}

// ---------- Feed ----------
export async function showCommunity() {
  const feed = $("feed");
  if (!feedCache.length) feed.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  try {
    const { data, error } = await sb
      .from("posts")
      .select("*, comments(count), likes(count)")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (error) throw error;
    feedCache = data;

    myLikes = new Set();
    if (me() && data.length) {
      const { data: liked } = await sb.from("likes").select("post_id").eq("user_id", me()).in("post_id", data.map((p) => p.id));
      liked?.forEach((l) => myLikes.add(l.post_id));
    }
    renderFeed();
  } catch (err) {
    console.error(err);
    feed.innerHTML = `<div class="empty">${icon("chat")}<b>Couldn't load the community</b>Check your connection and try again.</div>`;
  }
}

function renderFeed() {
  const feed = $("feed");
  if (!feedCache.length) {
    feed.innerHTML = `<div class="empty">${icon("sprout")}<b>No posts yet</b>Be the first to share what you're growing.</div>`;
    return;
  }
  feed.innerHTML = feedCache.map((p) => postCard(p)).join("");
  bindPostActions(feed);
}

function postCard(p) {
  const liked = myLikes.has(p.id);
  const mine = p.user_id === me();
  return `
    <article class="post" data-id="${p.id}">
      <div class="post-head">
        ${avatar(p.author_name)}
        <div><b>${esc(p.author_name)}</b><span class="muted">${timeAgo(p.created_at)}</span></div>
        ${p.plant_name ? `<span class="post-tag">${icon("sprout")}${esc(p.plant_name)}</span>` : ""}
      </div>
      <p class="post-body">${esc(p.body)}</p>
      ${p.image_url ? `<img class="post-img" src="${esc(p.image_url)}" alt="" loading="lazy" />` : ""}
      <div class="post-actions">
        <button class="act like ${liked ? "liked" : ""}" data-id="${p.id}" aria-label="Like" aria-pressed="${liked}">${icon("heart")}<span>${count(p.likes) || ""}</span></button>
        <button class="act reply" data-id="${p.id}" aria-label="Replies">${icon("chat")}<span>${count(p.comments) || ""}</span></button>
        ${
          mine
            ? `<button class="act end delete" data-id="${p.id}" aria-label="Delete post">${icon("trash")}</button>`
            : `<button class="act end report" data-id="${p.id}" aria-label="Report post">${icon("flag")}</button>`
        }
      </div>
    </article>`;
}

function bindPostActions(root) {
  root.querySelectorAll(".post").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest(".like, .delete, .report")) return;
      if (!root.closest("#postSheet")) openPost(el.dataset.id);
    };
  });
  root.querySelectorAll(".like").forEach((b) => (b.onclick = () => toggleLike(b.dataset.id)));
  root.querySelectorAll(".delete").forEach((b) => (b.onclick = () => deletePost(b.dataset.id)));
  root.querySelectorAll(".report").forEach((b) => (b.onclick = () => reportPost(b.dataset.id)));
}

function rerender() {
  renderFeed();
  if (openPostId) renderPostDetail();
}

async function toggleLike(id) {
  const post = feedCache.find((p) => p.id === id);
  const wasLiked = myLikes.has(id);
  // Update the screen first, then save.
  wasLiked ? myLikes.delete(id) : myLikes.add(id);
  if (post) post.likes = [{ count: Math.max(0, count(post.likes) + (wasLiked ? -1 : 1)) }];
  rerender();
  const { error } = wasLiked
    ? await sb.from("likes").delete().eq("post_id", id).eq("user_id", me())
    : await sb.from("likes").insert({ post_id: id });
  if (error && error.code !== "23505") {
    // 23505 = already liked
    toast("Couldn't save your like.");
    wasLiked ? myLikes.add(id) : myLikes.delete(id);
    if (post) post.likes = [{ count: Math.max(0, count(post.likes) + (wasLiked ? 1 : -1)) }];
    rerender();
  }
}

async function deletePost(id) {
  if (!confirm("Delete this post?")) return;
  const { error } = await sb.from("posts").delete().eq("id", id);
  if (error) return toast("Couldn't delete the post.");
  const post = feedCache.find((p) => p.id === id);
  if (post?.image_url) {
    const path = post.image_url.split(`/${BUCKET}/`)[1];
    if (path) sb.storage.from(BUCKET).remove([decodeURIComponent(path)]);
  }
  feedCache = feedCache.filter((p) => p.id !== id);
  if (openPostId === id) closeSheets();
  openPostId = null;
  rerender();
  toast("Post deleted");
}

async function reportPost(id) {
  const reason = prompt("What's wrong with this post? (optional)\nE.g. spam, rude, dangerous advice");
  if (reason === null) return;
  const { error } = await sb.from("reports").insert({ post_id: id, reason: reason.trim().slice(0, 500) || null });
  if (error && error.code === "23505") return toast("You've already reported this post. Thank you.");
  if (error) return toast("Couldn't send the report. Please try again.");
  toast("Thanks. We'll take a look.");
}

// ---------- One post + replies ----------
async function openPost(id) {
  openPostId = id;
  detailComments = [];
  $("commentInput").value = "";
  openSheet("postSheet");
  renderPostDetail(true);
  const { data, error } = await sb.from("comments").select("*").eq("post_id", id).order("created_at", { ascending: true });
  if (error) return toast("Couldn't load replies.");
  detailComments = data;
  renderPostDetail();
}

function renderPostDetail(loading = false) {
  const p = feedCache.find((x) => x.id === openPostId);
  if (!p) return;
  const replies = loading
    ? `<p class="muted center pad">Loading replies…</p>`
    : detailComments.length
      ? detailComments
          .map(
            (c) => `<div class="comment">${avatar(c.author_name, "sm")}<div>
              <b>${esc(c.author_name)}</b> <span class="muted">${timeAgo(c.created_at)}</span>
              <p>${esc(c.body)}</p></div>
              ${c.user_id === me() ? `<button class="icon-btn tiny del-comment" data-id="${c.id}" aria-label="Delete reply">${icon("close")}</button>` : ""}
            </div>`
          )
          .join("")
      : `<p class="muted center pad">No replies yet. Share your experience!</p>`;
  $("postDetail").innerHTML = postCard(p) + `<div class="comments">${replies}</div>`;
  bindPostActions($("postDetail"));
  $("postDetail").querySelectorAll(".del-comment").forEach((b) => (b.onclick = () => deleteComment(b.dataset.id)));
}

async function deleteComment(id) {
  if (!confirm("Delete this reply?")) return;
  const { error } = await sb.from("comments").delete().eq("id", id);
  if (error) return toast("Couldn't delete the reply.");
  detailComments = detailComments.filter((c) => c.id !== id);
  const post = feedCache.find((p) => p.id === openPostId);
  if (post) post.comments = [{ count: Math.max(0, count(post.comments) - 1) }];
  rerender();
}

async function sendComment() {
  const body = $("commentInput").value.trim();
  if (!body || !openPostId) return;
  const btn = $("sendCommentBtn");
  btn.disabled = true;
  try {
    const { data, error } = await sb
      .from("comments")
      .insert({ post_id: openPostId, body, author_name: myName() })
      .select()
      .single();
    if (error) throw error;
    detailComments.push(data);
    $("commentInput").value = "";
    const post = feedCache.find((p) => p.id === openPostId);
    if (post) post.comments = [{ count: count(post.comments) + 1 }];
    rerender();
  } catch (err) {
    console.error(err);
    toast("Couldn't send your reply.");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Writing a post ----------
export function openComposer({ photo = null, plantName = "" } = {}) {
  composePhoto = photo;
  $("postBody").value = "";
  $("postPlant").value = plantName;
  $("composeAs").textContent = `Posting as ${myName()}`;
  renderComposePhoto();
  openSheet("composeSheet");
  setTimeout(() => $("postBody").focus(), 300);
}

function renderComposePhoto() {
  $("postPhotoWrap").classList.toggle("hidden", !composePhoto);
  $("addPhotoLabel").classList.toggle("hidden", !!composePhoto);
  if (composePhoto) $("postPhoto").src = composePhoto;
}

async function publish() {
  const body = $("postBody").value.trim();
  if (!body) {
    $("postBody").focus();
    return toast("Write a few words first 🙂");
  }
  const done = busy($("publishBtn"), "Posting…");
  try {
    let image_url = null;
    if (composePhoto) {
      const small = await shrinkDataUrl(composePhoto, 1280, 0.82);
      const blob = await (await fetch(small)).blob();
      const path = `${me()}/${crypto.randomUUID()}.jpg`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
      if (upErr) throw new Error("Couldn't upload the photo. Try again or post without it.");
      image_url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }

    const { error } = await sb.from("posts").insert({
      body,
      author_name: myName(),
      plant_name: $("postPlant").value.trim() || null,
      image_url,
    });
    if (error) throw error;

    closeSheets();
    composePhoto = null;
    toast("Posted! 🌱");
    goToCommunity();
  } catch (err) {
    console.error(err);
    toast(err.message?.startsWith("Couldn't") ? err.message : "Couldn't post. Please try again.");
  } finally {
    done();
  }
}

// ---------- Setup ----------
export function initCommunity(opts) {
  goToCommunity = opts.goToCommunity;
  $("composeBtn").onclick = () => openComposer();
  $("sendCommentBtn").onclick = sendComment;
  $("commentInput").onkeydown = (e) => e.key === "Enter" && sendComment();
  $("publishBtn").onclick = publish;
  $("postPhotoInput").onchange = async (e) => {
    try {
      composePhoto = await fileToDataUrl(e.target.files[0], 1280, 0.82);
      renderComposePhoto();
    } catch (err) {
      toast(err.message);
    }
    e.target.value = "";
  };
  $("removePhotoBtn").onclick = () => {
    composePhoto = null;
    renderComposePhoto();
  };
}
