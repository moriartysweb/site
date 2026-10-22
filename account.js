// The account for every app on killer-serials.com: sign-in, saved preferences, bookmarks.
// An app opts in by defining window.accountApp before this script runs.
(function (root) {
"use strict";

const SIX_MONTHS = 180 * 864e5;

// ---- decisions, kept pure so web/checks/account.js can test them --------------
// What is set to something other than its default. `same` says, key by key, when a value is only the
// default written out (return null) -- a setting never touched and one saved as its default are the same.
function tidy(raw, same) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = same && same[k] ? same[k](v, raw) : v;
    if (t !== null && t !== undefined) out[k] = t;
  }
  return out;
}
function snapshot(storage, keys, same) {
  const raw = {};
  for (const k of keys) { const v = storage.getItem(k); if (v !== null) raw[k] = v; }
  return tidy(raw, same);
}
function differs(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
}
const isPrefs = v => v !== null && typeof v === "object" && !Array.isArray(v);
// A key that is absent is at its default, so "device has changes" means "device has keys".
function plan(device, saved) {
  if (!isPrefs(saved)) return Object.keys(device).length ? "push" : "none";
  if (!differs(device, saved).length) return "none";
  return Object.keys(device).length ? "ask" : "load";
}
function apply(storage, keys, saved) {
  for (const k of keys) {
    if (k in saved) storage.setItem(k, saved[k]); else storage.removeItem(k);
  }
}
function expired(signedInAt, now) {
  return Number.isFinite(signedInAt) && now - signedInAt > SIX_MONTHS;
}
// While the reader is being asked which set to keep, nothing may be written to the account.
function shouldPush(snap, lastPushed, asking) {
  return !asking && differs(snap, lastPushed).length > 0;
}

// The page address without the one-time ?code= that a sign-in return trip leaves behind.
function withoutCode(href) {
  const u = new URL(href);
  u.searchParams.delete("code");
  return u.toString();
}

// Plain text only: control characters and angle brackets go, whitespace collapses, length is capped.
function cleanText(s, max) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(t).slice(0, max).join("");
}
// A stored link is only ever shown as a link when it is http(s) and on this site (or the page's own host).
function safeUrl(u, origin) {
  try {
    const link = new URL(u), here = new URL(origin);
    if (!/^https?:$/.test(link.protocol)) return null;
    return [here.hostname, "killer-serials.com"].includes(link.hostname) ? link.href : null;
  } catch (e) { return null; }
}
function tagCounts(rows) {
  const n = new Map();
  let untagged = 0;
  for (const r of rows) { if (r.project) n.set(r.project, (n.get(r.project) || 0) + 1); else untagged++; }
  return {tags: [...n].sort((a, b) => a[0].localeCompare(b[0])), untagged};
}

if (typeof window === "undefined") {
  module.exports = {cleanText, safeUrl, tagCounts, withoutCode, tidy, snapshot, differs, isPrefs, plan, apply, expired, shouldPush, SIX_MONTHS};
  return;
}
const cfg = window.accountApp;
if (!cfg) return;
const URL_ = "https://lrmaaozvhmgqbcdvzndq.supabase.co", KEY = "sb_publishable_4_tFYOO2aWapS0mJ6QCmHg_QVZMn9Ft";
const SUPABASE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js";
const SIGNED_IN_AT = "account.signedInAt", RETURN = "account.returnHash";
const keys = cfg.keys, group = cfg.group || cfg.app, same = cfg.same || {};
const NO_QUOTE = "account.noquote";
let db = null, me = null, asking = false, recovering = false, mode = "in", note = "";
let lastPushed = {}, timer = 0, saved = null, held = false, loading = false;

const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = EYE.replace("</svg>", '<path d="M3 3l18 18"/></svg>');
const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.8.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.96 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/></svg>';
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const kept = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not kept */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* not kept */ } },
};
const load = src => new Promise((ok, no) => {
  const s = document.createElement("script");
  s.src = src; s.onload = ok; s.onerror = no;
  document.head.appendChild(s);
});

