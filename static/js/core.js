/* --- CORE: state, helpers, YouTube API, navigation --- */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── State ──────────────────────────────────────────────────────────────────
let queue = [], queueIdx = -1;
let ytPlayer = null, ytReady = false, ytApiLoaded = false;
let ytFallbackId = null, ytFallbackErrorId = null, ytFallbackResolvedFor = null;
let isPlaying = false, progressTimer = null;
let shuffleOn = false, repeatMode = 0;
let history = JSON.parse(localStorage.getItem("ythistory") || "[]");
let liked = new Set(JSON.parse(localStorage.getItem("ytliked") || "[]"));
let playlists = JSON.parse(localStorage.getItem("ytplaylists") || "[]");
let recentSearches = JSON.parse(localStorage.getItem("ytrecent") || "[]");
let likedSongsMap = JSON.parse(localStorage.getItem("ytlikedSongs") || "{}");
let settings = Object.assign({
  darkMode: true,
  autoplayRadio: true,
  showToasts: true,
  volume: 80,
  speed: 1,
  eqPreset: "flat",
}, JSON.parse(localStorage.getItem("ytsettings") || "{}"));
let currentVideoId = null, useAudioEl = false, activeMediaEl = null;
let viewHistory = ["home"], viewIdx = 0;
let ctxSong = null, ctxList = null, activePlaylistId = null;
let sleepTimer = null, sleepEndsAt = 0;
let lyricsSynced = [], lyricsPlain = "", playbackRates = [0.75, 1, 1.25, 1.5, 2], rateIdx = 1;
let npfHasVideo = false, npfWordTimings = [], npfLyricsLastLine = -1, npfLineRendered = -1;
let videoMetaMap = {};          // videoId -> { imageOnly: bool } from /api/video
let lyricsLoadedFor = null;     // song id the loaded lyrics belong to
let lyricsReqCounter = 0;       // bumps per loadLyrics call so stale responses are ignored
let audioCtx = null, mediaSource = null, eqFilters = [], eqGain = null, eqPanner = null, eqConnected = false;
let eightDTimer = null, eightDAngle = 0;

const loading = $("#loadingOverlay");
const audioEl = $("#audioPlayer");
const mediaVideo = $("#mediaVideo");
function getPlaybackEl() { return activeMediaEl || audioEl; }
// One clock for native media and the YouTube fallback. Room state, progress,
// lyrics, Media Session, and fullscreen visuals must never read a dormant
// <audio> element while the fallback iframe is actually playing.
function getPlaybackTime() {
  if (useAudioEl) {
    const media = getPlaybackEl();
    return media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
  }
  try {
    const t = ytPlayer?.getCurrentTime?.();
    if (Number.isFinite(t)) return t;
  } catch {}
  return 0;
}
function getPlaybackDuration() {
  if (useAudioEl) {
    const media = getPlaybackEl();
    return media && Number.isFinite(media.duration) ? media.duration : 0;
  }
  try {
    const d = ytPlayer?.getDuration?.();
    if (Number.isFinite(d)) return d;
  } catch {}
  return 0;
}
let audioRetrying = false; // set while playViaAudio is switching strategies
if (audioEl) {
  audioEl.addEventListener("error", () => {
    if (!useAudioEl || !currentVideoId || audioRetrying) return;
    console.warn("audio element error — falling back to YouTube embed");
    playViaYouTube(currentVideoId);
  });
}

// ── YouTube API (lazy) ─────────────────────────────────────────────────────
// The IFrame API is only needed as a fallback when yt-dlp extraction fails.
// Defer loading it until the first fallback play attempt — saves ~100KB of
// third-party JS and a network round-trip on every page load.
window.onYouTubeIframeAPIReady = () => { ytApiLoaded = true; createPlayer(); };

let _ytApiInjected = false;

function ensureYtApi() {
  if (window.YT?.Player) {
    // Some browsers expose YT before firing the global callback. Treat the
    // API as ready and create the player instead of leaving an empty iframe.
    ytApiLoaded = true;
    createPlayer();
    return;
  }
  if (_ytApiInjected) return;
  _ytApiInjected = true;
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.async = true;
  document.head.appendChild(s);
}

