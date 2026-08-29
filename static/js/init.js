/* --- INIT: keyboard, theme, startup --- */

// ── Keyboard ───────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
    if (e.code === "Escape") { e.target.blur(); closeModal(); }
    return;
  }
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowRight" && e.shiftKey) playNext();
  if (e.code === "ArrowLeft" && e.shiftKey) playPrev();
  if (e.code === "KeyL") toggleLike();
  if (e.code === "KeyQ") { $("#queuePanel").classList.toggle("open"); renderQueue(); }
  if (e.code === "KeyY") toggleLyrics();
  if (e.code === "KeyE") toggleEqPanel();
  if (e.key === "/") { e.preventDefault(); $("#searchInput")?.focus(); }
  if (e.code === "Escape") {
    closeFullPlayer();
    $("#lyricsPanel")?.classList.remove("open");
    $("#queuePanel")?.classList.remove("open");
    toggleEqPanel(false);
    closeModal(); closeCtxMenu();
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  darkMode = dark;
  settings.darkMode = dark;
  const icon = $("#themeToggle i");
  const root = document.documentElement;
  if (dark) {
    root.style.setProperty("--bg", "#07060d");
    root.style.setProperty("--text", "#f4f1ff");
    root.style.setProperty("--text-mid", "#a39bb8");
    root.style.setProperty("--text-dim", "#7d7594");
    root.style.setProperty("--line", "rgba(255,255,255,0.08)");
    if (icon) icon.className = "fa-solid fa-moon";
  } else {
    root.style.setProperty("--bg", "#f3f0ff");
    root.style.setProperty("--text", "#161225");
    root.style.setProperty("--text-mid", "#5b5470");
    root.style.setProperty("--text-dim", "#7a7390");
    root.style.setProperty("--line", "rgba(22,18,37,0.1)");
    if (icon) icon.className = "fa-solid fa-sun";
  }
}

$("#themeToggle")?.addEventListener("click", e => {
  e.stopPropagation();
  applyTheme(!darkMode);
  saveSettings();
});

updateGreeting();
if (settings.volume != null) {
  $("#volumeBar").value = settings.volume;
  lastVol = settings.volume;
  setVolume(settings.volume);
}
const savedRateIdx = playbackRates.indexOf(Number(settings.speed) || 1);
rateIdx = savedRateIdx >= 0 ? savedRateIdx : 1;
applyPlaybackRate();
if (settings.darkMode === false) applyTheme(false);
renderEqUi();
if (settings.eqPreset && settings.eqPreset !== "flat") {
  ["#btnEq", "#npfEq"].forEach(sel => $(sel)?.classList.toggle("eq-on", true));
}
loadTrending();
renderQueue();
updateNavArrows();
updateLibraryCounts();
renderRecentSearches();
