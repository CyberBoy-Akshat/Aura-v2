/* --- PLAYER: playback core, queue, progress, controls --- */

// ── Player ─────────────────────────────────────────────────────────────────
let playbackRequestId = 0;

async function playSongFromList(songs, idx, options = {}) {
  const song = normalizeSong(songs[idx]);
  if (!song) return;
  // play the song, then build queue from suggestions
  currentVideoId = song.id;
  queueIdx = 0;
  queue = [song];
  await playSong(0, options);
  // Load suggestions as the new queue for a local play. Remote room changes
  // intentionally keep the guest's queue stable; the host remains authoritative.
  if (options.remote !== true) {
    try {
      const sugs = (await api(`/api/suggestions/${song.id}`)).map(normalizeSong);
      const existing = new Set([song.id]);
      queue = [song, ...sugs.filter(s => s.id && !existing.has(s.id))];
      renderQueue();
    } catch {}
  }
}

async function playSong(idx, options = {}) {
  if (idx < 0 || idx >= queue.length) return;
  const remotePlayback = options.remote === true;
  if (!remotePlayback && typeof isListenTogetherGuest === "function" && isListenTogetherGuest()) { showToast("The host controls this room"); return; }
  queueIdx = idx;
  const song = normalizeSong(queue[idx]);
  queue[idx] = song;
  currentVideoId = song.id;
  // Search/playlist results carry `videoType`/`imageOnly` — seed the image-only
  // decision now so the full player shows lyrics/art for audio tracks and the
  // video for real MV's without waiting for the /api/video round-trip.
  if (song.videoType || song.imageOnly === true) {
    const knownImage = song.imageOnly === true
      || ["MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK"].includes(song.videoType);
    videoMetaMap[song.id] = { imageOnly: knownImage };
  }
  prefetchVideo(song.id).catch(() => {});   // warm cache; failure handled by full player

  // update UI everywhere
  const thumb = songThumb(song);
  $("#playerTitle").textContent = song.title;
  $("#playerArtist").textContent = song.artist;
  const setThumb = (el) => {
    if (!el) return;
    el.referrerPolicy = "no-referrer";
    el.onerror = () => {
      if (song.id && !el.dataset.didFb) {
        el.dataset.didFb = "1";
        el.src = `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`;
      }
    };
    el.src = thumb || "";
  };
  setThumb($("#playerThumb"));
  $("#miniTitle").textContent = song.title;
  $("#miniArtist").textContent = song.artist;
  setThumb($("#miniThumb"));
  $("#npfTitle").textContent = song.title;
  $("#npfArtist").textContent = song.artist;
  setThumb($("#npfThumb"));
  document.title = `${song.title} · ${song.artist} — Aura`;

  if (thumb) setAccentFromImage(thumb);
  updateLikeBtn(song.id);

  // highlight active
  $$(".song-card").forEach(c => c.classList.remove("active"));
  $$(`[data-id="${song.id}"]`).forEach(c => c.classList.add("active"));

  // Stop current media before switching tracks. Never assign an empty src:
  // Chromium resolves an empty media URL to the current document, producing
  // MEDIA_ELEMENT_ERROR and an unnecessary request to the Aura page.
  try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {}
  mediaVideo?.pause();
  mediaVideo?.removeAttribute("src");
  try { mediaVideo?.load(); } catch {}
  activeMediaEl = null;
  useAudioEl = false;
  stopNpfVideo();

  // PRIMARY: play via yt-dlp audio (no ads!). Keep this call non-blocking so
  // the controls remain responsive while the stream resolves.
  const requestId = ++playbackRequestId;
  playViaAudio(song.id, requestId).catch(err => console.warn("playback start", err));

  // Record one listening session per calendar day for the streak badge.
  if (typeof recordListeningStreak === "function") recordListeningStreak();
  if (typeof broadcastRoomState === "function") setTimeout(broadcastRoomState, 250);

  // history
  history = history.filter(h => h.id !== song.id);
  history.unshift(song);
  saveHistory();

  // Auto-suggestions are deliberately disabled for a remote room change until
  // the host queue has been applied; this prevents a guest from rebuilding a
  // one-track queue and falling out of sync when the host advances.
  if (!remotePlayback && queue.length < 8) loadSuggestions(song.id);
  renderQueue();
  updateMiniEq();
  applyPlaybackRate();
  updateMediaSession(song);
  if ($("#lyricsPanel")?.classList.contains("open") || $("#nowPlayingFull").classList.contains("open")) loadLyrics(song);
  if ($("#nowPlayingFull").classList.contains("open")) updateNpfDisplay();
}

