"""YT Music Player — Flask backend with yt-dlp audio extraction."""

import io, gzip, os, mimetypes, subprocess, shutil, json, time, urllib.request, secrets, string
from flask import Flask, jsonify, request, render_template, Response, stream_with_context
from ytmusicapi import YTMusic

app = Flask(__name__)
ytm = YTMusic()

# short-lived cache of resolved googlevideo URLs
_media_url_cache: dict[str, tuple[str, float]] = {}

# TTL cache of ytmusicapi payloads (search results, charts, metadata).
# The same popular query hits this many times per session; without the cache
# every call is a live round-trip to YouTube's API (hundreds of ms each).
_payload_cache: dict[str, tuple[float, object]] = {}
_PAYLOAD_MAX = 512

# Listen Together room state. This lightweight adapter is Vercel-friendly for
# short sessions; production multi-instance deployments should replace it with
# a shared KV/Redis adapter so rooms survive function-instance changes.
_rooms: dict[str, dict] = {}
_ROOM_TTL = 60 * 60 * 6


def _kv_enabled():
    return bool(os.environ.get("KV_REST_API_URL") and os.environ.get("KV_REST_API_TOKEN"))


def _kv_request(command):
    if not _kv_enabled(): return None
    try:
        url = os.environ["KV_REST_API_URL"].rstrip("/")
        req = urllib.request.Request(
            url,
            data=json.dumps(command).encode(),
            headers={"Authorization": f"Bearer {os.environ['KV_REST_API_TOKEN']}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=4) as response:
            return json.loads(response.read().decode()).get("result")
    except Exception:
        return None


def _room_key(code):
    return f"aura:room:{code}"


def _room_get(code):
    if _kv_enabled():
        value = _kv_request(["GET", _room_key(code)])
        if value:
            try: return json.loads(value) if isinstance(value, str) else value
            except Exception: return None
    return _rooms.get(code)


def _room_set(code, room):
    _rooms[code] = room
    if _kv_enabled(): _kv_request(["SET", _room_key(code), json.dumps(room), "EX", _ROOM_TTL])


def _room_delete(code):
    _rooms.pop(code, None)
    if _kv_enabled(): _kv_request(["DEL", _room_key(code)])


def _clean_rooms():
    cutoff = time.time() - _ROOM_TTL
    for code in list(_rooms):
        if _rooms[code].get("updatedAt", 0) < cutoff:
            _rooms.pop(code, None)


def _new_room_code():
    _clean_rooms()
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if not _room_get(code):
            return code


def _room_payload(room, include_token=False):
    data = {
        "code": room["code"],
        "hostId": room["hostId"],
        "hostName": room.get("hostName", "Host"),
        "members": room.get("members", 1),
        "state": room.get("state", {}),
        "updatedAt": room.get("updatedAt", 0),
    }
    if include_token:
        data["hostToken"] = room["hostToken"]
    return data


def _room_response(payload, status=200):
    resp = jsonify(payload)
    resp.status_code = status
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


def _payload_cached(key: str, ttl: float, fn):
    now = time.time()
    hit = _payload_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    val = fn()
    _payload_cache[key] = (now + ttl, val)
    # keep the dict bounded: drop expired entries once it grows large
    if len(_payload_cache) > _PAYLOAD_MAX:
        cutoff = now - 3600
        for k in list(_payload_cache):
            if _payload_cache[k][0] < cutoff:
                _payload_cache.pop(k, None)
    return val


def _json(payload, *, cdn_ttl=0):
    """jsonify + optional shared-CDN caching (Vercel s-maxage)."""
    resp = jsonify(payload)
    if cdn_ttl:
        resp.headers["Cache-Control"] = (
            f"public, s-maxage={cdn_ttl}, stale-while-revalidate={cdn_ttl * 2}"
        )
        resp.headers["Vary"] = "Accept-Encoding"
    return resp


# ── helpers ──────────────────────────────────────────────────────────────────

def _thumb(t, i=-1):
    """Pick a usable thumbnail URL (prefer larger frames)."""
    if not t:
        return None
    # Prefer last (usually largest); walk backward for first http URL
    for entry in reversed(list(t)):
        url = (entry or {}).get("url")
        if url:
            if url.startswith("//"):
                url = "https:" + url
            return url
    url = (t[i] or {}).get("url") if abs(i) <= len(t) else None
    if url and url.startswith("//"):
        url = "https:" + url
    return url


def _yt_thumb(video_id: str | None) -> str | None:
    if not video_id:
        return None
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def _song(item, kind="song"):
    vid = item.get("videoId")
    thumb = _thumb(item.get("thumbnails")) or _yt_thumb(vid)
    # Some watch-playlist tracks nest thumbnail differently
    if not thumb and item.get("thumbnail"):
        t = item.get("thumbnail")
        if isinstance(t, list):
            thumb = _thumb(t)
        elif isinstance(t, dict):
            thumb = t.get("url") or _thumb(t.get("thumbnails"))
        elif isinstance(t, str):
            thumb = t
    if thumb and thumb.startswith("//"):
        thumb = "https:" + thumb
    vt = item.get("videoType")
    return {
        "type": kind,
        "id": vid,
        "videoType": vt or None,
        # Static-frame audio tracks are flagged up front so the frontend can
        # show lyrics/cover without waiting on /api/video. Unknown -> False;
        # /api/video remains authoritative for those.
        "imageOnly": bool(vt in _IMAGE_ONLY_TYPES),
        "title": item.get("title", "Unknown"),
        "artist": ", ".join(a["name"] for a in item.get("artists", []) if isinstance(a, dict) and a.get("name"))
                  or item.get("author")
                  or "Unknown",
        "album": (item.get("album") or {}).get("name", "") if isinstance(item.get("album"), dict) else (item.get("album") or ""),
        "duration": item.get("duration", "") or item.get("lengthText", ""),
        "thumbnail": thumb or _yt_thumb(vid),
    }


def _album_search(item):
    """Typed album card for search results (browseId, no videoId)."""
    artists = item.get("artists") or []
    return {
        "type": "album",
        "id": item.get("browseId"),
        "title": item.get("title", "Unknown"),
        "artist": ", ".join(a["name"] for a in artists if isinstance(a, dict) and a.get("name")),
        "year": item.get("year", ""),
        "thumbnail": _thumb(item.get("thumbnails")),
    }


def _artist_search(item):
    """Typed artist card for search results (browseId, no videoId)."""
    return {
        "type": "artist",
        "id": item.get("browseId"),
        "name": item.get("artist") or item.get("name") or "Unknown",
        "thumbnail": _thumb(item.get("thumbnails")),
    }


def _yt_dlp_bin():
    if shutil.which("yt-dlp"):
        return ["yt-dlp"]
    # Windows / venv: prefer `python -m yt_dlp`
    import sys
    return [sys.executable, "-m", "yt_dlp"]


_AUDIO_FMT = "bestaudio[ext=m4a]/bestaudio/best"
# 360p keeps the full-player video light (the art box is only ~320px) so it
# loads and syncs fast, especially through the serverless proxy.
_VIDEO_FMT = "best[height<=360][ext=mp4]/best[ext=mp4]/best"


def _get_media_url(video_id: str, fmt: str, want_meta=False) -> str | None:
    """Resolve a direct media URL (audio or video) via yt-dlp (with optional browser cookies).

    When `want_meta` is set the cache also records the resolved format's
    dimensions and a `(url, meta)` tuple is returned. The cache entry itself is
    always a `(url, expiry, meta)` triple so both readers can share one hit.
    """
    key = f"{video_id}:{fmt[:8]}"
    cached = _media_url_cache.get(key)
    if cached and cached[1] > time.time():
        meta = cached[2] if len(cached) > 2 else None
        return (cached[0], meta) if want_meta else cached[0]

    base = _yt_dlp_bin()
    args = [
        "--format", fmt,
        "--no-download", "--print", "url",
        "--quiet", "--no-warnings",
        "--no-playlist",
        "--extractor-args", "youtube:player_client=android,web",
    ]
    if want_meta:
        args += ["--print", "%(width)s %(height)s"]
    # Browser-cookie fallbacks are slow (each is another subprocess) and
    # useless on serverless hosts (Vercel has no Chrome/Firefox profiles).
    # Only attempt them when explicitly enabled via env var.
    cookie_variants = (
        [[], ["--cookies-from-browser", "chrome"], ["--cookies-from-browser", "edge"], ["--cookies-from-browser", "firefox"]]
        if os.environ.get("AURA_BROWSER_COOKIES") == "1" else [[]]
    )
    for domain in ["www.youtube.com", "music.youtube.com"]:
        url = f"https://{domain}/watch?v={video_id}"
        for extra in cookie_variants:
            try:
                r = subprocess.run(
                    base + args + list(extra) + [url],
                    capture_output=True, text=True, timeout=35,
                )
            except Exception:
                continue
            lines = (r.stdout or "").strip().splitlines()
            found_url = None
            meta = None
            for line in lines:
                line = line.strip()
                if not found_url and line.startswith("http"):
                    found_url = line
                elif want_meta and meta is None and " " in line:
                    try:
                        w, h = map(int, line.split()[:2])
                        meta = {"width": w, "height": h}
                    except Exception:
                        pass
            if found_url:
                _media_url_cache[key] = (found_url, time.time() + 3600, meta)
                return (found_url, meta) if want_meta else found_url
    return (None, None) if want_meta else None


def _get_audio_url(video_id: str) -> str | None:
    return _get_media_url(video_id, _AUDIO_FMT)


def _get_video_url(video_id: str) -> str | None:
    return _get_media_url(video_id, _VIDEO_FMT)


_IMAGE_ONLY_TYPES = {
    "MUSIC_VIDEO_TYPE_ATV",                 # artist video track = static album-art frame
    "MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK",
}
_VIDEO_TYPES = {
    "MUSIC_VIDEO_TYPE_OMV",                 # official music video
}


def _music_video_type(video_id: str) -> str | None:
    """Reliable signal for static-frame uploads: the watch page reports the kind.

    `MUSIC_VIDEO_TYPE_ATV` (and a few track variants) are pure audio tracks that
    YouTube encodes as a SQUARE album-art frame. Real music videos are
    `MUSIC_VIDEO_TYPE_OMV`. Falls back to `None` when the watch page is
    unavailable, letting the width/height heuristic decide.
    """
    try:
        data = _payload_cached(f"mvt|{video_id}", 3600, lambda: ytm.get_song(video_id))
        return (data.get("videoDetails") or {}).get("musicVideoType") or None
    except Exception:
        return None


def _get_video_info(video_id: str):
    """Resolve the video stream and say whether it's a real music video.

    Image-only uploads (YouTube Music "Topic"/audio tracks) are encoded as a
    SQUARE album-art frame. Two signals are combined:
      1. `musicVideoType` from the watch page — reliable for ATV (audio) vs OMV.
      2. Width == height from the resolved format — catches user-uploaded audio
         tracks (UGC) that are also square frames.
    """
    url, meta = _get_media_url(video_id, _VIDEO_FMT, want_meta=True)
    image_only = False

    mvt = _music_video_type(video_id)
    if mvt in _IMAGE_ONLY_TYPES:
        image_only = True
    elif mvt in _VIDEO_TYPES:
        image_only = False
    # unknown / UGC / podcast → fall through to the geometric heuristic

    if not image_only and meta:
        w, h = meta.get("width") or 0, meta.get("height") or 0
        if w and h and abs(w - h) <= 4:
            image_only = True
    return url, image_only


# ── pages ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")
# ── API: search ──────────────────────────────────────────────────────────────

@app.route("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    f = request.args.get("filter", "songs")
    key = f"search|{q}|{f}"

    def fetch():
        if f == "albums":
            return [_album_search(r) for r in ytm.search(q, filter="albums", limit=25) if r.get("browseId")][:24]
        if f == "artists":
            return [_artist_search(r) for r in ytm.search(q, filter="artists", limit=25) if r.get("browseId")][:24]
        kind = "video" if f == "videos" else "song"
        return [_song(r, kind) for r in ytm.search(q, filter=f, limit=25) if r.get("videoId")][:24]

    return _json(_payload_cached(key, 600, fetch), cdn_ttl=300)


@app.route("/api/search_all")
def api_search_all():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    key = f"search_all|{q}"

    def fetch():
        seen, songs = set(), []
        for f, kind in [("songs", "song"), ("videos", "video")]:
            try:
                for r in ytm.search(q, filter=f, limit=15):
                    vid = r.get("videoId")
                    if vid and vid not in seen:
                        seen.add(vid)
                        songs.append(_song(r, kind))
            except Exception:
                pass
        albums = []
        try:
            for r in ytm.search(q, filter="albums", limit=10):
                if r.get("browseId"):
                    albums.append(_album_search(r))
        except Exception:
            pass
        artists = []
        try:
            for r in ytm.search(q, filter="artists", limit=10):
                if r.get("browseId"):
                    artists.append(_artist_search(r))
        except Exception:
            pass
        return songs[:24] + albums[:8] + artists[:6]

    return _json(_payload_cached(key, 600, fetch), cdn_ttl=300)


@app.route("/api/search_suggestions")
def api_search_suggestions():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    key = f"suggest|{q}"

    def fetch():
        try:
            return ytm.get_search_suggestions(q)
        except Exception:
            return []

    return _json(_payload_cached(key, 3600, fetch), cdn_ttl=1800)


# ── API: trending / charts ───────────────────────────────────────────────────

@app.route("/api/trending")
def api_trending():
    def fetch():
        try:
            charts = ytm.get_charts()
            songs = charts.get("videos", {}).get("items", [])
            return [_song(s) for s in songs[:40]]
        except Exception:
            seen, out = set(), []
            for f in ["songs", "videos"]:
                for r in ytm.search("trending music 2025", filter=f, limit=25):
                    vid = r.get("videoId")
                    if vid and vid not in seen:
                        seen.add(vid)
                        out.append(_song(r))
            return out[:40]

    return _json(_payload_cached("trending", 1800, fetch), cdn_ttl=900)


# ── API: artist ──────────────────────────────────────────────────────────────

@app.route("/api/artist/<artist_id>")
def api_artist(artist_id: str):
    key = f"artist|{artist_id}"

    def fetch():
        data = ytm.get_artist(artist_id)
        songs = [_song(s) for s in data.get("songs", {}).get("results", [])]
        albums = []
        for a in data.get("albums", {}).get("results", []):
            albums.append({
                "id": a.get("browseId"), "title": a.get("title", ""),
                "thumbnail": _thumb(a.get("thumbnails")), "year": a.get("year", ""),
            })
        related = []
        for a in data.get("related", {}).get("results", []):
            if a.get("browseId"):
                related.append({
                    "id": a.get("browseId"), "name": a.get("name", "Unknown"),
                    "thumbnail": _thumb(a.get("thumbnails")),
                })
        return {
            "id": artist_id,
            "name": data.get("name", "Unknown"),
            "description": data.get("description", ""),
            "thumbnail": _thumb(data.get("thumbnails")),
            "songs": songs, "albums": albums, "related": related,
        }

    return _json(_payload_cached(key, 3600, fetch), cdn_ttl=1800)


# ── API: album ───────────────────────────────────────────────────────────────

@app.route("/api/album/<browse_id>")
def api_album(browse_id: str):
    key = f"album|{browse_id}"

    def fetch():
        data = ytm.get_album(browse_id)
        songs = [_song(t) for t in data.get("tracks", [])]
        return {
            "title": data.get("title", ""),
            "artist": ", ".join(a["name"] for a in data.get("artists", [])),
            "thumbnail": _thumb(data.get("thumbnails")),
            "year": data.get("year", ""),
            "description": data.get("description", ""),
            "songs": songs,
        }

    return _json(_payload_cached(key, 3600, fetch), cdn_ttl=1800)


# ── API: playlist ────────────────────────────────────────────────────────────

@app.route("/api/playlist/<playlist_id>")
def api_playlist(playlist_id: str):
    key = f"playlist|{playlist_id}"

    def fetch():
        data = ytm.get_playlist(playlist_id, limit=50)
        songs = [_song(t) for t in data.get("tracks", [])]
        return {
            "title": data.get("title", ""),
            "description": data.get("description", ""),
            "thumbnail": _thumb(data.get("thumbnails")),
            "songs": songs,
        }

    return _json(_payload_cached(key, 1800, fetch), cdn_ttl=900)


# ── API: suggestions / radio ────────────────────────────────────────────────

@app.route("/api/suggestions/<video_id>")
def api_suggestions(video_id: str):
    key = f"sugg|{video_id}"

    def fetch():
        try:
            data = ytm.get_watch_playlist(video_id, limit=20)
            return [_song(t) for t in data.get("tracks", []) if t.get("videoId")]
        except Exception:
            return []

    return _json(_payload_cached(key, 1800, fetch), cdn_ttl=900)


@app.route("/api/radio/<video_id>")
def api_radio(video_id: str):
    """Get a radio/mix based on a song."""
    key = f"radio|{video_id}"

    def fetch():
        try:
            data = ytm.get_watch_playlist(video_id, limit=25)
            return [_song(t) for t in data.get("tracks", []) if t.get("videoId")]
        except Exception:
            return []

    return _json(_payload_cached(key, 1800, fetch), cdn_ttl=900)


# ── API: Listen Together rooms ───────────────────────────────────────────────
@app.post("/api/rooms")
def create_room():
    body = request.get_json(silent=True) or {}
    host_name = str(body.get("name") or "Host").strip()[:32] or "Host"
    code = _new_room_code()
    host_id = secrets.token_urlsafe(9)
    host_token = secrets.token_urlsafe(24)
    room = {
        "code": code,
        "hostId": host_id,
        "hostToken": host_token,
        "hostName": host_name,
        "members": 1,
        "state": {"status": "paused", "position": 0, "updatedAt": time.time(), "track": None},
        "updatedAt": time.time(),
    }
    _room_set(code, room)
    return _room_response(_room_payload(room, include_token=True), 201)


@app.post("/api/rooms/<code>/join")
def join_room(code):
    _clean_rooms()
    code = str(code or "").upper().strip()
    room = _room_get(code)
    if not room:
        return _room_response({"error": "Room not found or expired"}, 404)
    room["members"] = min(int(room.get("members", 1)) + 1, 99)
    room["updatedAt"] = time.time()
    _room_set(code, room)
    member_id = secrets.token_urlsafe(9)
    return _room_response({**_room_payload(room), "memberId": member_id})


@app.get("/api/rooms/<code>")
def get_room(code):
    _clean_rooms()
    room = _room_get(str(code or "").upper().strip())
    if not room:
        return _room_response({"error": "Room not found or expired"}, 404)
    return _room_response(_room_payload(room))


@app.post("/api/rooms/<code>/state")
def update_room_state(code):
    code = str(code or "").upper().strip()
    room = _room_get(code)
    if not room:
        return _room_response({"error": "Room not found or expired"}, 404)
    body = request.get_json(silent=True) or {}
    if body.get("hostToken") != room["hostToken"]:
        return _room_response({"error": "Only the host can control playback"}, 403)
    state = body.get("state") or {}
    room["state"] = {
        "status": "playing" if state.get("status") == "playing" else "paused",
        "position": max(0, float(state.get("position") or 0)),
        "updatedAt": time.time(),
        "track": state.get("track") if isinstance(state.get("track"), dict) else None,
    }
    room["updatedAt"] = time.time()
    _room_set(code, room)
    return _room_response(_room_payload(room))
@app.delete("/api/rooms/<code>")
def delete_room(code):
    code = str(code or "").upper().strip()
    room = _room_get(code)
    if not room:
        return _room_response({"error": "Room not found or expired"}, 404)
    body = request.get_json(silent=True) or {}
    if body.get("hostToken") != room["hostToken"]:
        return _room_response({"error": "Only the host can end this room"}, 403)
    _room_delete(code)
    return _room_response({"ok": True})


# ── API: audio stream (yt-dlp, ad-free) ─────────────────────────────────────

@app.route("/api/audio/<video_id>")
def api_audio(video_id: str):
    """Return a same-origin proxy URL so the browser can play + use Web Audio EQ."""
    url = _get_audio_url(video_id)
    if url:
        # Prefer proxied stream (CORS-safe). Direct URL kept as fallback hint.
        return jsonify({
            "url": f"/api/stream/{video_id}",
            "direct": url,
        })
    return jsonify({"error": "Could not extract audio"}), 404


@app.route("/api/video/<video_id>")
def api_video(video_id: str):
    """Return a same-origin proxy URL for a combined video+audio stream (full player).

    `imageOnly: true` marks songs whose "video" is just a static album-art
    frame (square encoding) — the frontend then shows the cover art + synced
    lyrics instead of burning CPU/bandwidth on a fake video stream.
    """
    url, image_only = _get_video_info(video_id)
    if url:
        return jsonify({
            "url": f"/api/vstream/{video_id}",
            "direct": url,
            "imageOnly": bool(image_only),
        })
    return jsonify({"error": "Could not extract video"}), 404


def _proxy(video_id: str, fmt: str, ctype: str):
    """Stream resolved media through a same-origin proxy (no googlevideo CORS)."""
    if not video_id or len(video_id) > 20:
        return jsonify({"error": "Invalid id"}), 400

    key = f"{video_id}:{fmt[:8]}"
    src = _get_media_url(video_id, fmt)
    if not src:
        return jsonify({"error": "Could not extract media"}), 404

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
    }
    rng = request.headers.get("Range")
    if rng:
        headers["Range"] = rng

    try:
        req = urllib.request.Request(src, headers=headers)
        upstream = urllib.request.urlopen(req, timeout=45)
    except Exception as exc:
        # drop bad cache entry and retry once
        _media_url_cache.pop(key, None)
        src = _get_media_url(video_id, fmt)
        if not src:
            return jsonify({"error": f"Upstream failed: {exc}"}), 502
        try:
            req = urllib.request.Request(src, headers=headers)
            upstream = urllib.request.urlopen(req, timeout=45)
        except Exception as exc2:
            return jsonify({"error": f"Upstream failed: {exc2}"}), 502

    status = getattr(upstream, "status", 200) or 200
    uhdrs = upstream.headers
    out_headers = {
        "Content-Type": uhdrs.get("Content-Type", ctype),
        "Accept-Ranges": uhdrs.get("Accept-Ranges", "bytes"),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control": "no-store",
    }
    if uhdrs.get("Content-Length"):
        out_headers["Content-Length"] = uhdrs.get("Content-Length")
    if uhdrs.get("Content-Range"):
        out_headers["Content-Range"] = uhdrs.get("Content-Range")

    def generate():
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                upstream.close()
            except Exception:
                pass

    return Response(stream_with_context(generate()), status=status, headers=out_headers)


@app.route("/api/stream/<video_id>")
def api_stream(video_id: str):
    """Proxy extracted audio so <audio> + Web Audio API work (no googlevideo CORS)."""
    return _proxy(video_id, _AUDIO_FMT, "audio/mp4")


@app.route("/api/vstream/<video_id>")
def api_vstream(video_id: str):
    """Proxy combined video so the full player can show the music video."""
    return _proxy(video_id, _VIDEO_FMT, "video/mp4")


# ── API: resolve video ──────────────────────────────────────────────────────

@app.route("/api/resolve/<video_id>")
def api_resolve(video_id: str):
    key = f"resolve|{video_id}"

    def fetch():
        try:
            song_data = ytm.get_song(video_id)
            title = song_data.get("videoDetails", {}).get("title", "")
            author = song_data.get("videoDetails", {}).get("author", "")
            query = f"{title} {author}"
            for f in ["videos", None]:
                results = ytm.search(query, filter=f, limit=5) if f else ytm.search(query, limit=5)
                for r in results:
                    vid = r.get("videoId")
                    if vid:
                        return {"videoId": vid, "title": r.get("title", ""), "resolved": True}
        except Exception:
            pass
        return {"videoId": video_id, "resolved": False}

    return _json(_payload_cached(key, 3600, fetch), cdn_ttl=1800)


# ── API: explore / moods ─────────────────────────────────────────────────────

@app.route("/api/explore")
def api_explore():
    """Get explore/home page content."""

    def fetch():
        result = {"genres": [], "moods": []}
        try:
            # get home page content
            home = ytm.get_home(limit=6)
            sections = []
            for section in home:
                title = section.get("title", "")
                items = []
                for item in section.get("contents", []):
                    if item.get("videoId"):
                        items.append(_song(item))
                    elif item.get("browseId"):
                        items.append({
                            "id": item.get("browseId"),
                            "title": item.get("title", ""),
                            "thumbnail": _thumb(item.get("thumbnails")),
                            "type": item.get("type", ""),
                        })
                if items:
                    sections.append({"title": title, "items": items[:8]})
            result["home"] = sections
        except Exception:
            result["home"] = []
        return result

    return _json(_payload_cached("explore", 1800, fetch), cdn_ttl=900)


@app.route("/api/mood")
def api_mood():
    """Search songs for a mood/vibe query."""
    q = request.args.get("q", "").strip() or "chill music"
    key = f"mood|{q}"

    def fetch():
        try:
            results = ytm.search(q, filter="songs", limit=24)
            return [_song(r) for r in results if r.get("videoId")]
        except Exception:
            return []

    return _json(_payload_cached(key, 1800, fetch), cdn_ttl=900)


@app.route("/api/lyrics")
def api_lyrics():
    """Proxy plain/synced lyrics from LRCLIB (no API key)."""
    import urllib.parse
    import urllib.request

    title = request.args.get("title", "").strip()
    artist = request.args.get("artist", "").strip()
    if not title:
        return jsonify({"lyrics": "", "synced": []})
    key = f"lyrics|{title}|{artist}"

    def fetch():
        try:
            qs = urllib.parse.urlencode({
                "track_name": title,
                "artist_name": artist.split(",")[0].strip() if artist else "",
            })
            req = urllib.request.Request(
                f"https://lrclib.net/api/search?{qs}",
                headers={"User-Agent": "AuraMusic/1.0"},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8") or "[]")
            if not data:
                return {"lyrics": "", "synced": []}
            hit = data[0]
            plain = hit.get("plainLyrics") or ""
            synced_raw = hit.get("syncedLyrics") or ""
            synced = []
            for line in synced_raw.splitlines():
                # [mm:ss.xx] text
                if line.startswith("[") and "]" in line:
                    ts, text = line[1:].split("]", 1)
                    parts = ts.split(":")
                    try:
                        sec = float(parts[0]) * 60 + float(parts[1])
                        synced.append({"t": sec, "text": text.strip()})
                    except Exception:
                        pass
            return {
                "lyrics": plain,
                "synced": synced,
                "source": "lrclib",
                "instrumental": bool(hit.get("instrumental")),
            }
        except Exception as e:
            return {"lyrics": "", "synced": [], "error": str(e)}

    return _json(_payload_cached(key, 3600, fetch), cdn_ttl=1800)


# ── response compression + caching hints ────────────────────────────────────

def _compressible(t):
    return t and (t.startswith("text/") or t in ("application/json", "application/javascript", "image/svg+xml"))


@app.after_request
def _after_request(resp):
    # static assets: long browser cache (files are changed by redeploy name/content)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "public, max-age=86400, s-maxage=86400"
    if resp.status_code == 200 and not resp.headers.get("Content-Encoding"):
        ct = resp.headers.get("Content-Type", "")
        # Only compressible text responses can be safe to buffer — the audio/
        # video proxy streams have audio/* video/* types and are skipped here.
        if _compressible(ct) and "gzip" in request.headers.get("Accept-Encoding", ""):
            data = None
            if resp.direct_passthrough:
                # static files are served as file wrappers; read them explicitly
                p = request.path.removeprefix("/static/").replace("/", os.sep)
                fn = os.path.join(app.static_folder, p)
                if os.path.isfile(fn):
                    with open(fn, "rb") as f:
                        data = f.read()
            else:
                data = resp.get_data()
            if data and len(data) > 512:
                gz = gzip.compress(data, 6)
                if len(gz) < len(data):
                    resp.set_data(gz)
                    resp.headers["Content-Encoding"] = "gzip"
                    resp.headers["Content-Length"] = str(len(gz))
    return resp


if __name__ == "__main__":
    # Serverless hosts (Vercel) ignore this block entirely — they import `app`.
    # Local & Railway/Render: threaded=True so the streaming audio/video
    # proxies don't block other requests.
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
