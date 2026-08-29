# Aura — deploy guide

Copy of the Aura music app with **gunicorn** wiring for Railway / Render / Fly / any Linux host.  
Vercel is also supported now (zero-config Flask detection + `vercel.json` in this folder).

## What’s in this folder

| File | Purpose |
|------|---------|
| `app.py` | Flask app (`app` object for gunicorn) |
| `Procfile` | `web:` process for Railway/Render/Heroku-style hosts |
| `requirements.txt` | flask, ytmusicapi, yt-dlp, **gunicorn** |
| `templates/`, `static/` | UI |

Local entry still works: `python app.py` reads **`PORT`** (default `5000`) and binds `0.0.0.0`.

## Production start command

```bash
gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1 --threads 4
```

- **`--timeout 120`** — audio resolve / stream can be slow  
- **1 worker** — simpler for yt-dlp subprocesses; scale with a bigger instance if needed  

## 1. Push to GitHub

```powershell
cd "C:\Users\hp\Documents\proj\Aura\Aura vercel"
git init
git add .
git commit -m "Aura deploy package"
# create empty repo on GitHub, then:
git remote add origin https://github.com/YOUR_USER/aura.git
git branch -M main
git push -u origin main
```

Root of the repo must be the folder that contains `app.py`.

## 2. Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**  
2. Select this repo (root = `app.py`)  
3. Start command (if not picked up from `Procfile`):  
   `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1 --threads 4`  
4. **Settings → Networking** → generate a public domain  
5. Open the URL and hard-refresh  

No env vars required for basic use. Optional: `FLASK_DEBUG=0`.

## 3. Render

1. **New → Web Service** → connect GitHub  
2. Runtime: **Python 3**  
3. Build: `pip install -r requirements.txt`  
4. Start: `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1 --threads 4`  
5. Free tier sleeps when idle (cold start is slow)

## 4. Local / VPS

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export PORT=8080            # Windows: $env:PORT=8080
gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1 --threads 4
```

Or quick dev: `python app.py`

## 5. Vercel (supported)

This folder is a valid Vercel project root — `app.py` at the top level with a
Flask `app`, `vercel.json` config, function `maxDuration` 60, and CDN cache headers.

```bash
cd "C:\Users\hp\Documents\proj\Aura\Aura vercel"
npx vercel --prod
```

- Works because each request stays short and cacheable: all read endpoints
  (search / trending / artist / album / playlist / explore / moods) are served
  from an in-memory TTL cache and marked `s-maxage` for the Vercel CDN.
- `/api/stream` proxying is supported by the Python streaming runtime.
- Do **not** set `AURA_BROWSER_COOKIES=1` on Vercel — there is no local browser;
  keep extraction to the plain yt-dlp path.

## Smoke tests after deploy

1. `GET /` — app shell loads  
2. `GET /api/search?q=test` — JSON results  
3. `GET /api/audio/<videoId>` — `{ "url": "/api/stream/..." }` or error  
4. Play a track in the UI — extract or YouTube IFrame fallback  

## Notes

- Cloud hosts may fail audio **extraction**; the app falls back to **YouTube IFrame** play.  
- Do not commit browser cookie files or secrets.  
- Respect YouTube ToS / copyright when exposing a public instance.  
- Credit: Made with 💖 by Akshat Arora  

## Made with 💖 by Akshat Arora


## Listen Together rooms

Aura includes a Listen Together flow. One user creates a six-character room code, shares it, and other users join with that code. The host controls the track, play/pause, previous, and next actions; listeners receive room state automatically.

For local development, room state uses an in-memory fallback. For a Vercel deployment with multiple serverless instances, connect a Vercel KV or Upstash Redis database and add these environment variables in the Vercel project settings:

```text
KV_REST_API_URL
KV_REST_API_TOKEN
```

The app automatically uses the REST-compatible KV adapter when both variables exist. Without them, rooms work for a single-instance preview but are not guaranteed to survive instance changes.