async function playViaAudio(videoId, requestId = playbackRequestId) {
  if (!videoId) return;
  const isCurrentRequest = () => requestId === playbackRequestId && currentVideoId === videoId;
  const vol = parseInt($("#volumeBar")?.value || settings.volume || 80, 10);
  audioRetrying = true;

  const tryPlaySrc = async (src, allowEq, mediaEl = audioEl) => {
    if (!isCurrentRequest()) return;
    useAudioEl = true;
    activeMediaEl = mediaEl;
    try { ytPlayer?.pauseVideo?.(); } catch {}
    if (mediaEl !== audioEl) audioEl.pause();
    if (mediaEl !== mediaVideo) mediaVideo?.pause();
    if (allowEq) mediaEl.crossOrigin = "anonymous";
    else mediaEl.removeAttribute("crossorigin");
    mediaEl.pause();
    // Load the same-origin source first, then bind the element to Web Audio.
    // This keeps the graph attached to the media element that will actually
    // produce sound, including the combined-video fallback path.
    mediaEl.src = src;
    mediaEl.load();
    if (allowEq) {
      try {
        if (!ensureEqGraph(mediaEl)) throw new Error("graph unavailable");
      } catch (e) { console.warn("EQ graph", e); }
    }
    if (eqGain && eqConnected) {
      eqGain.gain.value = vol / 100;
      mediaEl.volume = 1;
    } else {
      mediaEl.volume = vol / 100;
    }
    if (!isCurrentRequest()) return;
    const p = mediaEl.play();
    if (p && typeof p.then === "function") await p;
    if (!isCurrentRequest()) { try { mediaEl.pause(); } catch {} return; }
    if (audioCtx?.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    if (allowEq && eqConnected) await applyEqPreset(settings.eqPreset || "flat");
    isPlaying = true;
    updatePlayBtn();
    startProgressAudio();
    updateMiniEq();
  };

  try {
    const data = await api(`/api/audio/${videoId}`);
    if (!isCurrentRequest()) return;
    if (data?.mode === "youtube" || data?.fallback === "youtube") {
      audioRetrying = false;
      playViaYouTube(videoId);
      return;
    }

    // ALWAYS play through the same-origin proxy. Direct googlevideo URLs lack
    // CORS, so binding them to the Web Audio graph outputs silence — and the
    // only fix would be a mid-song src swap (a restart). Proxy streams support
    // Range requests, keep seeking intact, and let EQ bind cleanly at any time.
    const eqNeeded = (settings.eqPreset || "flat") !== "flat" || eqConnected;
    const primary = videoId ? `/api/stream/${videoId}` : null;
    if (primary) {
      try {
        await tryPlaySrc(primary, eqNeeded);
        audioRetrying = false;
        return;
      } catch (e1) {
        console.warn("Proxy/EQ play failed", e1);
        // Retry without graph. This preserves audio playback if the graph was
        // blocked by a browser policy but the media element itself is usable.
        try {
          await tryPlaySrc(primary, false);
          audioRetrying = false;
          return;
        } catch (e2) {
          console.warn("Proxy play failed", e2);
          // A resolved direct URL is useful as a final playback fallback on
          // browsers that accept cross-origin media. EQ stays on the proxy path
          // because direct googlevideo URLs do not expose CORS to Web Audio.
          if (data?.direct && !eqConnected) {
            try {
              await tryPlaySrc(data.direct, false);
              audioRetrying = false;
              return;
            } catch (e3) { console.warn("Direct media play failed", e3); }
          }
        }
      }
    }
  } catch (e) {
    console.warn("audio API failed", e);
  }

  // If audio extraction fails, use the same-origin combined video stream as
  // the audible source. It remains compatible with Web Audio, unlike a
  // cross-origin YouTube iframe fallback.
  try {
    const videoData = await api(`/api/video/${videoId}`);
    if (!isCurrentRequest()) return;
    if (videoData?.url && videoData.imageOnly !== true) {
      await tryPlaySrc(videoData.url, true, mediaVideo);
      if (audioCtx?.state === "suspended") { try { await audioCtx.resume(); } catch {} }
      if (eqConnected) applyEqPreset(settings.eqPreset || "flat");
      isPlaying = true;
      updatePlayBtn();
      startProgressAudio();
      updateMiniEq();
      return;
    }
  } catch (e) {
    console.warn("video audio fallback failed", e);
  } finally {
    audioRetrying = false;
  }
  if (isCurrentRequest()) playViaYouTube(videoId);
}

function playViaYouTube(videoId) {
  useAudioEl = false;
  activeMediaEl = null;
  try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {}
  try { mediaVideo?.pause(); mediaVideo?.removeAttribute("src"); mediaVideo?.load(); } catch {}
  const vol = parseInt($("#volumeBar")?.value || settings.volume || 80, 10);
  const go = () => {
    if (!ytPlayer?.loadVideoById) return false;
    try {
      ytPlayer.loadVideoById(videoId);
      ytPlayer.setVolume?.(vol);
      ytPlayer.playVideo?.();
      isPlaying = true;
      updatePlayBtn();
      startProgress();
      return true;
    } catch {
      return false;
    }
  };
  ensureYtApi(); // load IFrame API lazily on first fallback play
  if (ytReady && go()) return;
  // Wait for IFrame API if still loading
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    if ((ytReady && go()) || n > 50) clearInterval(t);
  }, 200);
}

