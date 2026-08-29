/* --- BROWSE: API, trending, search, artists, albums, playlists, radio --- */

// ── Render Songs ───────────────────────────────────────────────────────────

function renderSongs(songs, container) {
  songs = (songs || []).map(normalizeSong);
  container.innerHTML = songs.map((s, i) => {
    const th = cardThumb(s);
    const fb = s.id ? `https://i.ytimg.com/vi/${esc(s.id)}/mqdefault.jpg` : "";
    return `
    <div class="song-card${currentVideoId === s.id ? ' active' : ''}" data-idx="${i}" data-id="${esc(s.id)}">
      <button type="button" class="card-more" title="More" aria-label="More"><i class="fa-solid fa-ellipsis"></i></button>
      <div class="thumb-wrap">
        <img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${fb}">
        ${s.type === "video" ? '<span class="type-badge">Video</span>' : ""}
        <div class="play-overlay"><div class="play-icon"><i class="fa-solid fa-play"></i></div></div>
      </div>
      <div class="info">
        <div class="title" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="artist" data-artist="${esc(s.artist)}">${esc(s.artist)}</div>
        ${s.duration ? `<div class="duration">${esc(s.duration)}</div>` : ''}
      </div>
    </div>`;
  }).join("");

  bindImgFallback(container);
  container.querySelectorAll(".song-card").forEach(card => {
    card.addEventListener("click", () => { playSongFromList(songs, parseInt(card.dataset.idx)); });
    card.addEventListener("contextmenu", e => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, songs[parseInt(card.dataset.idx)], songs);
    });
    card.querySelector(".card-more")?.addEventListener("click", e => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openCtxMenu(r.left, r.bottom + 4, songs[parseInt(card.dataset.idx)], songs);
    });
  });
  container.querySelectorAll(".artist").forEach(el => {
    el.addEventListener("click", e => { e.stopPropagation(); const n = el.dataset.artist; if (n && n !== "Unknown") doSearch(n); });
  });
}

function renderAlbums(albums, container) {
  container.innerHTML = albums.map(a => `
    <div class="album-card" data-id="${a.id}">
      <img src="${esc(cardThumb(a.thumbnail))}" alt="" loading="lazy">
      <div class="info"><div class="title">${a.title}</div><div class="year">${a.year || ''}</div></div>
    </div>`).join("");
  container.querySelectorAll(".album-card").forEach(c => c.addEventListener("click", () => loadAlbum(c.dataset.id)));
}

function renderArtists(artists, container) {
  container.innerHTML = artists.map(a => `
    <div class="artist-card" data-id="${a.id}">
      <img src="${esc(cardThumb(a.thumbnail))}" alt="" loading="lazy">
      <span>${a.name}</span>
    </div>`).join("");
  container.querySelectorAll(".artist-card").forEach(c => c.addEventListener("click", () => loadArtist(c.dataset.id)));
}

/**
 * Render mixed search results (songs / videos / albums / artists) into one
 * container. Songs & videos go into the song grid, albums and artists into
 * their own labelled sections so each card type is clickable.
 */
function renderSearchResults(items, container) {
  items = (items || []).filter(i => i);
  const songs = items.filter(i => i.type === "song" || i.type === "video" || !i.type);
  const albums = items.filter(i => i.type === "album");
  const artists = items.filter(i => i.type === "artist");
  container.innerHTML = "";
  if (songs.length) {
    const grid = document.createElement("div");
    grid.className = "song-grid";
    container.appendChild(grid);
    renderSongs(songs, grid);
  }
  if (albums.length) {
    const h = document.createElement("h3");
    h.className = "inline-heading";
    h.textContent = "Albums";
    container.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "album-grid";
    container.appendChild(grid);
    renderAlbums(albums, grid);
  }
  if (artists.length) {
    const h = document.createElement("h3");
    h.className = "inline-heading";
    h.textContent = "Artists";
    container.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "artist-grid";
    container.appendChild(grid);
    renderArtists(artists, grid);
  }
  if (!songs.length && !albums.length && !artists.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-orb"><i class="fa-solid fa-magnifying-glass"></i></div><p>No results found</p></div>`;
  }
}