// ---- the bar and its dialog ---------------------------------------------------
const style = document.createElement("style");
style.textContent = `
.acct{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 14px;font:13px/1.4 system-ui,sans-serif;color:var(--ink-soft,#555)}
.acct button,.acctd button{font:inherit;padding:5px 12px;border:1px solid var(--rule,#bbb);border-radius:6px;background:var(--ground,#fff);color:var(--ink,#222);cursor:pointer}
.acctd{width:min(380px,92vw);box-sizing:border-box;border:1px solid var(--rule,#bbb);border-radius:10px;padding:18px;background:var(--ground,#fff);color:var(--ink,#222);font:14px/1.45 system-ui,sans-serif}
.acctd::backdrop{background:#0006}
.acctd h2{margin:0 0 10px;font-size:16px}
.acctd label{display:block;margin:8px 0 2px;font-size:12.5px}
.acctd input{width:100%;box-sizing:border-box;padding:7px;font:inherit;border:1px solid var(--rule,#bbb);border-radius:6px;background:inherit;color:inherit}
.acctd .pw{position:relative;display:block}
.acctd .pw input{padding-right:38px}
.acctd .pw button{position:absolute;right:3px;top:50%;transform:translateY(-50%);padding:4px 6px;border:0;background:none;line-height:0}
.acctd .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.acctd .say{min-height:1.3em;margin:8px 0 0;color:var(--ink-soft,#a33)}
.acctd ul{margin:6px 0;padding:0;list-style:none;max-height:40vh;overflow:auto}
.acctd li{display:flex;gap:8px;justify-content:space-between;align-items:center;padding:4px 0}
.acctd .aw-fig{margin:6px 0 0}
.acctd .aw-q{margin:0;font:italic 400 20px/1.45 Georgia,"Times New Roman",serif;min-height:4.4em}
.acctd .aw-q::before{content:"\\201C"}.acctd .aw-q.aw-done::after{content:"\\201D"}
.acctd .aw-q:not(.aw-done)::after{content:"\\258D";opacity:.5}
.acctd .aw-cite{margin-top:8px;font-size:13px}
.acctd .aw-cite a{color:inherit;text-underline-offset:3px}
.acctd .aw-foot{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-top:14px;font-size:13px}
.acctd .aw-foot label{display:flex;gap:7px;align-items:center;cursor:pointer}
.acctd .aw-foot input[type=checkbox]{width:auto;flex:none;padding:0;margin:0}
.acctd .aw-foot label{margin:0}
.acctd .gbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:42px;padding:0 12px;border:1px solid #dadce0;border-radius:4px;background:#fff;color:#3c4043;font:500 14px/1 Roboto,"Helvetica Neue",Arial,sans-serif;cursor:pointer}
.acctd .gbtn:hover{background:#f8f9fa;border-color:#d2e3fc}
.acctd .gbtn:focus-visible{outline:2px solid #4285F4;outline-offset:2px}
.acctd .or{display:flex;align-items:center;gap:12px;margin:14px 0 4px;color:var(--ink-soft,#666);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.acctd .or::before,.acctd .or::after{content:"";flex:1;height:1px;background:var(--rule,#ccc)}
.acctd .alt{margin:10px 0 0}
.acctd .linkbtn{border:0;background:none;padding:0;color:inherit;font:inherit;font-size:13px;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.acctd .tagrow{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.acctd .tagchip{padding:3px 9px;border-radius:999px}
.acctd .tagchip[aria-pressed=true]{background:var(--ink,#222);color:var(--ground,#fff)}
.acctd .tagtext{color:var(--ink-soft,#666);margin-left:6px}
.acctd h3{margin:10px 0 2px;font-size:12.5px;text-transform:uppercase;letter-spacing:.06em}
`;
document.head.appendChild(style);

const bar = document.createElement("div");
bar.className = "acct";
bar.hidden = true;                       // shown once Supabase has loaded
document.body.insertBefore(bar, document.body.firstChild);
const dlg = document.createElement("dialog");
dlg.className = "acctd";
document.body.appendChild(dlg);
// Esc must not leave a pending "which set do you keep" question unanswered.
dlg.addEventListener("cancel", e => { if (asking || loading) e.preventDefault(); });

