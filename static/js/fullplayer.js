/* --- FULL PLAYER: now-playing screen, video + lyrics display --- */

// ── Now Playing Full Screen ────────────────────────────────────────────────
let npfSyncTimer = null;

function showNpfVideo() {
  npfHasVideo = true;
  // Lyrics take priority — only show video if no synced lyrics overlay is active
  if (!$("#npfLyrics")?.classList.contains("visible")) {
    $("#npfVideo")?.classList.add("playing");
    $("#npfArt")?.classList.add("video-mode");
  }
}
function hideNpfVideo() {
  npfHasVideo = false;
  $("#npfVideo")?.classList.remove("playing");
  $("#npfArt")?.classList.remove("video-mode");
}
function showNpfLyrics() {
  const el = $("#npfLyrics");
  if (!el) return;
  el.classList.add("visible");
  // Hide video behind lyrics overlay — lyrics take priority
  $("#npfArt")?.classList.remove("video-mode");
  $("#npfVideo")?.classList.remove("playing");
}
function hideNpfLyrics() {
  const el = $("#npfLyrics");
  if (!el) return;
  el.classList.remove("visible");
}
/**
 * Warm the video URL cache while a song plays and capture whether the track is
 * a real music video or just a static album-art frame (image-only), so the full
 * player can skip the fake video stream entirely. Concurrent callers share one
 * request (prefetch + the full player both ask for the same song).
 */
const videoMetaCache = new Map();
function prefetchVideo(id) {
  if (!id) return Promise.resolve();
  if (!videoMetaCache.has(id)) {
    const p = api(`/api/video/${id}`)
      .then(data => {
        if (data && typeof data.imageOnly !== "undefined") videoMetaMap[id] = data;
        return data;
      })
      .catch(err => { videoMetaCache.delete(id); throw err; });
    videoMetaCache.set(id, p);
  }
  return videoMetaCache.get(id);
}

/**
 * Decide what the full-player art box shows for the current song:
 *  1. image-only song + synced lyrics  -> word-by-word lyrics box (themed)
 *  2. image-only song + plain lyrics   -> plain lyrics box (no fake video stream)
 *  3. image-only song, no lyrics       -> static cover art
 *  4. real music video                 -> the video (lyrics live in the tab)
 *  A song whose video stream is DEAD (probe failed / stream won't play) falls
 *  back to the lyrics box when lyrics are available instead of a dead frame.
 */
function updateNpfDisplay() {
  const art = $("#npfArt");
  const full = $("#nowPlayingFull");
  if (!art || !full || !full.classList.contains("open")) return;
  const meta = videoMetaMap[currentVideoId];
  const imageOnly = !!(meta && meta.imageOnly === true);
  const hasSynced = lyricsSynced.length > 0 && lyricsLoadedFor === currentVideoId;
  const hasPlain = !!lyricsPlain && lyricsLoadedFor === currentVideoId;
  const videoDead = npfVideoFailed.has(currentVideoId);

  // Image-only tracks: the "video" is just a static frame — replace it with a
  // lyrics box when lyrics exist (synced karaoke or plain), else keep the art.
  // Also catch tracks whose video stream genuinely can't play (dead stream)
  // so we never leave a blank frame when lyrics are available.
  // For unsynced/script lyrics on image-only tracks, show only the cover art.
  if (imageOnly || (videoDead && (hasSynced || hasPlain))) {
    if (hasSynced) {
      computeWordTimings();
      npfLyricsLastLine = -1;
      npfLineRendered = -1;
      showNpfLyrics();
      syncNpfLyrics(getPlaybackEl().currentTime || 0);
    } else if (hasPlain) {
      // Plain (unsynced/script) lyrics: don't show in box for image-only tracks
      // Just show the cover art/image only
      hideNpfLyrics();
    } else {
      hideNpfLyrics();
    }
    stopNpfVideo();
    return;
  }

  // Real music video: play it. No lyrics overlay on top.
  hideNpfLyrics();
  // Avoid reloading video/embed if already showing this song (lyrics fetch triggers this)
  const v = $("#npfVideo");
  if ((npfVideoLoadedId === currentVideoId && v && v.src) || (npfEmbedId === currentVideoId && npfEmbedYt)) return;
  loadNpfVideo();
}