function createPlayer() {
  if (ytPlayer || !ytApiLoaded) return;
  try {
    ytPlayer = new YT.Player("ytPlayer", {
      height: "1", width: "1", videoId: currentVideoId || "",
      playerVars: { autoplay: currentVideoId ? 1 : 0, controls: 0, disablekb: 1, iv_load_policy: 3, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => {
          ytReady = true;
          // Autoplay is commonly rejected unless the iframe is muted first.
          // The app's native stream is already unavailable on the affected
          // Vercel runtime, so the embed must be a real, deterministic fallback.
          if (ytFallbackId && currentVideoId === ytFallbackId && !useAudioEl) {
            try { ytPlayer.mute?.(); ytPlayer.setVolume?.(100); ytPlayer.loadVideoById(ytFallbackId); ytPlayer.playVideo?.(); } catch {}
          }
        },
        onStateChange: e => {
          if (e.data === YT.PlayerState.ENDED) handleEnded();
          if (!useAudioEl) {
            isPlaying = e.data === YT.PlayerState.PLAYING;
            updatePlayBtn();
            isPlaying ? startProgress() : stopProgress();
            npfVideoSync(isPlaying);
          }
        },
        onAutoplayBlocked: () => {
          isPlaying = false;
          updatePlayBtn();
          stopProgress();
          if (typeof showToast === "function") showToast("Tap play to start playback");
        },
        onError: () => {
          // Restricted/region-locked music IDs can fail in the embed even when
          // the catalogue entry is valid. Try one nearby searchable match, but
          // never recurse: the room and UI continue to use the original ID.
          const originalId = currentVideoId || ytFallbackId;
          ytFallbackErrorId = ytFallbackId || originalId;
          isPlaying = false;
          updatePlayBtn();
          stopProgress();
          if (ytFallbackResolvedFor === originalId || typeof api !== "function") {
            if (typeof showToast === "function") showToast("This video cannot be played here");
            return;
          }
          ytFallbackResolvedFor = originalId;
          const song = queue[queueIdx] || {};
          const query = `${song.title || ""} ${song.artist || ""}`.trim();
          if (!query) return;
          api(`/api/search?q=${encodeURIComponent(query)}&filter=songs`).then(results => {
            const alt = (Array.isArray(results) ? results : [])
              .find(item => item?.id && item.id !== originalId);
            if (!alt || currentVideoId !== originalId || !ytPlayer) return;
            ytFallbackId = alt.id;
            ytFallbackErrorId = null;
            try { ytPlayer.mute?.(); ytPlayer.loadVideoById(alt.id); ytPlayer.playVideo?.(); } catch {}
            if (typeof showToast === "function") showToast("Using a playable audio match");
          }).catch(() => {
            if (typeof showToast === "function") showToast("This video cannot be played here");
          });
        },
      },
    });
  } catch { /* fallback */ }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function showLoading() { loading.classList.remove("hidden"); }
function hideLoading() { loading.classList.add("hidden"); }
function fmtTime(s) { if (!s || !isFinite(s)) return "0:00"; const m = Math.floor(s / 60); return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`; }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Always-resolvable cover art for a track (queue / cards). */
function songThumb(s) {
  if (!s) return "";
  let t = s.thumbnail || s.thumbnails?.[s.thumbnails.length - 1]?.url || s.thumb || "";
  if (typeof t === "object" && t) t = t.url || "";
  if (t && String(t).startsWith("//")) t = "https:" + t;
  if (t) return String(t);
  const id = s.id || s.videoId;
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

/**
 * Downscaled cover for cards/grids: i.ytimg hq (480×360) -> mq (320×180)
 * and googleusercontent `-wNNN-hNNN` frames are capped at ~320.
 * Accepts a song object or a raw URL string. Hero/player art keeps `songThumb`.
 */
function cardThumb(s) {
  let t = typeof s === "string" ? s : songThumb(s);
  if (!t) return "";
  t = t.replace("/hqdefault.jpg", "/mqdefault.jpg");
  t = t.replace("/maxresdefault.jpg", "/mqdefault.jpg");
  t = t.replace(/=w\d+-h\d+/, "=w320-h320");
  return t;
}
function normalizeSong(s) {
  if (!s) return s;
  const id = s.id || s.videoId;
  return { ...s, id, thumbnail: songThumb({ ...s, id }) };
}
function bindImgFallback(root) {
  (root || document).querySelectorAll("img[data-fallback]").forEach(img => {
    if (img.dataset.boundFb) return;
    img.dataset.boundFb = "1";
    img.addEventListener("error", () => {
      const fb = img.dataset.fallback;
      if (fb && !img.dataset.usedFb) {
        img.dataset.usedFb = "1";
        img.src = fb;
        return;
      }
      const d = document.createElement("div");
      d.className = "qi-thumb-fallback";
      d.innerHTML = '<i class="fa-solid fa-music"></i>';
      img.replaceWith(d);
    });
  });
}
function saveHistory() { localStorage.setItem("ythistory", JSON.stringify(history.slice(0, 200))); }
function saveLiked() {
  localStorage.setItem("ytliked", JSON.stringify([...liked]));
  localStorage.setItem("ytlikedSongs", JSON.stringify(likedSongsMap));
}
function savePlaylists() { localStorage.setItem("ytplaylists", JSON.stringify(playlists)); }
function saveRecent() { localStorage.setItem("ytrecent", JSON.stringify(recentSearches.slice(0, 12))); }
function saveSettings() { localStorage.setItem("ytsettings", JSON.stringify(settings)); }

function rgbToHue(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 265;
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return Math.round((h / 6) * 360);
}

function setAccentFromImage(imgUrl) {
  const c = document.createElement("canvas"); c.width = c.height = 1;
  const ctx = c.getContext("2d"); const i = new Image(); i.crossOrigin = "anonymous";
  i.onload = () => {
    try {
      ctx.drawImage(i, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const hue = rgbToHue(r, g, b);
      document.documentElement.style.setProperty("--accent-h", String(hue || 265));
    } catch { /* CORS / tainted canvas — keep current hue */ }
  };
  i.src = imgUrl;
}

// ── Greeting ───────────────────────────────────────────────────────────────
function updateGreeting() {
  const h = new Date().getHours();
  const txt = h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greetingText").textContent = txt;
}

// ── Navigation ─────────────────────────────────────────────────────────────
// Keep each in-app view in the browser history. This makes the phone/browser
// Back gesture return to the previous Aura view instead of leaving the site.
const AURA_VIEW_STATE = "auraView";
if (!window.history.state?.auraApp) {
  window.history.replaceState({ auraApp: true, [AURA_VIEW_STATE]: "home" }, "", window.location.href);
}

function switchView(name, { fromBrowserHistory = false, replaceBrowserHistory = false } = {}) {
  if (!name || !$(`#view-${name}`)) return;
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#view-${name}`)?.classList.add("active");
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === name));
  $$(".mnav-item").forEach(n => n.classList.toggle("active", n.dataset.view === name));
  $("#mainContent").scrollTop = 0;

  if (fromBrowserHistory) {
    const existing = viewHistory.lastIndexOf(name);
    if (existing >= 0) viewIdx = existing;
    else { viewHistory.push(name); viewIdx = viewHistory.length - 1; }
  } else if (viewHistory[viewIdx] !== name) {
    viewHistory = viewHistory.slice(0, viewIdx + 1);
    viewHistory.push(name);
    viewIdx = viewHistory.length - 1;
  }

  if (!fromBrowserHistory && window.history.state?.[AURA_VIEW_STATE] !== name) {
    const state = { auraApp: true, [AURA_VIEW_STATE]: name };
    if (replaceBrowserHistory) window.history.replaceState(state, "", window.location.href);
    else window.history.pushState(state, "", window.location.href);
  }
  updateNavArrows();
}