function paintBar() {
  bar.innerHTML = me
    ? `<span>Welcome, ${esc(me.user_metadata.username || me.email)}</span><button type="button" data-a="open">Account</button>`
    : `<button type="button" data-a="open">Sign in</button><span>Sign in to bookmark passages and store your preferences across sessions</span>`;
}
bar.addEventListener("click", e => { if (e.target.closest("[data-a=open]")) openDialog(); });

function openDialog(say) {
  if (say !== undefined) note = say;
  dlg.innerHTML = me ? accountView() : formView();
  if (!dlg.open) dlg.showModal();
  if (me) listBookmarks();
}
function formView() {
  const up = mode === "up";
  return `<h2>${up ? "Create an account" : "Sign in"}</h2>
    <button type="button" class="gbtn" data-a="google">${GOOGLE_G}<span>Continue with Google</span></button>
    <div class="or" role="separator">or</div>
    <form data-f="auth"><p class="say" data-say>${esc(note)}</p>
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    ${up ? `<label>Username (optional)<input name="username" autocomplete="nickname"></label>` : ""}
    <label>Password<span class="pw"><input name="password" type="password" required minlength="8" autocomplete="${up ? "new-password" : "current-password"}">
      <button type="button" data-a="peek" aria-label="Show password" aria-pressed="false">${EYE}</button></span></label>
    <p class="alt"><button type="button" class="linkbtn" data-a="magic">Email me a login link instead of a password</button>
      ${up ? "" : ` &middot; <button type="button" class="linkbtn" data-a="forgot">Forgot your password?</button>`}</p>
    <div class="row"><button type="submit">${up ? "Create account" : "Sign in"}</button>
      <button type="button" data-a="mode">${up ? "I have an account" : "Create an account"}</button>
      <button type="button" data-a="close">Cancel</button></div></form>`;
}
// Reached by the link in a password-reset email: the library has signed the reader in for this one purpose.
function openRecovery() {
  recovering = true;
  dlg.innerHTML = `<h2>Choose a new password</h2>
    <form data-f="newpass"><p class="say" data-say></p>
    <label>New password<span class="pw"><input name="password" type="password" required minlength="8" autocomplete="new-password">
      <button type="button" data-a="peek" aria-label="Show password" aria-pressed="false">${EYE}</button></span></label>
    <div class="row"><button type="submit">Save password</button></div></form>`;
  if (!dlg.open) dlg.showModal();
}
function accountView() {
  // Google accounts arrive without a username; this is where they set one (it is also how it is changed).
  return `<h2>Account</h2><p class="say" data-say>${esc(note)}</p>
    <form data-f="name"><label>Username<input name="username" maxlength="40" autocomplete="nickname"
      value="${esc(me.user_metadata.username || "")}" placeholder="${esc(me.email)}"></label>
      <div class="row"><button type="submit">Save username</button></div></form>
    <div data-extra></div>
    <div class="row"><button type="button" data-a="out">Sign out</button><button type="button" data-a="close">Close</button></div>`;
}
const say = t => { note = t; const el = dlg.querySelector("[data-say]"); if (el) el.textContent = t; };

