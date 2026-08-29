/* --- LISTEN TOGETHER: lightweight room sync for Vercel-friendly sessions --- */
let listenRoom = null;
let listenPollTimer = null;
let listenSyncTimer = null;
let listenApplyingRemote = false;

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
  return {
    status: isPlaying ? "playing" : "paused",
    position: media && Number.isFinite(media.currentTime) ? media.currentTime : 0,
    track: roomTrack(),
  };
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
    listenRoom = { ...listenRoom, ...room };
    const count = $("#listenRoomMembers");
    if (count) count.textContent = room.members || 1;
    if (!listenRoom.host) await applyRemoteRoomState(room.state || {});
  } catch (e) {
    if (/not found|expired/i.test(e.message)) { stopListenRoom(); showToast("Listen Together room ended"); closeModal(); }
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
  const track = state.track;
  if (track?.id && track.id !== currentVideoId) {
    listenApplyingRemote = true;
    try {
      await playSongFromList([normalizeSong(track)], 0);
      await new Promise(r => setTimeout(r, 600));
    } finally { listenApplyingRemote = false; }
  }
  const media = typeof getPlaybackEl === "function" ? getPlaybackEl() : null;
  if (!media || !track || track.id !== currentVideoId) return;
  const expected = Math.max(0, Number(state.position) || 0) + (state.status === "playing" ? Math.max(0, (Date.now() / 1000) - (Number(state.updatedAt) || Date.now() / 1000)) : 0);
  if (Number.isFinite(expected) && Math.abs((media.currentTime || 0) - expected) > 1.2) media.currentTime = expected;
  if (state.status === "playing" && !isPlaying) { listenApplyingRemote = true; try { await media.play(); } catch {} listenApplyingRemote = false; }
  if (state.status !== "playing" && isPlaying) { listenApplyingRemote = true; try { media.pause(); } catch {} listenApplyingRemote = false; }
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
  if (listenSyncTimer) clearInterval(listenSyncTimer);
  listenSyncTimer = setInterval(() => { if (listenRoom?.host && isPlaying) broadcastRoomState(); }, 2200);
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
