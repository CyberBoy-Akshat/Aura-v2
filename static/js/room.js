/* --- LISTEN TOGETHER: lightweight room sync for Vercel-friendly sessions --- */
let listenRoom = null;
let listenPollTimer = null;
let listenSyncTimer = null;
let listenApplyingRemote = false;
let listenLastRevision = 0;
let listenPendingState = null;
let listenMissingPolls = 0;

function isListenTogetherGuest() { return Boolean(listenRoom?.joined && !listenRoom?.host); }
window.isListenTogetherGuest = isListenTogetherGuest;

function roomApi(path, options = {}) {
  return fetch(`/api/rooms${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Room error ${r.status}`);
    return data;
  });
}

function roomTrack() {
  const song = queue[queueIdx];
  if (!song?.id) return null;
  return { id: song.id, title: song.title || "Unknown", artist: song.artist || "Unknown", thumbnail: song.thumbnail || "", duration: song.duration || "" };
}

function roomPlaybackState() {
  const media = typeof getPlaybackEl === "function" ? getPlaybackEl() : null;
  const position = typeof getPlaybackTime === "function"
    ? getPlaybackTime()
    : (media && Number.isFinite(media.currentTime) ? media.currentTime : 0);
  return {
    status: isPlaying ? "playing" : "paused",
    position,
    track: roomTrack(),
    // The backend stamps the authoritative revision/time. Keeping the payload
    // small makes polling cheap while allowing guests to reject stale packets.
  };
}

function roomExpectedPosition(state) {
  const base = Math.max(0, Number(state?.position) || 0);
  const stamp = Number(state?.updatedAt) || 0;
  return Math.max(0, base + (state?.status === "playing" && stamp ? Math.max(0, Date.now() / 1000 - stamp) : 0));
}