dlg.addEventListener("click", async e => {
  const el = e.target.closest("[data-a]");
  if (!el) return;
  const act = el.dataset.a;
  if (act === "close") dlg.close();
  else if (act === "mode") { mode = mode === "in" ? "up" : "in"; note = ""; openDialog(); }
  else if (act === "google") {
    try { sessionStorage.setItem(RETURN, location.hash); } catch (e) { /* not kept */ }
    const {error} = await db.auth.signInWithOAuth({provider: "google",
      options: {redirectTo: location.origin + location.pathname}});
    if (error) say(error.message);
  }
  else if (act === "magic") {
    // A link to click, no password: it signs the reader in, and makes the account if there is none yet.
    const email = (dlg.querySelector("input[name=email]").value || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say("Enter your email address first.");
    say("Sending\u2026");
    const {error} = await db.auth.signInWithOtp({email, options: {emailRedirectTo: location.origin + location.pathname}});
    if (error) return say(error.message);
    dlg.innerHTML = `<h2>Check your email</h2>
      <p>We sent a login link to <b>${esc(email)}</b>. Open it in this browser to sign in; there is no password to remember.</p>
      <p>You can keep using the search in the meantime.</p>
      <div class="row"><button type="button" data-a="close">Keep searching</button></div>`;
  }
  else if (act === "forgot") {
    const email = (dlg.querySelector("input[name=email]").value || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say("Enter your email address first.");
    say("Sending\u2026");
    const {error} = await db.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
    if (error) return say(error.message);
    dlg.innerHTML = `<h2>Check your email</h2>
      <p>If <b>${esc(email)}</b> has an account, we sent a link to choose a new password. Open it in this browser.</p>
      <div class="row"><button type="button" data-a="close">Keep searching</button></div>`;
  }
  else if (act === "peek") {
    const input = dlg.querySelector("input[name=password]"), on = input.type === "password";
    input.type = on ? "text" : "password";
    el.setAttribute("aria-pressed", String(on));
    el.setAttribute("aria-label", on ? "Hide password" : "Show password");
    el.innerHTML = on ? EYE_OFF : EYE;
  }
  else if (act === "out") { await db.auth.signOut(); dlg.close(); }
  else if (act === "load-now") startLoading();
  else if (act === "load-later") { dlg.close(); }          // sync stays paused this visit, so nothing is overwritten
  else if (act === "skip") reloadWithSaved();
  else if (act === "noquote") { if (el.checked) kept.set(NO_QUOTE, "1"); else kept.del(NO_QUOTE); }
  else if (act === "keep-mine") {
    await pushPrefs(here());
    asking = false; dlg.close(); startPolling();
  }
  else if (act === "tag" || act === "tag-all") { tagFilter = act === "tag" ? el.dataset.tag : null; paintBookmarks(); }
  else if (act === "del") { await db.from("bookmarks").delete().eq("id", el.dataset.id); listBookmarks(); }
});
dlg.addEventListener("submit", async e => {
  const f = e.target.closest("form");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  if (f.dataset.f === "auth") {
    const res = mode === "up"
      ? await db.auth.signUp({email: v.email, password: v.password,
          options: {data: v.username ? {username: v.username.trim()} : {}, emailRedirectTo: location.origin + location.pathname}})
      : await db.auth.signInWithPassword({email: v.email, password: v.password});
    if (res.error) return say(res.error.message);
    if (mode === "up" && !res.data.session) {
      dlg.innerHTML = `<h2>Check your email</h2>
        <p>We sent a verification email to <b>${esc(v.email)}</b>. Follow the link in it to finish creating your account, then sign in.</p>
        <p>You can keep using the search in the meantime, but until you are signed in your settings and bookmarks are not saved to your account and may be lost.</p>
        <div class="row"><button type="button" data-a="close">Keep searching</button></div>`;
      return;
    }
    if (!asking) dlg.close();
  } else if (f.dataset.f === "newpass") {
    const {error} = await db.auth.updateUser({password: v.password});
    if (error) return say(error.message);
    recovering = false;
    dlg.innerHTML = `<h2>Password updated</h2><p>You are signed in with your new password.</p>
      <div class="row"><button type="button" data-a="close">Keep searching</button></div>`;
  } else if (f.dataset.f === "name") {
    const {error} = await db.auth.updateUser({data: {username: v.username.trim()}});
    say(error ? error.message : "Username saved.");
  }
});

// ---- preferences --------------------------------------------------------------
async function pushPrefs(snap) {
  const {error} = await db.from("app_prefs").upsert(
    {user_id: me.id, app: group, prefs: snap, updated_at: new Date().toISOString()});
  if (!error) lastPushed = snap;         // on failure the next tick tries again
}

// What this device is set to, and what the account holds, with a default written out counted as no setting.
const here = () => snapshot(localStorage, keys, same);
const theirs = () => isPrefs(saved) ? tidy(saved, same) : saved;

async function onSignedIn() {
  const {data, error} = await db.from("app_prefs").select("prefs").eq("app", group).maybeSingle();
  if (error) return;                     // unreachable is not "nothing saved": never overwrite on a failed read
  saved = data ? data.prefs : null;
  const device = here(), what = plan(device, theirs());
  // Nothing is shown unless the two really differ; and the page is never reloaded without being asked.
  if (what === "load") { held = true; return offerLoad(); }
  if (what === "ask") { asking = true; return askWhich(device); }
  if (what === "push") await pushPrefs(device);
  else if (isPrefs(saved)) lastPushed = theirs();
  startPolling();
}
function onSignedOut() { clearInterval(timer); lastPushed = {}; saved = null; asking = false; held = false; }

// A tick costs nothing when nothing changed, and no call site in the app has to know about sync.
function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    const snap = here();
    if (me && shouldPush(snap, lastPushed, asking || held)) pushPrefs(snap);
  }, 5000);
}

