/* --- EQ: Web Audio equalizer, visualizer, presets --- */

// ── Equalizer (Web Audio) ──────────────────────────────────────────────────
const EQ_PRESETS = [
  { id: "flat", name: "Flat", icon: "fa-minus", gains: [0, 0, 0, 0, 0], eightD: false, filter: null },
  { id: "bass", name: "Bass", icon: "fa-boombox", gains: [8, 5, 0, -1, -2], eightD: false, filter: null },
  { id: "treble", name: "Treble", icon: "fa-wave-square", gains: [-2, -1, 1, 5, 7], eightD: false, filter: null },
  { id: "vocal", name: "Vocal", icon: "fa-microphone", gains: [-2, 1, 5, 4, 1], eightD: false, filter: null },
  { id: "lofi", name: "Lo-fi", icon: "fa-cloud-moon", gains: [4, 2, -2, -6, -10], eightD: false, filter: "lofi" },
  { id: "8d", name: "8D", icon: "fa-headphones", gains: [2, 1, 0, 2, 3], eightD: true, filter: null },
  { id: "dance", name: "Dance", icon: "fa-compact-disc", gains: [6, 3, -1, 2, 5], eightD: false, filter: null },
  { id: "cinema", name: "Cinema", icon: "fa-film", gains: [5, 2, 0, 2, 4], eightD: false, filter: null },
  { id: "night", name: "Night", icon: "fa-moon", gains: [3, 1, -1, -3, -5], eightD: false, filter: "soft" },
  { id: "rock", name: "Rock", icon: "fa-guitar", gains: [5, 3, -1, 2, 4], eightD: false, filter: null },
];

let eqGraphBuilt = false;
let eqSourceEl = null;
const eqSources = new WeakMap();
const eqWiredSources = new WeakSet();
function ensureEqGraph(sourceEl = getPlaybackEl()) {
  if (!sourceEl) return false;
  // Always rebuild the graph when switching between audio and video sources
  // to ensure EQ works for both songs and videos
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !audioEl) return false;
    audioCtx = audioCtx || new AC();
    // Bind lazily to the element that is actually carrying the current track.
    // Each HTMLMediaElement can only be wrapped once, so reuse its source node.
    mediaSource = eqSources.get(sourceEl);
    if (!mediaSource) {
      mediaSource = audioCtx.createMediaElementSource(sourceEl);
      eqSources.set(sourceEl, mediaSource);
    }
    eqSourceEl = sourceEl;
    if (!eqFilters.length) {
      const freqs = [60, 230, 910, 3600, 14000];
      eqFilters = freqs.map((f, i) => {
        const b = audioCtx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === freqs.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      eqPanner = audioCtx.createStereoPanner();
      eqGain = audioCtx.createGain();
      eqGain.gain.value = parseInt($("#volumeBar")?.value || settings.volume || 80, 10) / 100;
    }
    if (!eqWiredSources.has(mediaSource)) {
      // source -> filters -> panner -> gain -> destination
      let node = mediaSource;
      eqFilters.forEach(f => { node.connect(f); node = f; });
      node.connect(eqPanner);
      eqPanner.connect(eqGain);
      eqGain.connect(audioCtx.destination);
      eqWiredSources.add(mediaSource);
      eqGraphBuilt = true;
    }
    sourceEl.volume = 1;
    eqConnected = true;
    return true;
  } catch (e) {
    console.warn("EQ unavailable", e);
    eqConnected = false;
    return false;
  }
}

function setEqGains(preset) {
  if (eqFilters?.length && preset.gains) {
    eqFilters.forEach((f, i) => {
      let g = preset.gains[i] ?? 0;
      if (preset.filter === "lofi" && i >= 3) g = Math.min(g, -6);
      if (preset.filter === "soft" && i === 4) g = Math.min(g, -4);
      f.gain.value = g;
    });
  }
  // lofi caps the top band as a highshelf on top of its listed gain
  if (eqFilters[4]) {
    eqFilters[4].type = "highshelf";
    if (preset.filter === "lofi") eqFilters[4].gain.value = -12;
  }
}

function stopEightD() {
  if (eightDTimer) { clearInterval(eightDTimer); eightDTimer = null; }
  if (eqPanner) eqPanner.pan.value = 0;
}