async function waitForRoomMedia(trackId, timeout = 9000) {
  const started = performance.now();
  while (currentVideoId === trackId && performance.now() - started < timeout) {
    // The fallback is a YouTube IFrame, not an HTMLMediaElement. Once the API
    // is ready it is the authoritative guest playback target.
    if (!useAudioEl && ytReady && ytPlayer?.seekTo) return ytPlayer;
    const media = typeof getPlaybackEl === "function" ? getPlaybackEl() : null;
    if (media && media.readyState >= 1) return media;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return !useAudioEl && ytReady && ytPlayer?.seekTo
    ? ytPlayer
    : (typeof getPlaybackEl === "function" ? getPlaybackEl() : null);
}

async function applyRoomMediaState(state, trackId) {
  const media = await waitForRoomMedia(trackId);
  if (!media || currentVideoId !== trackId) return;
  const expected = roomExpectedPosition(state);
  listenPendingState = { state, trackId, expected };
  try {
    if (!useAudioEl && media === ytPlayer) {
      const now = Number(media.getCurrentTime?.() || 0);
      if (Number.isFinite(expected) && Math.abs(now - expected) > 0.25) media.seekTo(expected, true);
      if (state.status === "playing") media.playVideo?.();
      else media.pauseVideo?.();
      return;
    }
    if (Number.isFinite(expected) && Math.abs((media.currentTime || 0) - expected) > 0.25) media.currentTime = expected;
    if (state.status === "playing") {
      await media.play();
    } else {
      media.pause();
    }
  } catch (e) {
    // Autoplay policies can reject a guest's first play. The media event and
    // next poll will retry without resetting the target timeline.
    if (state.status === "playing") setTimeout(() => applyRoomMediaState(state, trackId), 350);
  } finally {
    listenPendingState = null;
  }
}

function roomSetStatus(text, kind = "") {
  const el = $("#listenRoomStatus");
  if (el) { el.textContent = text; el.className = `listen-room-status ${kind}`; }
}

function renderListenRoom(room = listenRoom) {
  const root = $("#listenRoomRoot");
  if (!root || !room) return;
  const role = room.host ? "Host" : "Listener";
  root.innerHTML = `
    <div class="listen-room-live">
      <div class="listen-room-code-label">Room code</div>
      <div class="listen-room-code">${esc(room.code)}</div>
      <div class="listen-room-meta"><span><i class="fa-solid fa-${room.host ? "crown" : "headphones"}"></i> ${role}</span><span><i class="fa-solid fa-users"></i> <b id="listenRoomMembers">${room.members || 1}</b> listening</span></div>
      <div class="listen-room-share-row">
        <button type="button" class="btn-primary sm" id="listenRoomCopy"><i class="fa-solid fa-copy"></i> Copy code</button>
        <button type="button" class="btn-ghost sm" id="listenRoomShare"><i class="fa-solid fa-share-nodes"></i> Share</button>
      </div>
      <p id="listenRoomStatus" class="listen-room-status">${room.host ? "You control the room." : "The host controls playback."}</p>
      <div class="modal-actions">
        ${room.host ? '<button type="button" class="btn-ghost" id="listenRoomEnd">End room</button>' : '<button type="button" class="btn-ghost" id="listenRoomLeave">Leave room</button>'}
        <button type="button" class="btn-primary sm" id="listenRoomClose">Done</button>
      </div>
    </div>`;
  $("#listenRoomCopy")?.addEventListener("click", copyListenRoomCode);
  $("#listenRoomShare")?.addEventListener("click", shareListenRoom);
  $("#listenRoomClose")?.addEventListener("click", closeModal);
  $("#listenRoomEnd")?.addEventListener("click", endListenRoom);
  $("#listenRoomLeave")?.addEventListener("click", leaveListenRoom);
}

function openListenTogether() {
  if (listenRoom) {
    openModal(`<h3>Listen Together</h3><p class="modal-sub">Share this code and press play together.</p><div id="listenRoomRoot"></div>`);
    renderListenRoom();
    return;
  }
  openModal(`
    <h3>Listen Together</h3>
    <p class="modal-sub">Create a room, share the code, and let the host control the vibe.</p>
    <div class="listen-room-actions">
      <div class="listen-room-card">
        <div class="listen-room-card-icon"><i class="fa-solid fa-crown"></i></div>
        <div><strong>Create a room</strong><span>You become the host.</span></div>
        <button type="button" class="btn-primary sm" id="listenCreate">Create</button>
      </div>
      <div class="listen-room-card join">
        <div class="listen-room-card-icon"><i class="fa-solid fa-ticket"></i></div>
        <div><strong>Join a room</strong><span>Enter a friend’s code.</span></div>
        <input id="listenJoinCode" maxlength="6" placeholder="ABC123" autocomplete="off" inputmode="text">
        <button type="button" class="btn-ghost sm" id="listenJoin">Join</button>
      </div>
    </div>
    <div class="modal-actions"><button type="button" class="btn-ghost" id="modalCancel">Close</button></div>`);
  $("#modalCancel").onclick = closeModal;
  $("#listenCreate").onclick = createListenRoom;
  $("#listenJoin").onclick = joinListenRoom;
  $("#listenJoinCode").oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
}

async function createListenRoom() {
  try {
    const name = localStorage.getItem("auraRoomName") || "Aura host";
    const room = await roomApi("", { method: "POST", body: JSON.stringify({ name }) });
    listenRoom = { ...room, host: true, joined: true };
    localStorage.setItem("auraListenRoom", JSON.stringify({ code: room.code, hostToken: room.hostToken, host: true }));
    startListenRoom();
    openModal(`<h3>Listen Together</h3><p class="modal-sub">Share this code and press play together.</p><div id="listenRoomRoot"></div>`);
    renderListenRoom();
    showToast(`Room ${room.code} created`);
  } catch (e) { showToast(e.message); }
}

async function joinListenRoom() {
  const code = $("#listenJoinCode")?.value.trim().toUpperCase();
  if (!code || code.length < 6) { showToast("Enter the 6-character room code"); return; }
  try {
    const room = await roomApi(`/${encodeURIComponent(code)}/join`, { method: "POST", body: JSON.stringify({}) });
    listenRoom = { ...room, host: false, joined: true };
    localStorage.setItem("auraListenRoom", JSON.stringify({ code: room.code, host: false }));
    startListenRoom();
    openModal(`<h3>Listen Together</h3><p class="modal-sub">You joined the room.</p><div id="listenRoomRoot"></div>`);
    renderListenRoom();
    showToast(`Joined room ${room.code}`);
  } catch (e) { showToast(e.message); }
}

async function pollListenRoom() {
  if (!listenRoom?.code) return;
  try {
    const room = await roomApi(`/${encodeURIComponent(listenRoom.code)}`);
    listenMissingPolls = 0;
    listenRoom = { ...listenRoom, ...room };
    const count = $("#listenRoomMembers");
    if (count) count.textContent = room.members || 1;
    if (!listenRoom.host) await applyRemoteRoomState(room.state || {});
  } catch (e) {
    if (/not found|expired/i.test(e.message)) {
      // Vercel/serverless instances can briefly disagree while a room write is
      // propagating. Require consecutive misses before ending the session.
      listenMissingPolls += 1;
      roomSetStatus(`Reconnecting to room… (${listenMissingPolls}/3)`, "warning");
      if (listenMissingPolls >= 3) { stopListenRoom(); showToast("Listen Together room ended"); closeModal(); }
    }
  }
}

function startListenRoom() {
  if (listenPollTimer) clearInterval(listenPollTimer);
  listenPollTimer = setInterval(pollListenRoom, 1800);
  pollListenRoom();
}
function stopListenRoom() {
  if (listenPollTimer) clearInterval(listenPollTimer);
  if (listenSyncTimer) clearInterval(listenSyncTimer);
  listenPollTimer = null; listenSyncTimer = null; listenRoom = null;
  listenLastRevision = 0;
  listenPendingState = null;
  listenMissingPolls = 0;
  localStorage.removeItem("auraListenRoom");
}

async function broadcastRoomState() {
  if (!listenRoom?.host || listenApplyingRemote) return;
  try {
    const data = await roomApi(`/${encodeURIComponent(listenRoom.code)}/state`, {
      method: "POST",
      body: JSON.stringify({ hostToken: listenRoom.hostToken, state: roomPlaybackState() }),
    });
    listenRoom.members = data.members || listenRoom.members;
  } catch {}
}

async function applyRemoteRoomState(state) {
  if (!state) return;
  const revision = Number(state.revision) || 0;
  if (revision && revision < listenLastRevision) return;
  if (revision) listenLastRevision = revision;
  const track = state.track;
  if (track?.id && track.id !== currentVideoId) {
    listenApplyingRemote = true;
    try {
      await playSongFromList([normalizeSong(track)], 0, { remote: true });
    } finally { listenApplyingRemote = false; }
  }
  if (!track?.id || track.id !== currentVideoId) return;
  // Do not seek an unloaded element. Waiting for readyState prevents the
  // classic guest bug where play() fires against an empty element and the song
  // later begins at 0:00 instead of the host's live position.
  listenApplyingRemote = true;
  try { await applyRoomMediaState(state, track.id); }
  finally { listenApplyingRemote = false; }
}

async function copyListenRoomCode() {
  if (!listenRoom?.code) return;
  try { await navigator.clipboard.writeText(listenRoom.code); showToast("Room code copied"); } catch { showToast(`Room code: ${listenRoom.code}`); }
}
async function shareListenRoom() {
  if (!listenRoom?.code) return;
  const data = { title: "Join my Aura room", text: `Join my Aura Listen Together room: ${listenRoom.code}` };
  try { if (navigator.share) await navigator.share(data); else await copyListenRoomCode(); } catch {}
}
async function endListenRoom() {
  try { await roomApi(`/${encodeURIComponent(listenRoom.code)}`, { method: "DELETE", body: JSON.stringify({ hostToken: listenRoom.hostToken }) }); } catch {}
  stopListenRoom(); closeModal(); showToast("Room ended");
}
function leaveListenRoom() { stopListenRoom(); closeModal(); showToast("Left room"); }

function wireListenTogetherPlayback() {
  ["#btnPlay", "#npfPlay", "#btnNext", "#npfNext", "#btnPrev", "#npfPrev"].forEach(sel => $(sel)?.addEventListener("click", () => setTimeout(broadcastRoomState, 120)));
  // The click is not the source of truth: on phones, stream resolution can
  // take longer than the click handler. Broadcast again from real media state.
  ["audioPlayer", "mediaVideo"].forEach(id => {
    const media = document.getElementById(id);
    ["play", "pause", "ended", "seeking", "seeked"].forEach(evt => media?.addEventListener(evt, () => {
      if (listenRoom?.host && !listenApplyingRemote) setTimeout(broadcastRoomState, evt === "seeking" ? 80 : 180);
    }));
  });
  if (listenSyncTimer) clearInterval(listenSyncTimer);
  listenSyncTimer = setInterval(() => { if (listenRoom?.host && (isPlaying || queueIdx >= 0)) broadcastRoomState(); }, 1800);
}

$("#btnListenTogether")?.addEventListener("click", openListenTogether);
$("#btnListenTogetherTop")?.addEventListener("click", openListenTogether);
wireListenTogetherPlayback();

try {
  const saved = JSON.parse(localStorage.getItem("auraListenRoom") || "null");
  if (saved?.code) {
    roomApi(`/${encodeURIComponent(saved.code)}`).then(room => {
      listenRoom = { ...room, host: Boolean(saved.host), hostToken: saved.hostToken, joined: true };
      startListenRoom();
    }).catch(() => localStorage.removeItem("auraListenRoom"));
  }
} catch {}
