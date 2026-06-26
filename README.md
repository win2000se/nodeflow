# NODEFLOW (server edition)

Node-based WebGL2 visual synth, now served from a small Express + SQLite backend so it
can run on a home server (e.g. Unraid via Docker) with a **persistent patch library**.

The rendering is still 100% client-side WebGL2 in the browser — the server adds
persistence, sharing, and a path to heavier features (see Roadmap). The frontend is the
same single engine file; when it detects the backend it lights up a **☁ Library** button.
Opened as a bare file with no server, it still works exactly as before (Library hidden).

## Run locally
```bash
npm install
npm start
# open http://localhost:8080
```

## Run with Docker
```bash
docker compose up -d --build
# open http://<host>:8080
```
The SQLite library is stored in `./data` (mounted at `/data` in the container), so it
survives rebuilds and updates.

### Unraid
Same as your Voyage setup: drop this folder on the server, `docker compose up -d --build`
(or build the image and add a container in the Unraid UI mapping port `8080` and a volume
to `/data`). Expose through your existing ngrok tunnel to reach it from your phone.

## API
| Method | Path                | Purpose                                  |
|--------|---------------------|------------------------------------------|
| GET    | `/api/health`       | liveness + patch count                   |
| GET    | `/api/patches`      | list (metadata + thumbnails, no json)    |
| GET    | `/api/patches/:id`  | full patch incl. json                    |
| POST   | `/api/patches`      | create `{name, json, tags?, thumb?}`     |
| PUT    | `/api/patches/:id`  | update name / json / tags / thumb        |
| DELETE | `/api/patches/:id`  | delete                                   |

Patches store the same JSON the app already serializes, plus a small PNG thumbnail
(data URL) generated from the live output.

## Roadmap (what the server unlocks next)
- **Offline high-res export** — render a patch to 4K/60 mp4 server-side via headless
  Chrome (Playwright) + ffmpeg, instead of in-browser MediaRecorder.
- **File inputs** — upload images/video as source textures.
- **Networked control surface** — phone as controller, laptop→projector as output,
  synced over WebSocket (proper VJ rig); OSC bridge for hardware/TouchOSC.
- **Shareable patch URLs** that resolve from the library.
- **Modularization** — split the engine into ES modules with a Vite build (optional;
  the monolith still works and ships as `public/index.html`).