// ── API ────────────────────────────────────────────────────────────────────
const apiCache = new Map();

/**
 * GET + JSON with a tiny in-memory TTL cache. The backend also caches, but
 * this avoids repeat round-trips entirely (view switching back and forth,
 * mood → trending, etc.). /api/audio and /api/video are excluded — those
 * hand out short-lived stream URLs and must always be fresh.
 */
async function api(path, ttl = 90000) {
  if (!path.startsWith("/api/audio") && !path.startsWith("/api/video") && !path.startsWith("/api/stream") && !path.startsWith("/api/vstream")) {
    const hit = apiCache.get(path);
    if (hit && (Date.now() - hit.t < ttl)) return hit.v;
  }
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.status);
  const v = await r.json();
  apiCache.set(path, { t: Date.now(), v });
  if (apiCache.size > 256) {
    const cutoff = Date.now() - 300000; // entries older than 5 min are dead weight
    for (const [k, e] of apiCache) { if (e.t < cutoff) apiCache.delete(k); }
  }
  return v;
}

async function loadTrending(full = false) {
  showLoading();
  try {
    const songs = await api("/api/trending");
    renderSongs(songs, full ? $("#trendingFull") : $("#trendingGrid"));
    if (!full) loadQuickPicks(songs);
  } catch (e) { console.error(e); }
  hideLoading();
}

async function loadQuickPicks(songs) {
  const picks = songs.slice(0, 6).map(normalizeSong);
  $("#quickPicks").innerHTML = picks.map(s => `
    <div class="quick-pick" data-id="${s.id}">
      <img src="${esc(cardThumb(s))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="https://i.ytimg.com/vi/${esc(s.id)}/mqdefault.jpg">
      <span>${esc(s.title)}</span>
    </div>`).join("");
  bindImgFallback($("#quickPicks"));
  $("#quickPicks").querySelectorAll(".quick-pick").forEach(el => {
    el.addEventListener("click", () => {
      playSongFromList(picks, picks.findIndex(s => s.id === el.dataset.id));
    });
  });
}

async function doSearch(query) {
  if (!query.trim()) return;
  switchView("search");
  $("#searchFilters").style.display = "flex";
  recentSearches = [query.trim(), ...recentSearches.filter(x => x.toLowerCase() !== query.trim().toLowerCase())].slice(0, 12);
  saveRecent();
  renderRecentSearches(true);
  showLoading();
  try {
    const items = await api(`/api/search_all?q=${encodeURIComponent(query)}`);
    $("#searchEmpty").style.display = items.length ? "none" : "block";
    renderSearchResults(items, $("#searchResults"));
  } catch (e) { console.error(e); }
  hideLoading();
}

function renderRecentSearches(hideIfResults = false) {
  const box = $("#recentSearches");
  if (!box) return;
  if (!recentSearches.length || hideIfResults) {
    box.style.display = "none";
    if (hideIfResults || !recentSearches.length) return;
  }
  box.style.display = "flex";
  box.innerHTML = recentSearches.map(q => `<button type="button" class="recent-chip">${esc(q)}</button>`).join("");
  box.querySelectorAll(".recent-chip").forEach(el => {
    el.addEventListener("click", () => {
      $("#searchInput").value = el.textContent;
      doSearch(el.textContent);
    });
  });
}

async function loadArtist(artistId) {
  switchView("artist"); showLoading();
  try {
    const data = await api(`/api/artist/${artistId}`);
    $("#artistHero").innerHTML = `
      <img src="${data.thumbnail || ''}" alt="">
      <div class="info"><div class="name">${data.name}</div><div class="desc">${data.description || ''}</div></div>`;
    $("#artistActions").innerHTML = `<button class="play-all-btn"><i class="fa-solid fa-play"></i> Play all</button>`;
    const playAllBtn = $(".play-all-btn");
    if (playAllBtn && data.songs.length) {
      playAllBtn.addEventListener("click", () => { playSongFromList(data.songs, 0); });
    }
    renderSongs(data.songs, $("#artistSongs"));
    if (data.albums.length) {
      $("#artistAlbumsTitle").style.display = "block";
      renderAlbums(data.albums, $("#artistAlbums"));
    }
    if (data.related.length) {
      $("#artistRelatedTitle").style.display = "block";
      renderArtists(data.related, $("#artistRelated"));
    }
  } catch (e) { console.error(e); }
  hideLoading();
}

