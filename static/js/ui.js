/* --- UI: context menu, modals, search suggestions --- */

// ── Context menu / modals ──────────────────────────────────────────────────
function openCtxMenu(x, y, song, list) {
  ctxSong = song; ctxList = list || null;
  const menu = $("#ctxMenu");
  menu.hidden = false;
  const pad = 8;
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 280;
  menu.style.left = Math.min(x, window.innerWidth - mw - pad) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - pad) + "px";
}
function closeCtxMenu() { $("#ctxMenu").hidden = true; ctxSong = null; }

function openModal(html) {
  $("#modalRoot").innerHTML = html;
  $("#modalBackdrop").hidden = false;
}
function closeModal() { $("#modalBackdrop").hidden = true; $("#modalRoot").innerHTML = ""; }

function openPlaylistPicker(song) {
  if (!playlists.length) {
    const pl = createPlaylist("Liked Mix");
    addSongToPlaylist(song, pl.id);
    return;
  }
  openModal(`
    <h3>Add to playlist</h3>
    <p class="modal-sub">${esc(song.title)}</p>
    <div class="playlist-pick-list">
      ${playlists.map(p => `<button type="button" data-id="${esc(p.id)}">${esc(p.name)} · ${p.songs.length}</button>`).join("")}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" id="modalNewPl">New playlist</button>
      <button type="button" class="btn-ghost" id="modalCancel">Close</button>
    </div>`);
  $("#modalCancel").onclick = closeModal;
  $("#modalNewPl").onclick = () => {
    const name = prompt("Playlist name", "My Playlist");
    if (!name) return;
    const pl = createPlaylist(name);
    addSongToPlaylist(song, pl.id);
    closeModal();
  };
  $$("#modalRoot .playlist-pick-list button").forEach(btn => {
    btn.onclick = () => { addSongToPlaylist(song, btn.dataset.id); closeModal(); };
  });
}

$("#ctxMenu")?.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !ctxSong) return;
  const act = btn.dataset.act;
  const song = ctxSong;
  const list = ctxList;
  closeCtxMenu();
  if (act === "play") {
    if (list) playSongFromList(list, list.findIndex(s => s.id === song.id));
    else playSongFromList([song], 0);
  } else if (act === "next") {
    queue.splice(queueIdx + 1, 0, song);
    renderQueue(); showToast("Queued next");
  } else if (act === "queue") {
    queue.push(song); renderQueue(); showToast("Added to queue");
  } else if (act === "radio") {
    await startRadio(song);
  } else if (act === "like") {
    toggleLikeSong(song);
  } else if (act === "playlist") {
    openPlaylistPicker(song);
  } else if (act === "share") {
    shareSong(song);
  }
});
document.addEventListener("click", e => {
  if (!e.target.closest("#ctxMenu") && !e.target.closest(".card-more")) closeCtxMenu();
});
$("#modalBackdrop")?.addEventListener("click", e => { if (e.target.id === "modalBackdrop") closeModal(); });

// ── Search Suggestions ─────────────────────────────────────────────────────
let suggestTimer;
$("#searchInput").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("#searchInput").value.trim();
  if (!q) { $("#searchSuggestions").classList.remove("open"); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const sugs = await api(`/api/search_suggestions?q=${encodeURIComponent(q)}`);
      if (sugs.length) {
        $("#searchSuggestions").innerHTML = sugs.map(s => `<div class="suggestion"><i class="fa-solid fa-magnifying-glass"></i>${s}</div>`).join("");
        $("#searchSuggestions").classList.add("open");
        $("#searchSuggestions").querySelectorAll(".suggestion").forEach(el => {
          el.addEventListener("click", () => { $("#searchInput").value = el.textContent; $("#searchSuggestions").classList.remove("open"); doSearch(el.textContent); });
        });
      } else { $("#searchSuggestions").classList.remove("open"); }
    } catch { $("#searchSuggestions").classList.remove("open"); }
  }, 300);
});
$("#searchInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { clearTimeout(suggestTimer); $("#searchSuggestions").classList.remove("open"); doSearch($("#searchInput").value); }
});
document.addEventListener("click", e => { if (!e.target.closest(".search-box")) $("#searchSuggestions").classList.remove("open"); });

// Search filters
$$(".filter-chip").forEach(el => {
  el.addEventListener("click", async () => {
    $$(".filter-chip").forEach(c => c.classList.remove("active"));
    el.classList.add("active");
    const q = $("#searchInput").value.trim();
    if (!q) return;
    const f = el.dataset.filter;
    showLoading();
    try {
      const endpoint = f === "all" ? `/api/search_all?q=${encodeURIComponent(q)}` : `/api/search?q=${encodeURIComponent(q)}&filter=${f}`;
      const items = await api(endpoint);
      $("#searchEmpty").style.display = items.length ? "none" : "block";
      renderSearchResults(items, $("#searchResults"));
    } catch {}
    hideLoading();
  });
});