// The account has settings this device is not using. Asked, not assumed: applying them reloads the page.
function offerLoad() {
  if (recovering) return;
  dlg.innerHTML = `<h2>Your saved settings</h2>
    <p>Your account has display settings saved that this device is not using yet. Load them now? The page reloads to apply them.</p>
    <div class="row"><button type="button" data-a="load-now">Load my settings</button>
    <button type="button" data-a="load-later">Not now</button></div>`;
  if (!dlg.open) dlg.showModal();
}

function askWhich(device) {
  if (recovering) return;                // choosing a password comes first; the question comes at the next visit
  const names = differs(device, theirs()).map(k => esc((cfg.labels && cfg.labels[k]) || k));
  dlg.innerHTML = `<h2>Your preferences differ</h2>
    <p>This device is set differently from your saved preferences. They differ in: ${names.join(", ")}.</p>
    <div class="row"><button type="button" data-a="load-now">Use my saved preferences</button>
    <button type="button" data-a="keep-mine">Keep these and save them to my account</button></div>`;
  if (!dlg.open) dlg.showModal();
}

// Applying them: the reader reads its settings at startup, so the page starts over. A window in front, a
// quote typed out to read meanwhile, and a few seconds so it is not a flash; Dismiss goes straight on.
let reloadTimer = 0;
function reloadWithSaved() {
  clearTimeout(reloadTimer);
  apply(localStorage, keys, saved);
  // storage that will not hold them would reload forever
  if (differs(here(), theirs()).length) { loading = false; return say("This browser would not keep them."); }
  location.reload();
}
function startLoading() {
  loading = true; asking = false;
  const quotes = root.accountQuotes || [];
  if (kept.get(NO_QUOTE) || !quotes.length) { dlg.innerHTML = `<h2>Loading your saved settings\u2026</h2>`; reloadTimer = setTimeout(reloadWithSaved, 600); return; }
  const [text, cite, href] = quotes[Math.floor(Math.random() * quotes.length)];
  dlg.innerHTML = `<h2>Loading your saved settings\u2026</h2>
    <figure class="aw-fig"><blockquote class="aw-q"><span class="aw-t"></span></blockquote>
    <figcaption class="aw-cite" hidden><a class="aw-link" href="${esc(href)}">${esc(cite)}</a></figcaption></figure>
    <div class="aw-foot"><label><input type="checkbox" data-a="noquote"> Don&rsquo;t show this again</label>
    <button type="button" data-a="skip">Dismiss</button></div>`;
  const t = dlg.querySelector(".aw-t"), q = dlg.querySelector(".aw-q");
  let i = 0;
  const step = () => {
    if (!loading) return;
    t.textContent = text.slice(0, ++i);
    if (i < text.length) reloadTimer = setTimeout(step, 14 + Math.random() * 22);
    else { q.classList.add("aw-done"); dlg.querySelector(".aw-cite").hidden = false; reloadTimer = setTimeout(reloadWithSaved, 2200); }
  };
  step();
}

// ---- bookmarks ----------------------------------------------------------------
const LAST_TAG = "account.lastTag";
let marks = [], tagFilter = null;        // tagFilter: null is all, "" is untagged, else a tag

// For an app's own "bookmark here" control. A tag is plain text, and the same tag is offered next time.
async function saveBookmark({url, label, tag}) {
  if (!me) return {signedOut: true};
  const link = safeUrl(url, location.origin), name = cleanText(label, 200), project = cleanText(tag, 40) || null;
  if (!link || !name) return {error: "That passage cannot be bookmarked."};
  const {error} = await db.from("bookmarks").insert({app: cfg.app, url: link, label: name, project});
  if (error) return {error: error.message};
  if (project) kept.set(LAST_TAG, project); else kept.del(LAST_TAG);
  return {ok: true};
}