async function loadSuggestions(videoId) {
  try {
    const songs = (await api(`/api/suggestions/${videoId}`)).map(normalizeSong);
    if (songs.length) {
      const existing = new Set(queue.map(s => s.id));
      queue = [...queue, ...songs.filter(s => s.id && !existing.has(s.id))];
      renderQueue();
    }
  } catch {}
}

function handleEnded() {
  if (repeatMode === 2) {
    if (useAudioEl) { const media = getPlaybackEl(); media.currentTime = 0; media.play(); }
    else if (ytPlayer?.seekTo) { ytPlayer.seekTo(0); ytPlayer.playVideo(); }
    seekNpfTo(0);
  } else if (queueIdx < queue.length - 1) { playSong(queueIdx + 1); }
  else if (repeatMode === 1) { playSong(0); }
  else { isPlaying = false; updatePlayBtn(); stopProgress(); updateMiniEq(); }
}

function smartShuffleIndex() {
  if (queue.length <= 1) return queueIdx;
  const recentIds = new Set(history.slice(0, 12).map(s => s.id));
  const unplayed = queue.map((s, i) => ({ s, i })).filter(x => x.i !== queueIdx && !recentIds.has(x.s.id));
  const pool = unplayed.length ? unplayed : queue.map((s, i) => ({ s, i })).filter(x => x.i !== queueIdx);
  const likedPool = pool.filter(x => liked.has(x.s.id));
  const weighted = likedPool.length && Math.random() < 0.35 ? likedPool : pool;
  return weighted[Math.floor(Math.random() * weighted.length)]?.i ?? ((queueIdx + 1) % queue.length);
}
function playNext() {
  if (typeof isListenTogetherGuest === "function" && isListenTogetherGuest()) { showToast("The host controls this room"); return; }
  if (shuffleOn) playSong(smartShuffleIndex());
  else if (queueIdx < queue.length - 1) playSong(queueIdx + 1);
  else if (repeatMode) playSong(0);
}