function startEightD() {
  stopEightD();
  if (!eqPanner) return;
  eightDAngle = 0;
  eightDTimer = setInterval(() => {
    eightDAngle += 0.04;
    if (eqPanner) eqPanner.pan.value = Math.sin(eightDAngle) * 0.92;
  }, 40);
}

// NOTE: There is intentionally NO source-swapping here. Audio always plays
// through the same-origin proxy (/api/stream — see player.js), so enabling or
// changing the EQ never needs to touch audioEl.src. Applying a preset only
// wires the Web Audio graph and updates filter gains — nothing can restart.

// ── Live visualizer ────────────────────────────────────────────────────────
let eqAnalyser = null, eqVizRaf = null;
function startEqViz() {
  stopEqViz();
  const viz = $("#eqViz");
  if (!viz) return;
  viz.classList.add("live");
  if (!eqConnected || !audioCtx) return;   // CSS animation keeps running
  viz.classList.add("driven");
  try {
    eqAnalyser = audioCtx.createAnalyser();
    eqAnalyser.fftSize = 128;
    eqAnalyser.smoothingTimeConstant = 0.72;
    eqGain.connect(eqAnalyser);
  } catch (e) { console.warn("analyser", e); eqAnalyser = null; return; }
  const data = new Uint8Array(eqAnalyser.frequencyBinCount);
  const spans = viz.querySelectorAll("span");
  const step = () => {
    if (!$("#eqPanel")?.classList.contains("open")) { stopEqViz(); return; }
    eqAnalyser.getByteFrequencyData(data);
    const n = data.length, m = spans.length;
    for (let i = 0; i < m; i++) {
      const bin = Math.floor(Math.pow(i / Math.max(m - 1, 1), 1.4) * (n - 1));
      const v = data[bin] / 255;
      spans[i].style.height = (14 + v * 80) + "%";
    }
    eqVizRaf = requestAnimationFrame(step);
  };
  eqVizRaf = requestAnimationFrame(step);
}
function stopEqViz() {
  if (eqVizRaf) { cancelAnimationFrame(eqVizRaf); eqVizRaf = null; }
  if (eqAnalyser) { try { eqGain?.disconnect(eqAnalyser); } catch {} eqAnalyser = null; }
  const viz = $("#eqViz");
  if (viz) {
    viz.classList.remove("driven");
    viz.querySelectorAll("span").forEach(s => { s.style.height = ""; });
  }
}

async function applyEqPreset(id) {
  const preset = EQ_PRESETS.find(p => p.id === id) || EQ_PRESETS[0];
  settings.eqPreset = preset.id;
  saveSettings();
  // Audio is always served via the same-origin proxy (see player.js), so
  // applying/switching a preset is purely a Web Audio operation — the media
  // element, its src, and the muted video are never touched → no restarts.
  const connected = ensureEqGraph();
  if (audioCtx?.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  // If graph was just created on a playing stream, filters start at 0 — apply now
  if (connected) setEqGains(preset);
  if (preset.eightD) startEightD();
  else stopEightD();
  renderEqUi();
  startEqViz();
  ["#btnEq", "#npfEq"].forEach(sel => $(sel)?.classList.toggle("eq-on", preset.id !== "flat"));
}

function renderEqUi() {
  const box = $("#eqPresets");
  if (!box) return;
  const cur = settings.eqPreset || "flat";
  box.innerHTML = EQ_PRESETS.map(p => `
    <button type="button" class="eq-preset${p.id === cur ? " active" : ""}" data-eq="${p.id}">
      <i class="fa-solid ${p.icon}"></i><span>${p.name}</span>
    </button>`).join("");
  box.querySelectorAll(".eq-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      applyEqPreset(btn.dataset.eq);
      showToast(`EQ · ${EQ_PRESETS.find(p => p.id === btn.dataset.eq)?.name || ""}`);
    });
  });
  const meta = $("#eqMeta");
  if (meta) meta.textContent = `Preset: ${EQ_PRESETS.find(p => p.id === cur)?.name || "Flat"} · songs + videos`;
}