async function listBookmarks() {
  const {data, error} = await db.from("bookmarks").select("*").order("created_at", {ascending: false});
  if (error) { marks = []; return paintBookmarks(); }
  marks = data;
  paintBookmarks();
}
function paintBookmarks() {
  const box = dlg.querySelector("[data-extra]");
  if (!box) return;
  if (!marks.length) { box.innerHTML = "<p>No bookmarks yet.</p>"; return; }
  const {tags, untagged} = tagCounts(marks);
  if (tagFilter !== null && !(tagFilter === "" ? untagged : tags.some(t => t[0] === tagFilter))) tagFilter = null;
  const chip = (label, value, n) =>
    `<button type="button" class="tagchip" data-a="${value === null ? "tag-all" : "tag"}" data-tag="${esc(value === null ? "" : value)}" aria-pressed="${tagFilter === value}">${esc(label)} <small>${n}</small></button>`;
  const shown = marks.filter(b => tagFilter === null || (b.project || "") === tagFilter);
  box.innerHTML = `<div class="tagrow">${chip("All", null, marks.length)}`
    + tags.map(([t, n]) => chip(t, t, n)).join("") + (untagged ? chip("No tag", "", untagged) : "") + `</div><ul>`
    + shown.map(b => {
        const href = safeUrl(b.url, location.origin);
        return `<li>${href ? `<a href="${esc(href)}">${esc(b.label)}</a>` : `<span>${esc(b.label)}</span>`}`
          + (b.project ? ` <small class="tagtext">${esc(b.project)}</small>` : "")
          + `<button type="button" data-a="del" data-id="${esc(b.id)}" aria-label="Delete bookmark">\u00D7</button></li>`;
      }).join("") + `</ul>`;
}

// ---- session ------------------------------------------------------------------
function onAuth(event, session) {
  if (session && expired(parseInt(kept.get(SIGNED_IN_AT), 10), Date.now())) {
    // Local only, so the other devices stay signed in; the stamp goes too or the next sign-in is refused.
    kept.del(SIGNED_IN_AT);
    db.auth.signOut({scope: "local"}).catch(() => {});
    session = null;                      // local preferences stay as they are
  }
  const was = me;
  me = session ? session.user : null;
  if (me && kept.get(SIGNED_IN_AT) === null) kept.set(SIGNED_IN_AT, String(Date.now()));
  if (!me) kept.del(SIGNED_IN_AT);
  paintBar();
  if (event === "PASSWORD_RECOVERY" && me) openRecovery();
  if (me && !was) onSignedIn(); else if (!me && was) onSignedOut();
  if (event !== "INITIAL_SESSION" && Boolean(me) !== Boolean(was)) document.dispatchEvent(new Event("accountchange"));
}

root.Account = {
  open: () => openDialog(), user: () => me, saveBookmark,
  lastTag: () => kept.get(LAST_TAG) || "",
  prompt: say => { mode = "in"; openDialog(say); },      // the sign-in dialog, with a reason
  client: () => db,                                      // for the serial reader (web/src/serial.js)
};

load(SUPABASE).then(async () => {
  db = root.supabase.createClient(URL_, KEY, {auth: {flowType: "pkce"}});
  // listening first: a password-reset link's event is sent while getSession() exchanges the returning ?code=
  db.auth.onAuthStateChange(onAuth);
  const {data} = await db.auth.getSession();
  if (/[?&]code=/.test(location.search)) {
    history.replaceState(null, "", withoutCode(location.href));
    // Google's trip back drops the #go= spot; put it back, once.
    let was = null;
    try { was = sessionStorage.getItem(RETURN); sessionStorage.removeItem(RETURN); } catch (e) { /* not kept */ }
    if (was && !location.hash) { location.hash = was; location.reload(); return; }
  }
  onAuth("INITIAL_SESSION", data.session);
  paintBar();
  bar.hidden = false;
  document.documentElement.classList.add("has-account");
  document.dispatchEvent(new Event("accountready"));      // the serial reader starts from here
}).catch(() => { /* offline or blocked: the reader goes on without accounts */ });
})(typeof window === "undefined" ? globalThis : window);