function playPrev() {
  if (typeof isListenTogetherGuest === "function" && isListenTogetherGuest()) { showToast("The host controls this room"); return; }
  if (useAudioEl && getPlaybackEl().currentTime > 3) getPlaybackEl().currentTime = 0;
  else if (ytPlayer?.getCurrentTime?.() > 3) ytPlayer.seekTo(0);
  else if (queueIdx > 0) playSong(queueIdx - 1);
}

function togglePlay() {
  if (queueIdx < 0) return;
  if (typeof isListenTogetherGuest === "function" && isListenTogetherGuest()) { showToast("The host controls this room"); return; }
  if (useAudioEl) { const media = getPlaybackEl(); isPlaying ? media.pause() : media.play(); }
  else if (ytPlayer?.getPlayerState) { isPlaying ? ytPlayer.pauseVideo() : ytPlayer.playVideo(); }
}

function updatePlayBtn() {
  const cls = isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
  $("#btnPlay i").className = cls;
  $("#npfPlay i").className = cls;
  $("#playerBar")?.classList.toggle("is-live", isPlaying);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function updateLikeBtn(id) {
  const liked2 = liked.has(id);
  ["#btnLike", "#npfLike"].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.classList.toggle("liked", liked2);
    const icon = el.querySelector("i");
    if (icon) icon.className = liked2 ? "fa-solid fa-heart" : "fa-regular fa-heart";
  });
}

function updateMiniEq() {
  $("#miniEq").classList.toggle("playing", isPlaying);
}

