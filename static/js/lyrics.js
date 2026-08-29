/* --- LYRICS: fetch + sync engine --- */

// ── Lyrics ─────────────────────────────────────────────────────────────────
async function loadLyrics(song) {
  const body = $("#lyricsBody");
  if (!body || !song) return;
  const reqId = ++lyricsReqCounter;
  // Only apply results if this song is still the one being listened to —
  // rapid skips can otherwise let an older, slower lyrics response win and
  // leave the box/panel showing the wrong song (or nothing).
  const isCurrent = () => currentVideoId === song.id;
  const th = $("#lyricsThumb");
  if (th) {
    th.src = songThumb(song) || "";
    th.onerror = () => { th.removeAttribute("src"); };
  }
  const tt = $("#lyricsTrackTitle");
  if (tt) tt.textContent = song.title;
  const ta = $("#lyricsTrackArtist");
  if (ta) ta.textContent = song.artist || "";
  body.innerHTML = `<p class="lyrics-placeholder">Loading lyrics…</p>`;
  lyricsSynced = []; lyricsPlain = "";
  lastLyricIdx = -1;
  hideNpfLyrics();
  try {
    const data = await api(`/api/lyrics?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || "")}`);
    if (!isCurrent()) return;
    lyricsLoadedFor = song.id;
    if (data.instrumental) {
      body.innerHTML = `<p class="lyrics-placeholder">Instrumental track — no lyrics</p>`;
    } else {
      lyricsSynced = data.synced || [];
      lyricsPlain = data.lyrics || "";
      if (lyricsSynced.length) {
        body.innerHTML = lyricsSynced.map((l, i) =>
          `<div class="line" data-i="${i}" style="animation-delay:${Math.min(i * 45, 600)}ms">${esc(l.text)}</div>`
        ).join("");
      } else if (lyricsPlain) {
        const lines = lyricsPlain.split(/\r?\n/).map(l => l.trim());
        body.innerHTML = lines.length
          ? lines.map(l => `<div class="line plain">${l ? esc(l) : "&nbsp;"}</div>`).join("")
          : `<p class="lyrics-placeholder">No lyrics found</p>`;
      } else {
        body.innerHTML = `<p class="lyrics-placeholder">No lyrics found for this track</p>`;
      }
    }
  } catch {
    if (!isCurrent()) return;
    lyricsLoadedFor = song.id;
    body.innerHTML = `<p class="lyrics-placeholder">Lyrics unavailable — check the track title</p>`;
  }
  // Fullscreen is reserved for timed karaoke. Plain/script lyrics remain
  // available in the dedicated lyrics panel, never inside the fullscreen art.
  if (isCurrent() && $("#nowPlayingFull").classList.contains("open")) updateNpfDisplay();
}

let lastLyricIdx = -1;

function syncLyricsHighlight(t) {
  if (!lyricsSynced.length) return;
  let idx = 0;
  for (let i = 0; i < lyricsSynced.length; i++) {
    if (lyricsSynced[i].t <= t) idx = i; else break;
  }
  const lines = $$("#lyricsBody .line");
  lines.forEach((el, i) => {
    const isActive = i === idx;
    el.classList.toggle("active", isActive);
    el.classList.toggle("past", !isActive && i < idx);
    if (isActive) el.classList.remove("past");
  });
  if (idx === lastLyricIdx) return;
  lastLyricIdx = idx;
  // only scroll when the active line actually moves (not every 500ms tick)
  const cur = lines[idx];
  const body = $("#lyricsBody");
  if (cur && body) {
    const r = cur.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    if (r.top < br.top + 30 || r.bottom > br.bottom - 30) {
      cur.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function toggleLyrics() {
  const panel = $("#lyricsPanel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open") && queue[queueIdx]) loadLyrics(queue[queueIdx]);
}

// ── Full-screen word-by-word lyrics (image-only songs) ────────────────────
function computeWordTimings() {
  npfWordTimings = [];
  if (!lyricsSynced.length) return;
  for (let i = 0; i < lyricsSynced.length; i++) {
    const line = lyricsSynced[i];
    const nextT = (i + 1 < lyricsSynced.length) ? lyricsSynced[i + 1].t : line.t + 4;
    const words = line.text.split(/\s+/).filter(w => w.length > 0);
    if (!words.length) { npfWordTimings.push({ t: line.t, words: [], lineIdx: i }); continue; }
    const dur = Math.max(nextT - line.t, 0.4);
    const wDur = dur / words.length;
    npfWordTimings.push({ t: line.t, words: words.map((w, wi) => ({ text: w, t: line.t + wi * wDur })), lineIdx: i });
  }
}

function renderNpfLine(lineIdx) {
  const line = npfWordTimings[lineIdx];
  const el = $("#npfLyrics");
  if (!line || !el) return;
  el.innerHTML = `<div class="npf-lyrics-box"><div class="npf-lyrics-line">${line.words.map((w, wi) =>
    `<span class="npf-lyrics-word" data-w="${wi}">${esc(w.text)}</span>`
  ).join("")}</div></div>`;
  npfLineRendered = lineIdx;
}

function syncNpfLyrics(t) {
  const el = $("#npfLyrics");
  if (!el || !el.classList.contains("visible") || !npfWordTimings.length) return;
  let lineIdx = -1;
  for (let i = 0; i < npfWordTimings.length; i++) {
    if (npfWordTimings[i].t <= t) lineIdx = i; else break;
  }
  if (lineIdx < 0) lineIdx = 0;
  const line = npfWordTimings[lineIdx];
  if (!line || !line.words.length) {
    if (npfLineRendered !== -1) { el.innerHTML = ""; npfLineRendered = -1; }
    return;
  }
  // Find current word within the line
  let wordIdx = -1;
  for (let i = 0; i < line.words.length; i++) {
    if (line.words[i].t <= t) wordIdx = i; else break;
  }
  if (wordIdx < 0) wordIdx = 0;
  if (lineIdx !== npfLineRendered) renderNpfLine(lineIdx);
  // Animate only the classes — no DOM rebuild while singing inside a line
  el.querySelectorAll(".npf-lyrics-word").forEach((s, wi) => {
    const cls = wi < wordIdx ? "sung" : wi === wordIdx ? "active" : "upcoming";
    if (s.className !== "npf-lyrics-word " + cls) s.className = "npf-lyrics-word " + cls;
  });
}
