/* --- FEATURES: sleep timer, settings, toasts, extra controls --- */

// ── Interactive Features ───────────────────────────────────────────────────

let darkMode = settings.darkMode !== false;
let sleepFadeTimer = null;
const STREAK_KEY = "auraListeningStreak";

function readListeningStreak() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY) || '{"count":0,"last":""}'); }
  catch { return { count: 0, last: "" }; }
}
function recordListeningStreak() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const data = readListeningStreak();
  if (data.last !== today) {
    const prev = new Date(`${data.last}T00:00:00`);
    const diff = data.last ? Math.round((new Date(`${today}T00:00:00`) - prev) / 86400000) : 99;
    data.count = diff === 1 ? (data.count || 0) + 1 : 1;
    data.last = today;
    localStorage.setItem(STREAK_KEY, JSON.stringify(data));
  }
  updateStreakBadge();
}
function updateStreakBadge() {
  const badge = $("#streakBadge");
  if (!badge) return;
  const count = readListeningStreak().count || 0;
  badge.querySelector("span").textContent = `${count} day${count === 1 ? "" : "s"} streak`;
}
function updateMiniVisualizer() {
  $("#playerBar")?.classList.toggle("is-live", Boolean(isPlaying));
}
window.recordListeningStreak = recordListeningStreak;
updateStreakBadge();
setInterval(updateMiniVisualizer, 500);

// Now Playing Mini Click - Open Full Player
$("#nowMini")?.addEventListener("click", () => {
  if (currentVideoId) {
    openFullPlayer();
  }
});

// Sleep Timer modal
function setSleepTimer(minutes) {
  if (sleepTimer) clearTimeout(sleepTimer);
  if (sleepFadeTimer) clearInterval(sleepFadeTimer);
  if (!minutes) {
    sleepTimer = null; sleepFadeTimer = null; sleepEndsAt = 0;
    $("#sleepTimerBtn i").className = "fa-solid fa-moon";
    showToast("Sleep timer cancelled");
    return;
  }
  sleepEndsAt = Date.now() + minutes * 60 * 1000;
  const fadeStart = Math.max(0, minutes * 60 * 1000 - 15000);
  sleepTimer = setTimeout(() => {
    const startedAt = Date.now();
    const startVolume = Number(settings.volume ?? 80);
    sleepFadeTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / 15000);
      setVolume(Math.round(startVolume * (1 - progress)));
      if (progress >= 1) {
        clearInterval(sleepFadeTimer); sleepFadeTimer = null;
        if (isPlaying) togglePlay();
        setVolume(startVolume);
        sleepTimer = null; sleepEndsAt = 0;
        $("#sleepTimerBtn i").className = "fa-solid fa-moon";
        showToast("Good night — music faded out");
      }
    }, 500);
  }, fadeStart);
  $("#sleepTimerBtn i").className = "fa-solid fa-check";
  showToast(`Sleep timer: ${minutes} min · 15s fade`);
}

$("#sleepTimerBtn")?.addEventListener("click", () => {
  openModal(`
    <h3>Sleep timer</h3>
    <p class="modal-sub">Fade out playback after a set time</p>
    <div class="chip-row" id="sleepChips">
      ${[15, 30, 45, 60, 90].map(m => `<button type="button" data-m="${m}">${m} min</button>`).join("")}
      <button type="button" data-m="0">Off</button>
    </div>
    <div class="modal-actions"><button type="button" class="btn-ghost" id="modalCancel">Close</button></div>`);
  $("#modalCancel").onclick = closeModal;
  $$("#sleepChips button").forEach(b => b.onclick = () => { setSleepTimer(parseInt(b.dataset.m)); closeModal(); });
});

// Share
$("#shareBtn")?.addEventListener("click", () => shareSong(queue[queueIdx]));

// Settings modal
function openSettings() {
  openModal(`
    <h3>Settings</h3>
    <p class="modal-sub">Playback & experience</p>
    <div class="toggle-row"><span>Autoplay radio</span>
      <input type="checkbox" id="setAutoRadio" ${settings.autoplayRadio !== false ? "checked" : ""}></div>
    <div class="toggle-row"><span>Show toasts</span>
      <input type="checkbox" id="setToasts" ${settings.showToasts !== false ? "checked" : ""}></div>
    <div class="field"><label>Default volume</label>
      <input type="range" id="setVol" min="0" max="100" value="${settings.volume ?? 80}"></div>
    <div class="field"><label>Playback speed</label>
      <select id="setSpeed">
        ${playbackRates.map(r => `<option value="${r}" ${Number(settings.speed) === r ? "selected" : ""}>${r}×</option>`).join("")}
      </select></div>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" id="modalCancel">Cancel</button>
      <button type="button" class="btn-primary sm" id="modalOk">Save</button>
    </div>`);
  $("#modalCancel").onclick = closeModal;
  $("#modalOk").onclick = () => {
    settings.autoplayRadio = $("#setAutoRadio").checked;
    settings.showToasts = $("#setToasts").checked;
    settings.volume = parseInt($("#setVol").value);
    settings.speed = parseFloat($("#setSpeed").value);
    rateIdx = Math.max(0, playbackRates.indexOf(settings.speed));
    saveSettings();
    $("#volumeBar").value = settings.volume;
    setVolume(settings.volume);
    applyPlaybackRate();
    closeModal();
    showToast("Settings saved");
  };
}
$("#settingsBtn")?.addEventListener("click", openSettings);