// ── Queue ──────────────────────────────────────────────────────────────────
function renderQueue() {
  const list = $("#queueList");
  queue = queue.map(normalizeSong);
  list.innerHTML = queue.map((s, i) => {
    const th = cardThumb(s);
    const fb = s.id ? `https://i.ytimg.com/vi/${esc(s.id)}/hqdefault.jpg` : "";
    const img = th
      ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${fb}">`
      : `<div class="qi-thumb-fallback"><i class="fa-solid fa-music"></i></div>`;
    return `
    <div class="queue-item${i === queueIdx ? ' active' : ''}" data-idx="${i}">
      <span class="qi-idx">${i + 1}</span>
      ${img}
      <div class="qi-info"><div class="qi-title">${esc(s.title)}</div><div class="qi-artist">${esc(s.artist)}</div></div>
      <button type="button" class="qi-remove" title="Remove" data-rm="${i}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }).join("");
  bindImgFallback(list);
  list.querySelectorAll(".queue-item").forEach(el => el.addEventListener("click", e => {
    if (e.target.closest(".qi-remove")) return;
    playSong(parseInt(el.dataset.idx));
  }));
  list.querySelectorAll(".qi-remove").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.rm);
      queue.splice(i, 1);
      if (i < queueIdx) queueIdx--;
      else if (i === queueIdx) {
        if (queue.length) playSong(Math.min(queueIdx, queue.length - 1));
        else { queueIdx = -1; currentVideoId = null; }
      }
      renderQueue();
    });
  });
  const active = list.querySelector(".queue-item.active");
  if (active) active.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ── Progress ───────────────────────────────────────────────────────────────
function startProgress() { useAudioEl = false; stopProgress(); progressTimer = setInterval(() => { if (!ytPlayer?.getDuration) return; const d = ytPlayer.getDuration(), c = ytPlayer.getCurrentTime(); if (d > 0) updateProgressUI(c, d); }, 500); }
function startProgressAudio() { stopProgress(); progressTimer = setInterval(() => { const media = getPlaybackEl(); const d = media.duration, c = media.currentTime; if (d && isFinite(d)) updateProgressUI(c, d); }, 500); }
function stopProgress() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

function updateProgressUI(cur, dur) {
  const pct = (cur / dur) * 100;
  $("#progressBar").value = pct * 10;
  $("#progressFill").style.width = pct + "%";
  $("#timeCurrent").textContent = fmtTime(cur);
  $("#timeDuration").textContent = fmtTime(dur);
  $("#npfProgress").value = pct * 10;
  $("#npfProgressFill").style.width = pct + "%";
  $("#npfTimeCurrent").textContent = fmtTime(cur);
  $("#npfTimeDuration").textContent = fmtTime(dur);
  syncLyricsHighlight(cur);
  syncNpfLyrics(cur);
  // Keep the muted full-player video locked to the audio timeline at progress
  // cadence (500ms) — drift can never build up into a visible mismatch.
  try { npfDriftCheck(); } catch {}
  if (navigator.mediaSession?.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: dur || 0, playbackRate: settings.speed || 1, position: Math.min(cur, dur || 0) }); } catch {}
  }
}

// ── Local media events ──────────────────────────────────────────────────────
function bindMediaEvents(media) {
  if (!media) return;
  media.addEventListener("ended", () => { if (useAudioEl && getPlaybackEl() === media) handleEnded(); });
  media.addEventListener("play", () => {
    if (getPlaybackEl() !== media) return;
    isPlaying = true; updatePlayBtn(); startProgressAudio(); updateMiniEq(); npfVideoSync(true);
  });
  media.addEventListener("pause", () => {
    if (useAudioEl && getPlaybackEl() === media) { isPlaying = false; updatePlayBtn(); updateMiniEq(); npfVideoSync(false); }
  });
}
bindMediaEvents(audioEl);
bindMediaEvents(mediaVideo);

// ── Controls ───────────────────────────────────────────────────────────────
$("#btnPlay").addEventListener("click", togglePlay);
$("#btnPrev").addEventListener("click", playPrev);
$("#btnNext").addEventListener("click", playNext);
$("#npfPlay").addEventListener("click", togglePlay);
$("#npfPrev").addEventListener("click", playPrev);
$("#npfNext").addEventListener("click", playNext);

function seekTo(val) {
  // val is 0..1000 from the range input. Convert to absolute time using the
  // *audio* timeline — the single source of truth. Video/embed then follow.
  let target = null;
  const media = getPlaybackEl();
  if (useAudioEl && media.duration && isFinite(media.duration)) {
    target = (val / 1000) * media.duration;
    media.currentTime = target;
  } else if (ytPlayer?.getDuration) {
    try {
      const d = ytPlayer.getDuration();
      if (d) {
        target = (val / 1000) * d;
        ytPlayer.seekTo(target, true);
      }
    } catch {}
  } else if (media.duration && isFinite(media.duration)) {
    target = (val / 1000) * media.duration;
    media.currentTime = target;
  }
  // Drive both <video> and YouTube embed to the same absolute time.
  if (target != null) seekNpfTo(target);
  else seekNpfTo(null);
}
$("#progressBar").addEventListener("input", () => seekTo(parseInt($("#progressBar").value)));
$("#progressBar").addEventListener("change", () => seekTo(parseInt($("#progressBar").value)));
$("#npfProgress").addEventListener("input", () => seekTo(parseInt($("#npfProgress").value)));
$("#npfProgress").addEventListener("change", () => seekTo(parseInt($("#npfProgress").value)));

function setVolume(v) {
  if (ytPlayer?.setVolume) ytPlayer.setVolume(v);
  const media = getPlaybackEl();
  if (eqGain && eqConnected && media) {
    eqGain.gain.value = v / 100;
    media.volume = 1;
  } else if (media) {
    media.volume = v / 100;
  }
  $("#volumeIcon").className = v === 0 ? "fa-solid fa-volume-xmark" : v < 40 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high";
  settings.volume = v;
  saveSettings();
}

// Mobile browsers may suspend Web Audio when the page is backgrounded. The
// HTMLMediaElement remains the source of truth; resume the context and gently
// recover playback without resetting the currentTime.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isPlaying) {
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
    const media = getPlaybackEl();
    if (useAudioEl && media && media.paused) {
      media.play().catch(() => {});
    }
    try { npfVideoSync(true); } catch {}
  }
});
window.addEventListener("pageshow", () => {
  if (!isPlaying) return;
  if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
  const media = getPlaybackEl();
  if (useAudioEl && media?.paused) media.play().catch(() => {});
});
