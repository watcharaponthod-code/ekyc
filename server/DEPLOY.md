# Deploy — Docker → Railway + Postgres

The server ships as a slim container running the **onnx** backend (SCRFD +
ArcFace + MiniFASNet via onnxruntime — no TensorFlow/PyTorch). Image ≈ 1.1 GB,
starts in ~1.5 s. Verified: `docker build` + `docker run` → `/v1/health` returns
`{"status":"ok","backend":"onnx",...}` and the API creates sessions.

## Local

```bash
cd server
docker build -t ekyc-server .
docker run --rm -p 8000:8000 ekyc-server
curl localhost:8000/v1/health
```

SQLite is the zero-config default (data lives in the container — fine for a
smoke test, not for production).

## Live test deployment (2026-08-18)

| | |
|---|---|
| URL | `https://ekyc-api-production-1c11.up.railway.app` |
| project / service | Railway `ekyc-server` / `ekyc-api` (+ `Postgres`) |
| backend | `onnx` (SCRFD + ArcFace + MiniFASNet) — **no `openMouth`/`smile` verification, eye rule advisory**; see `docs/ml-validation.md` §0 |
| auth | `X-API-Key: <key>` on every route but `/v1/health`. The key lives only in Railway → `ekyc-api` → Variables → `EKYC_API_KEYS`; rotate it there. |
| flash | on (`EKYC_FLASH_FRAMES=4`) |
| pulse | off (turn on with `EKYC_PULSE_FRAMES=90`, `EKYC_PULSE_DURATION_MS=8000`) |

Redeploy from `server/`: `railway up --service ekyc-api --detach` (the CLI is
linked to the project; `railway.json` selects the Dockerfile builder).

For the mask defences that need MediaPipe blendshapes (`openMouth`), deploy
the `deepface` backend instead — a multi-GB image (TensorFlow + PyTorch +
MediaPipe); the Dockerfile here is the slim onnx one on purpose.

## Railway

1. **New project → Deploy from repo.** Set the service root to `server/`
   (or Dockerfile path `server/Dockerfile`). `railway.json` selects the
   Dockerfile builder and the `/v1/health` health check.
2. **Add the Postgres plugin.** Railway injects `DATABASE_URL` automatically;
   the server reads it (see `config.normalize_db_url` — rewrites the scheme to
   the psycopg driver) with no code change. Tables are created on startup
   (`init_db`); add Alembic when the schema starts changing.
3. **Environment** (Railway → Variables). All optional — the image already sets
   `EKYC_BACKEND=onnx`:
   - `EKYC_API_KEYS=key1,key2` — **set this.** Every route but `/v1/health`
     then requires `X-API-Key` (or `Authorization: Bearer`). Empty = open.
   - `EKYC_FLASH_FRAMES=4` — turn on active-flash liveness (off by default).
   - `EKYC_PULSE_FRAMES=90`, `EKYC_PULSE_DURATION_MS=8000` — rPPG pulse burst
     (silicone-mask defence; off by default; `EKYC_PULSE_RULE=advisory|enforce`).
   - `EKYC_EXPRESSION_CHALLENGES=false` — **required for the `onnx` backend**
     (no blendshapes → cannot verify `openMouth`/`smile`; the server already
     skips them when the backend says so, this is belt-and-braces).
   - `EKYC_RETAIN_FRAMES=all` + `EKYC_FRAMES_DIR` — evaluation deployments only
     (see `docs/pad-evaluation.md`).
   - `EKYC_LOG_FORMAT=json` — already set in the image.
   - `EKYC_SESSION_TTL_SECONDS`, threshold overrides (`EKYC_PAD_MIN`, …) as needed.
4. `$PORT` is provided by Railway and honoured by the start command.

## Notes

- The three ONNX weights are baked into the image. On a builder with network
  you can instead drop the `COPY models/*.onnx` line and
  `RUN python scripts/fetch_models.py` at build time.
- For 1:N identify beyond ~100k enrolments, move templates to `pgvector`
  (Postgres extension) — the ORM already stores embeddings as bytes; swap the
  brute-force scan in `services/persons.py` for a vector query.