function toggleEqPanel(force) {
  const panel = $("#eqPanel");
  if (!panel) return;
  const isOpen = panel.classList.contains("open") && !panel.hidden;
  const open = force === true ? true : force === false ? false : !isOpen;
  if (open) {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("open"));
    renderEqUi();
    startEqViz();
  } else {
    panel.classList.remove("open");
    stopEqViz();
    setTimeout(() => { panel.hidden = true; }, 280);
  }
}
$("#volumeBar").addEventListener("input", () => setVolume(parseInt($("#volumeBar").value)));
$("#btnEq")?.addEventListener("click", () => toggleEqPanel());
$("#npfEq")?.addEventListener("click", () => toggleEqPanel());
$("#closeEq")?.addEventListener("click", () => toggleEqPanel(false));

// shuffle
function toggleShuffle() { shuffleOn = !shuffleOn; $("[id='btnShuffle'],#npfShuffle").forEach(el => el?.classList.toggle("active", shuffleOn)); }
$("#btnShuffle").addEventListener("click", toggleShuffle);
$("#npfShuffle").addEventListener("click", toggleShuffle);

// repeat
function cycleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  $$("[id='btnRepeat'],#npfRepeat").forEach(el => {
    if (!el) return;
    el.classList.toggle("active", repeatMode > 0);
    el.innerHTML = repeatMode === 2 ? '<i class="fa-solid fa-repeat"></i><span style="font-size:.5rem;position:absolute;bottom:2px;right:2px">1</span>' : '<i class="fa-solid fa-repeat"></i>';
    if (repeatMode === 2) el.style.position = "relative";
  });
}
$("#btnRepeat").addEventListener("click", cycleRepeat);
$("#npfRepeat").addEventListener("click", cycleRepeat);

// queue toggle
$("#btnQueue").addEventListener("click", () => { $("#queuePanel").classList.toggle("open"); renderQueue(); });
$("#npfQueue").addEventListener("click", () => { $("#queuePanel").classList.toggle("open"); renderQueue(); });
$("#closeQueue").addEventListener("click", () => $("#queuePanel").classList.remove("open"));

// like
function toggleLikeSong(song) {
  if (!song?.id) return;
  if (liked.has(song.id)) {
    liked.delete(song.id);
    delete likedSongsMap[song.id];
    showToast("Removed from Liked");
  } else {
    liked.add(song.id);
    likedSongsMap[song.id] = song;
    showToast("Added to Liked");
  }
  saveLiked(); updateLikeBtn(song.id); updateLibraryCounts();
}
function toggleLike() {
  if (queueIdx < 0) return;
  toggleLikeSong(queue[queueIdx]);
}
$("#btnLike")?.addEventListener("click", toggleLike);
$("#npfLike")?.addEventListener("click", toggleLike);

function applyPlaybackRate() {
  const r = settings.speed || 1;
  getPlaybackEl().playbackRate = r;
  try { ytPlayer?.setPlaybackRate?.(r); } catch {}
  if ($("#btnSpeed")) {
    $("#btnSpeed").textContent = (r % 1 === 0 ? r.toFixed(0) : r) + "×";
    $("#btnSpeed").classList.toggle("active", r !== 1);
  }
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album || "Aura",
    artwork: song.thumbnail ? [{ src: song.thumbnail, sizes: "512x512", type: "image/jpeg" }] : [],
  });
  navigator.mediaSession.setActionHandler("play", () => { if (!isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler("pause", () => { if (isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler("previoustrack", playPrev);
  navigator.mediaSession.setActionHandler("nexttrack", playNext);
  navigator.mediaSession.setActionHandler("seekto", details => {
    if (details.seekTime == null) return;
    if (useAudioEl) getPlaybackEl().currentTime = details.seekTime;
    else ytPlayer?.seekTo?.(details.seekTime, true);
  });
}

async function shareSong(song) {
  if (!song) { showToast("Nothing to share"); return; }
  const url = `https://music.youtube.com/watch?v=${song.id}`;
  const shareData = { title: song.title, text: `${song.title} · ${song.artist}`, url };
  try {
    if (navigator.share) await navigator.share(shareData);
    else { await navigator.clipboard.writeText(`${shareData.text}\n${url}`); showToast("Link copied"); }
  } catch {}
}

// volume mute
let lastVol = 80;
$("#btnVolume").addEventListener("click", () => {
  const bar = $("#volumeBar");
  parseInt(bar.value) > 0 ? (lastVol = parseInt(bar.value), bar.value = 0) : (bar.value = lastVol);
  bar.dispatchEvent(new Event("input"));
});