function updateNavArrows() {
  $("#btnBack").style.opacity = viewIdx > 0 ? "1" : "0.3";
  $("#btnForward").style.opacity = viewIdx < viewHistory.length - 1 ? "1" : "0.3";
}

window.addEventListener("popstate", event => {
  const name = event.state?.auraApp ? event.state[AURA_VIEW_STATE] : null;
  // If the browser has reached a non-Aura history entry, leave normal browser
  // behavior intact. Otherwise restore the previous in-app view.
  if (!name) return;
  switchView(name, { fromBrowserHistory: true });
  onNavigate(name);
});

$("#btnBack").addEventListener("click", () => {
  if (viewIdx > 0) window.history.back();
});
$("#btnForward").addEventListener("click", () => {
  if (viewIdx < viewHistory.length - 1) window.history.forward();
});

function onNavigate(v) {
  if (v === "trending") loadTrending(true);
  if (v === "history") renderHistory();
  if (v === "liked") renderLiked();
  if (v === "library") updateLibraryCounts();
  if (v === "explore") loadExplore();
  if (v === "radio") loadRadioView();
  if (v === "playlists") renderPlaylists();
  if (v === "search") renderRecentSearches();
}

$$(".nav-item").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault(); const v = el.dataset.view; switchView(v); onNavigate(v);
  });
});
$$(".mnav-item").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault(); const v = el.dataset.view; switchView(v); onNavigate(v);
  });
});

$$(".lib-card, .see-all, .btn-ghost[data-view]").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault();
    const v = el.dataset.view;
    if (!v) return;
    switchView(v);
    onNavigate(v);
  });
});

// Mood chips — accent + live mood catalog
const MOOD_HUE = { all: 265, focus: 210, drive: 12, chill: 165, night: 285 };
const MOOD_Q = {
  all: "", focus: "focus study instrumental music",
  drive: "workout energy pump up songs",
  chill: "chill lo-fi vibes",
  night: "late night R&B chill",
};
$$(".mood-chip").forEach(chip => {
  chip.addEventListener("click", async () => {
    $$(".mood-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    const mood = chip.dataset.mood || "all";
    document.documentElement.style.setProperty("--accent-h", String(MOOD_HUE[mood] ?? 265));
    if (mood === "all") { loadTrending(); return; }
    showLoading();
    try {
      const songs = await api(`/api/mood?q=${encodeURIComponent(MOOD_Q[mood])}`);
      switchView("home");
      renderSongs(songs, $("#trendingGrid"));
      loadQuickPicks(songs);
      showToast(`${chip.textContent} mix ready`);
    } catch (e) { console.error(e); }
    hideLoading();
  });
});

// Hero CTA — play first trending track
$("#heroPlayTrending")?.addEventListener("click", async () => {
  showLoading();
  try {
    const songs = await api("/api/trending");
    if (songs?.length) playSongFromList(songs, 0);
  } catch (e) { console.error(e); }
  hideLoading();
});

$("#heroStartRadio")?.addEventListener("click", async () => {
  if (queueIdx >= 0 && queue[queueIdx]) startRadio(queue[queueIdx]);
  else {
    showLoading();
    try {
      const songs = await api("/api/trending");
      if (songs?.length) await startRadio(songs[0]);
    } catch (e) { console.error(e); }
    hideLoading();
  }
});