/** Static (non-synced) lyrics rendered inside the full-player box. */
function renderPlainNpfLyrics() {
  const el = $("#npfLyrics");
  if (!el) return;
  npfWordTimings = [];
  const lines = String(lyricsPlain || "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  if (!lines.length) return;
  el.innerHTML = `<div class="npf-lyrics-box"><div class="npf-lyrics-plain">${lines.map(l => esc(l)).join("<br>")}</div></div>`;
}
function seekNpfTo(target) {
  if (target == null) target = getPlaybackEl().currentTime || 0;
  target = Math.max(0, target);
  const v = $("#npfVideo");
  if (v && v.src) {
    try {
      v.loop = false;
      if (v.duration && isFinite(v.duration)) v.currentTime = Math.min(target, v.duration - 0.05);
      else v.currentTime = target;
    } catch {}
  }
  if (npfEmbedYt && npfEmbedId) {
    try { npfEmbedYt.seekTo?.(target, true); } catch {}
  }
}
/**
 * Tight drift correction: keeps the video locked to the audio timeline. Runs on
 * the 500ms progress tick (and the 1s npfSyncTimer), so the video can never
 * visibly lag or run ahead by more than a beat. Within buffered data it snaps
 * instantly; when the target is beyond the buffer but the video is far behind,
 * it force-seeks anyway — the browser re-buffers, which beats staying lost.
 */
function npfDriftCheck() {
  if (!useAudioEl || !$("#nowPlayingFull").classList.contains("open")) return;
  const v = $("#npfVideo");
  if (!v || !v.src || v.paused || v.readyState < 2) return;
  if (!v.duration || !isFinite(v.duration)) return;
  const a = getPlaybackEl().currentTime || 0, b = v.currentTime || 0;
  if (b - a > 1.5) { v.currentTime = Math.min(a, Math.max(0, v.duration - 0.05)); return; }  // ran ahead → snap back
  if (a - b <= 1.5) return;                              // within a beat → leave it alone
  try {
    if (v.seekable && v.seekable.length) {
      const lo = v.seekable.start(0), hi = v.seekable.end(v.seekable.length - 1);
      if (a >= lo - 0.5 && a <= hi + 1) { v.currentTime = Math.min(a, hi); return; }   // behind → catch up in-buffer
    }
    // Target outside what's downloaded and we're badly out of sync — jump anyway.
    if (a - b > 3 && a < v.duration - 0.5) v.currentTime = a;
  } catch {}
}
function openFullPlayer() {
  $("#nowPlayingFull").classList.add("open");
  npfHasVideo = false;
  npfLyricsLastLine = -1;
  npfLineRendered = -1;
  if (queue[queueIdx]?.thumbnail) {
    $("#npfBg").style.backgroundImage = `url(${queue[queueIdx].thumbnail})`;
  }
  if (currentVideoId) {
    updateNpfDisplay();
    // Fetch lyrics for this song if they haven't been loaded yet.
    const song = queue[queueIdx];
    if (song && lyricsLoadedFor !== song.id) loadLyrics(song);
  }
}
function closeFullPlayer() {
  stopNpfVideo();
  hideNpfLyrics();
  $("#nowPlayingFull").classList.remove("open");
}
let npfVideoLoadedId = null;
const npfVideoFailed = new Set();   // videoIds whose stream won't play — never retry them
let npfEmbedYt = null;              // YouTube iframe fallback player (extraction failed)
let npfEmbedId = null;
function stopNpfVideo() {
  npfVideoLoadedId = null;
  if (npfSyncTimer) { clearInterval(npfSyncTimer); npfSyncTimer = null; }
  stopNpfEmbed();
  const v = $("#npfVideo");
  if (!v) return;
  v.onloadedmetadata = null; v.onloadeddata = null; v.onplaying = null; v.onerror = null;
  v.pause();
  v.removeAttribute("src");
  try { v.load(); } catch {}
  hideNpfVideo();
}
/** YouTube iframe fallback for the full-player art box: used when yt-dlp can't
 * extract a stream (Vercel / datacenter IPs) — the audio already fell back to
 * a YouTube embed, so show the video the same way. Muted & synced to play/pause. */
function showNpfEmbed(id) {
  npfEmbedId = id;
  npfHasVideo = true;
  // Capture current audio time so embed starts mid-song (not from 0)
  const startSec = Math.floor(getPlaybackEl().currentTime || 0);
  // YT.Player replaces the target element with its iframe (same id), so make
  // sure a fresh container div exists before constructing each time.
  let wrap = $("#npfEmbed");
  if (!wrap || wrap.tagName === "IFRAME") {
    if (wrap) wrap.remove();
    wrap = document.createElement("div");
    wrap.id = "npfEmbed";
    wrap.className = "npf-embed";
    $("#npfArt")?.appendChild(wrap);
  }
  wrap.innerHTML = "";
  // Shield layer above the iframe: YouTube's own controls/branding ("watch
  // more", play/pause, "Watch on YouTube") can't be disabled fully via the API,
  // so we cover the player and let the music player drive it exclusively.
  let shield = $("#npfEmbedShield");
  if (!shield) {
    shield = document.createElement("div");
    shield.id = "npfEmbedShield";
    shield.className = "npf-embed-shield";
  }
  $("#npfArt")?.appendChild(shield);
  $("#npfArt")?.classList.add("video-mode");   // reveal the embed layer
  const ensure = () => {
    if (!window.YT) { ensureYtApi(); return false; }
    try {
      npfEmbedYt = new YT.Player("npfEmbed", {
        videoId: id,
        width: "100%", height: "100%",
        // No YouTube loop — video follows the audio timeline. All controls disabled.
        // start: so mid-song open doesn't flash from 0
        playerVars: { autoplay: 1, mute: 1, controls: 0, fs: 0, rel: 0, showinfo: 0, disablekb: 1, iv_load_policy: 3, modestbranding: 1, playsinline: 1, origin: location.origin, start: startSec > 1 ? startSec : 0 },
        events: {
          onReady: () => {
            if (npfEmbedId !== id) return;
            try { npfEmbedYt?.mute?.(); } catch {}
            // Seek to exact audio time (fractional) then play
            try {
              const t = getPlaybackEl().currentTime || 0;
              if (t > 0.5) npfEmbedYt.seekTo(t, true);
              npfEmbedYt.playVideo();
            } catch {}
            // Some browsers drop the first autoplay attempt — retry once shortly after.
            setTimeout(() => {
              if (npfEmbedId === id && npfEmbedYt && npfEmbedYt.getPlayerState?.() !== 1) {
                try { npfEmbedYt.playVideo?.(); } catch {}
              }
              // Re-seek after retry to ensure mid-song position sticks
              try { const t2 = getPlaybackEl().currentTime || 0; if (t2 > 0.5) npfEmbedYt.seekTo(t2, true); } catch {}
            }, 600);
          },
          onStateChange: (e) => {
            if (npfEmbedId !== id) return;
            // 0 = ended → seek to current audio time so video follows audio, not loop to 0 alone
            if (e && e.data === 0) {
              try {
                const t = getPlaybackEl().currentTime || 0;
                // If audio still playing, keep video in sync; else pause at end
                if (isPlaying && useAudioEl) { npfEmbedYt.seekTo(t, true); npfEmbedYt.playVideo(); }
              } catch {}
            }
          },
        },
      });
      return true;
    } catch { return false; }
  };
  if (ensure()) return;
  let n = 0;
  const t = setInterval(() => { n += 1; if (ensure() || n > 50) clearInterval(t); }, 200);
}
function stopNpfEmbed() {
  npfEmbedId = null;
  if (npfEmbedYt) { try { npfEmbedYt.destroy(); } catch {} npfEmbedYt = null; }
  const wrap = $("#npfEmbed");
  if (wrap && wrap.tagName !== "IFRAME") wrap.innerHTML = "";
  $("#npfEmbedShield")?.remove();
}
function npfVideoSync(playing) {
  if (!$("#nowPlayingFull").classList.contains("open")) return;
  if (npfEmbedYt && npfEmbedId) {
    try { playing ? npfEmbedYt.playVideo?.() : npfEmbedYt.pauseVideo?.(); } catch {}
  }
  const v = $("#npfVideo");
  if (!v || !v.src) return;
  if (playing) v.play().catch(() => {});
  else v.pause();
}
/** Load the song's combined video stream and play it muted (synced to audio). */
async function loadNpfVideo() {
  const v = $("#npfVideo");
  const id = currentVideoId;
  if (!v || !id) return;
  // Lyrics box takes priority — never decode video behind it.
  if ($("#npfLyrics")?.classList.contains("visible")) return;
  // Image-only songs have no real music video: keep the static cover art.
  const preMeta = videoMetaMap[id];
  if (preMeta && preMeta.imageOnly === true) return;
  // A previous attempt to play this song's stream failed — stay on cover art.
  if (npfVideoFailed.has(id)) return;

  // Already showing this song's video or embed? Keep in sync, don't reload.
  if (npfVideoLoadedId === id && v.src) {
    if (v.duration && isFinite(v.duration)) {
      const a = getPlaybackEl().currentTime || 0, b = v.currentTime || 0;
      if (b - a > 5) v.currentTime = a;
    }
    if (isPlaying && v.paused && v.readyState >= 2) v.play().catch(() => {});
    return;
  }
  if (npfEmbedId === id && npfEmbedYt) {
    // Embed already showing this song — just keep it synced
    try { const t = getPlaybackEl().currentTime || 0; if (t > 0.5) npfEmbedYt.seekTo(t, true); } catch {}
    if (isPlaying) { try { npfEmbedYt.playVideo(); } catch {} }
    return;
  }

  stopNpfVideo();
  let src;
  try {
    const data = await prefetchVideo(id);
    src = data?.url || data?.direct;
  } catch (e) {
    // Extraction failed (Vercel/datacenter IPs get blocked by yt-dlp). The
    // audio already fell back to the YouTube embed — show the video the same
    // way instead of leaving a dead black area.
    console.warn("npf video: no video stream — using YouTube embed", e);
    showNpfEmbed(id);
    return;
  }
  if (!src || currentVideoId !== (queue[queueIdx] || {})?.id) {
    if (!src && currentVideoId === id) showNpfEmbed(id);
    return;
  }
  // Learned this track is a static-frame upload — let updateNpfDisplay pick the lyrics box.
  const meta = videoMetaMap[id];
  if (meta && meta.imageOnly === true) {
    updateNpfDisplay();
    return;
  }
  if ($("#npfLyrics")?.classList.contains("visible")) return;

  v.muted = true;
  v.loop = false;
  v.removeAttribute("loop");
  v.playbackRate = settings.speed || 1;
  npfVideoLoadedId = id;
  const clampToDur = t => (v.duration && isFinite(v.duration)) ? Math.min(t, Math.max(0, v.duration - 0.05)) : t;
  v.onloadedmetadata = () => {
    // Runtime safety net: a SQUARE stream is a static album-art frame, not a
    // music video — flip to image-only and let updateNpfDisplay show lyrics.
    if (v.videoWidth && v.videoHeight && Math.abs(v.videoWidth - v.videoHeight) <= 4) {
      videoMetaMap[id] = { imageOnly: true };
      npfVideoFailed.add(id);
      stopNpfVideo();
      updateNpfDisplay();
      return;
    }
    // Seek to the LIVE audio position (not a stale pre-load capture — proxy
    // fetch can take seconds, during which the song keeps playing). Then hold
    // presentation until that seek lands: starting playback before the async
    // seek completes makes the browser paint frame 0 → visible "from start".
    let pendingSeek = false;
    try {
      const t0 = getPlaybackEl().currentTime || 0;
      if (t0 > 0.5) { v.currentTime = clampToDur(t0); pendingSeek = true; }
    } catch {}
    if (!isPlaying) return;
    if (!pendingSeek) { v.play().catch(() => {}); return; }
    let started = false;
    const startAtPos = () => {
      if (started || currentVideoId !== id || !isPlaying) return;
      started = true;
      // Re-snap right before presenting in case the song advanced while buffering
      try {
        const a = getPlaybackEl().currentTime || 0;
        if (a > 1 && Math.abs(a - v.currentTime) > 1.5) v.currentTime = clampToDur(a);
      } catch {}
      v.play().catch(() => {});
    };
    v.addEventListener("seeked", startAtPos, { once: true });
    setTimeout(startAtPos, 2000);   // never let a stalled seek block playback
  };
  // Align the video to the current audio position once, when a seekable range
  // actually exists and a frame is decodable. Without this the video starts at
  // 0 while the audio is already seconds ahead → permanent "lagging behind".
  let aligned = false;
  const tryAlignOnce = () => {
    try {
      const at = getPlaybackEl().currentTime || 0;
      if (v.seekable && v.seekable.length) {
        const lo = v.seekable.start(0), hi = v.seekable.end(v.seekable.length - 1);
        if (at >= lo && at <= hi) { v.currentTime = at; aligned = true; }
        else if (at <= hi) { v.currentTime = Math.max(lo, at - 2); aligned = true; }  // close enough → align near
      } else if (!v.seekable.length && at > 0.5) {
        // Fallback when seekable not yet populated — direct seek
        try { v.currentTime = at; aligned = true; } catch {}
      }
    } catch {}
  };
  v.onloadeddata = () => {
    if (currentVideoId !== id) return;
    // Ensure position right before showing
    if (!aligned) {
      try {
        const t = getPlaybackEl().currentTime || 0;
        if (t > 0.5) v.currentTime = clampToDur(t);
      } catch {}
      tryAlignOnce();
    }
    showNpfVideo();
  };
  v.onplaying = () => {
    if (currentVideoId !== id) return;
    // Hard re-sync every time playback (re)starts — covers any seek that
    // silently failed during load, so video can never visibly run from 0.
    try {
      const a = getPlaybackEl().currentTime || 0, b = v.currentTime || 0;
      if (a > 1 && Math.abs(a - b) > 1.5) v.currentTime = clampToDur(a);
    } catch {}
    showNpfVideo();
  };
  v.onerror = () => {
    console.warn("npf video: element error", v.error && v.error.message);
    // The stream genuinely can't play — remember it so we don't loop re-fetching
    // a dead stream, then show the YouTube embed instead of a blank box.
    npfVideoFailed.add(id);
    stopNpfVideo();
    updateNpfDisplay();
    if (currentVideoId === id && !$("#npfLyrics")?.classList.contains("visible")) {
      showNpfEmbed(id);
    }
  };
  v.src = src;
  v.load();

  // Keep the video running + in sync while the full player shows this song.
  let stall = 0;
  npfSyncTimer = setInterval(() => {
    if (!$("#nowPlayingFull").classList.contains("open") || currentVideoId !== id) return;
    if (!isPlaying) { stall = 0; return; }
    if (npfEmbedYt && npfEmbedId === id) {
      // YouTube-embed fallback: periodically re-lock it to the audio timeline
      try {
        const st = npfEmbedYt.getPlayerState?.();
        if (st === 1 || st === 2) {   // playing or paused — don't fight buffering(3)
          const a = getPlaybackEl().currentTime || 0, b = npfEmbedYt.getCurrentTime?.() || 0;
          if (a > 1 && Math.abs(a - b) > 2) npfEmbedYt.seekTo(a, true);
        }
      } catch {}
      return;
    }
    if (v.paused) {
      // Wait for data before nudging so we don't fight the buffer. Only give up
      // after a long true stall instead of rewinding to 0 (that rewind made the
      // video look like it was playing slowly from the start).
      if (v.readyState >= 2) {
        // Re-sync BEFORE resuming so a stalled video never resumes at the
        // wrong place (e.g. back at the start) and looks "restarted".
        try {
          const a = getPlaybackEl().currentTime || 0;
          if (a > 1 && Math.abs(a - v.currentTime) > 1.5) v.currentTime = clampToDur(a);
        } catch {}
        v.play().catch(() => {});
        stall = 0;
      } else if (++stall > 30) {
        // Genuinely stuck stream (e.g. serverless proxy can't sustain it) —
        // hand over to the YouTube embed instead of a dead black box.
        stopNpfVideo();
        if (currentVideoId === id && !$("#npfLyrics")?.classList.contains("visible")) {
          showNpfEmbed(id);
        }
      }
    } else {
      stall = 0;
      npfDriftCheck();
    }
  }, 1000);
}
$("#playerLeft").addEventListener("click", () => {
  if (queueIdx < 0) return;
  openFullPlayer();
});
$("#npfClose").addEventListener("click", closeFullPlayer);
$("#npfArtist").addEventListener("click", () => {
  if (queueIdx >= 0) { doSearch(queue[queueIdx].artist); closeFullPlayer(); }
});

// clear history
$("#clearHistory")?.addEventListener("click", () => { history = []; saveHistory(); renderHistory(); });

// deploy to github
$("#deployBtn")?.addEventListener("click", async () => {
  const btn = $("#deployBtn");
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Deploying...</span>';
  btn.disabled = true;
  
  try {
    // Create a deployment info modal or notification
    const repoName = prompt("Enter GitHub repository name (e.g., my-aura-player):", "aura-music-player");
    if (!repoName) {
      btn.innerHTML = originalText;
      btn.disabled = false;
      return;
    }
    
    const username = prompt("Enter your GitHub username:");
    if (!username) {
      btn.innerHTML = originalText;
      btn.disabled = false;
      return;
    }
    
    // Show instructions
    alert(`To deploy Aura to GitHub:\n\n1. Initialize git in your project folder:\n   cd /workspace/Aura\n   git init\n   git add .\n   git commit -m "Initial commit"\n\n2. Create a new repository on GitHub: https://github.com/new\n   Repository name: ${repoName}\n\n3. Link and push:\n   git remote add origin https://github.com/${username}/${repoName}.git\n   git branch -M main\n   git push -u origin main\n\n4. Deploy to GitHub Pages:\n   - Go to Settings > Pages\n   - Select "main" branch and "/ (root)"\n   - Your app will be live at: https://${username}.github.io/${repoName}/`);
    
  } catch (e) {
    console.error("Deploy error:", e);
    alert("Failed to deploy. Please try manually.");
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
});