async function loadAlbum(browseId) {
  switchView("album"); showLoading();
  try {
    const data = await api(`/api/album/${browseId}`);
    $("#albumHero").innerHTML = `
      <img src="${data.thumbnail || ''}" alt="">
      <div class="info"><div class="name">${data.title}</div><div class="meta">${data.artist} · ${data.year || ''} · ${data.songs.length} songs</div></div>`;
    renderSongs(data.songs, $("#albumSongs"));
  } catch (e) { console.error(e); }
  hideLoading();
}

async function loadExplore() {
  showLoading();
  try {
    const data = await api("/api/explore");
    const root = $("#exploreContent");
    root.innerHTML = "";

    (data.home || []).forEach(section => {
      const items = (section.items || []).filter(item => item && item.id);
      if (!items.length) return;

      const wrapper = document.createElement("section");
      wrapper.className = "section explore-section";
      const header = document.createElement("div");
      header.className = "section-header";
      header.innerHTML = `<div><p class="section-kicker">Curated signal</p><h2>${esc(section.title || "Explore")}</h2></div>`;
      wrapper.appendChild(header);

      const albums = items.filter(item => String(item.id).startsWith("MPRE"));
      const songs = items.filter(item => !String(item.id).startsWith("MPRE"));
      if (songs.length) {
        const grid = document.createElement("div");
        grid.className = "song-grid explore-song-grid";
        wrapper.appendChild(grid);
        renderSongs(songs, grid);
      }
      if (albums.length) {
        const grid = document.createElement("div");
        grid.className = "album-grid explore-album-grid";
        wrapper.appendChild(grid);
        renderAlbums(albums, grid);
      }
      root.appendChild(wrapper);
    });

    if (!root.children.length) root.innerHTML = '<p class="empty-state">Explore will load with trending content</p>';
  } catch (e) { console.error(e); }
  hideLoading();
}

function renderHistory() {
  if (history.length === 0) { $("#historyGrid").innerHTML = ""; $("#historyEmpty").style.display = "block"; }
  else { $("#historyEmpty").style.display = "none"; renderSongs(history, $("#historyGrid")); }
}

function getLikedSongs() {
  const fromMap = Object.values(likedSongsMap);
  const ids = new Set(fromMap.map(s => s.id));
  const fromHist = history.filter(s => liked.has(s.id) && !ids.has(s.id));
  return [...fromMap, ...fromHist];
}

function renderLiked() {
  const likedSongs = getLikedSongs();
  if (likedSongs.length === 0) { $("#likedGrid").innerHTML = ""; $("#likedEmpty").style.display = "block"; }
  else { $("#likedEmpty").style.display = "none"; renderSongs(likedSongs, $("#likedGrid")); }
}

function updateLibraryCounts() {
  $("#likedCount").textContent = liked.size;
  $("#historyCount").textContent = history.length;
  if ($("#playlistCount")) $("#playlistCount").textContent = playlists.length;
}

// ── Playlists ──────────────────────────────────────────────────────────────
function createPlaylist(name) {
  const pl = { id: "pl_" + Date.now().toString(36), name: name || "My Playlist", songs: [], created: Date.now() };
  playlists.unshift(pl);
  savePlaylists();
  updateLibraryCounts();
  return pl;
}

function renderPlaylists() {
  const grid = $("#playlistsGrid");
  if (!playlists.length) {
    grid.innerHTML = "";
    $("#playlistsEmpty").style.display = "block";
    return;
  }
  $("#playlistsEmpty").style.display = "none";
  grid.innerHTML = playlists.map(p => `
    <div class="playlist-card" data-id="${esc(p.id)}">
      <div class="pc-art"><i class="fa-solid fa-music"></i></div>
      <div>
        <div class="pc-title">${esc(p.name)}</div>
        <div class="pc-meta">${p.songs.length} songs</div>
      </div>
    </div>`).join("");
  grid.querySelectorAll(".playlist-card").forEach(card => {
    card.addEventListener("click", () => openPlaylist(card.dataset.id));
  });
}