$("#btnShortcuts")?.addEventListener("click", () => {
  openModal(`
    <h3>Keyboard shortcuts</h3>
    <div class="kbd-list">
      <div><span>Play / Pause</span><kbd>Space</kbd></div>
      <div><span>Next</span><kbd>Shift + →</kbd></div>
      <div><span>Previous</span><kbd>Shift + ←</kbd></div>
      <div><span>Like</span><kbd>L</kbd></div>
      <div><span>Queue</span><kbd>Q</kbd></div>
      <div><span>Lyrics</span><kbd>Y</kbd></div>
      <div><span>Search focus</span><kbd>/</kbd></div>
      <div><span>Close panels</span><kbd>Esc</kbd></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn-primary sm" id="modalCancel">Got it</button></div>`);
  $("#modalCancel").onclick = closeModal;
});

// Toast
function showToast(message) {
  if (settings.showToasts === false) return;
  const toast = document.createElement("div");
  toast.className = "toast-notification";
  toast.innerHTML = `<i class="fa-solid fa-bell"></i><span>${esc(message)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

$("#profileSection")?.addEventListener("click", e => {
  if (e.target.closest("#themeToggle")) return;
  showToast("Welcome back, Music Lover");
});

// Extra controls
$("#btnLyrics")?.addEventListener("click", toggleLyrics);
$("#npfLyricsBtn")?.addEventListener("click", () => { closeFullPlayer(); toggleLyrics(); });
$("#closeLyrics")?.addEventListener("click", () => $("#lyricsPanel").classList.remove("open"));
$("#btnRadio")?.addEventListener("click", () => queue[queueIdx] && startRadio(queue[queueIdx]));
$("#npfRadio")?.addEventListener("click", () => queue[queueIdx] && startRadio(queue[queueIdx]));
$("#radioRefresh")?.addEventListener("click", () => {
  if (queue[queueIdx]) startRadio(queue[queueIdx]);
  else loadRadioView();
});
$("#clearQueue")?.addEventListener("click", () => {
  if (queueIdx >= 0) queue = [queue[queueIdx]];
  else queue = [];
  queueIdx = queue.length ? 0 : -1;
  renderQueue();
  showToast("Queue cleared");
});
$("#btnSpeed")?.addEventListener("click", () => {
  rateIdx = (rateIdx + 1) % playbackRates.length;
  settings.speed = playbackRates[rateIdx];
  saveSettings();
  applyPlaybackRate();
  showToast(`Speed ${settings.speed}×`);
});

function promptNewPlaylist() {
  openModal(`
    <h3>New playlist</h3>
    <div class="field"><label>Name</label><input id="plNameInput" placeholder="Late night drive" autofocus></div>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" id="modalCancel">Cancel</button>
      <button type="button" class="btn-primary sm" id="modalOk">Create</button>
    </div>`);
  $("#modalCancel").onclick = closeModal;
  $("#modalOk").onclick = () => {
    const name = $("#plNameInput").value.trim() || "My Playlist";
    const pl = createPlaylist(name);
    closeModal();
    switchView("playlists");
    renderPlaylists();
    showToast(`Created “${pl.name}”`);
  };
  setTimeout(() => $("#plNameInput")?.focus(), 50);
}
$("#createPlaylistBtn")?.addEventListener("click", promptNewPlaylist);
$("#createPlaylistBtn2")?.addEventListener("click", promptNewPlaylist);

$("#exportLiked")?.addEventListener("click", () => {
  const songs = getLikedSongs();
  const blob = new Blob([JSON.stringify(songs, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "aura-liked-songs.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Exported ${songs.length} liked songs`);
});

$("#playLikedAll")?.addEventListener("click", () => {
  const songs = getLikedSongs();
  if (songs.length) playSongFromList(songs, 0);
  else showToast("No liked songs yet");
});