function openPlaylist(id) {
  const pl = playlists.find(p => p.id === id);
  if (!pl) return;
  activePlaylistId = id;
  switchView("playlist");
  $("#playlistHero").innerHTML = `
    <img src="${esc(pl.songs[0]?.thumbnail || '')}" alt="">
    <div class="info"><div class="name">${esc(pl.name)}</div>
    <div class="meta">${pl.songs.length} songs · local playlist</div></div>`;
  $("#playlistActions").innerHTML = `
    <button class="play-all-btn" id="plPlayAll" type="button"><i class="fa-solid fa-play"></i> Play all</button>
    <button class="text-btn" id="plRename" type="button">Rename</button>
    <button class="text-btn" id="plDelete" type="button">Delete</button>`;
  if (pl.songs.length) {
    $("#playlistEmpty").style.display = "none";
    renderSongs(pl.songs, $("#playlistSongs"));
  } else {
    $("#playlistSongs").innerHTML = "";
    $("#playlistEmpty").style.display = "block";
  }
  $("#plPlayAll")?.addEventListener("click", () => { if (pl.songs.length) playSongFromList(pl.songs, 0); });
  $("#plRename")?.addEventListener("click", () => {
    openModal(`
      <h3>Rename playlist</h3>
      <div class="field"><label>Name</label><input id="plNameInput" value="${esc(pl.name)}"></div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" id="modalCancel">Cancel</button>
        <button type="button" class="btn-primary sm" id="modalOk">Save</button>
      </div>`);
    $("#modalCancel").onclick = closeModal;
    $("#modalOk").onclick = () => {
      pl.name = $("#plNameInput").value.trim() || pl.name;
      savePlaylists(); closeModal(); openPlaylist(pl.id); renderPlaylists();
    };
  });
  $("#plDelete")?.addEventListener("click", () => {
    playlists = playlists.filter(p => p.id !== id);
    savePlaylists(); updateLibraryCounts(); switchView("playlists"); renderPlaylists(); showToast("Playlist deleted");
  });
}

function addSongToPlaylist(song, playlistId) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl || !song) return;
  if (pl.songs.some(s => s.id === song.id)) { showToast("Already in playlist"); return; }
  pl.songs.push(song);
  savePlaylists();
  showToast(`Added to ${pl.name}`);
  if (activePlaylistId === playlistId) openPlaylist(playlistId);
}

// ── Radio ──────────────────────────────────────────────────────────────────
async function startRadio(seed) {
  if (!seed?.id) return;
  showLoading();
  try {
    const songs = await api(`/api/radio/${seed.id}`);
    const list = [seed, ...songs.filter(s => s.id !== seed.id)];
    switchView("radio");
    $("#radioLead").textContent = `Station from “${seed.title}” · ${list.length} tracks`;
    $("#radioEmpty").style.display = list.length ? "none" : "block";
    renderSongs(list, $("#radioGrid"));
    renderRadioSeeds();
    if (settings.autoplayRadio !== false) playSongFromList(list, 0);
    showToast("Radio started");
  } catch (e) {
    console.error(e);
    showToast("Could not start radio");
  }
  hideLoading();
}

function renderRadioSeeds() {
  const seeds = history.slice(0, 8);
  const el = $("#radioSeeds");
  if (!el) return;
  if (!seeds.length) { el.innerHTML = ""; return; }
  el.innerHTML = seeds.map(s => `
    <button type="button" class="radio-seed" data-id="${esc(s.id)}">
      <img src="${esc(cardThumb(s))}" alt="" loading="lazy"><span>${esc(s.title)}</span>
    </button>`).join("");
  el.querySelectorAll(".radio-seed").forEach(btn => {
    btn.addEventListener("click", () => {
      const song = seeds.find(s => s.id === btn.dataset.id);
      if (song) startRadio(song);
    });
  });
}

async function loadRadioView() {
  renderRadioSeeds();
  if (queueIdx >= 0 && queue.length > 1) {
    $("#radioLead").textContent = "Current session queue / station";
    $("#radioEmpty").style.display = "none";
    renderSongs(queue, $("#radioGrid"));
  } else if (!$("#radioGrid").children.length) {
    $("#radioEmpty").style.display = "block";
  }
}
