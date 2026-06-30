# NODEFLOW

A self-contained browser-based WebGL2 node visual synthesizer (TouchDesigner-style).
Built by Dom, running on Unraid via Docker, accessed from iPhone via local network.

## Stack
- `public/index.html` — the entire frontend (single file, ~175KB). WebGL2 engine, all operators, UI, randomiser, VJ decks, patch library. Do NOT split this file.
- `server.js` — Express + better-sqlite3 backend. Patch library API + media file uploads.
- `docker-compose.yml` — port 8811, data volume at ./data
- `deploy.sh` — run `bash deploy.sh` to push to Unraid. Config in `deploy.config`.

## Deploy
```bash
bash deploy.sh
# deploys to 192.168.8.208:8811
```

## Architecture

### Engine (public/index.html)
- Each operator = fullscreen WebGL2 fragment shader rendered to its own FBO
- Wires carry textures between nodes
- Topological sort each frame
- Three stacked canvases: WebGL (bottom), 2D bg, 2D fg (UI)
- Internal resolution selectable, feedback ops use RGBA16F ping-pong buffers

### Operator categories
- `gen` — generators (0 inputs): noise, voronoi, plasma, shape, shape3d, lattice3d, particles, truchet, shapegrid, julia, chladni, interference, metaballs, raymarch, ramp, constant, camera, media, text, text3d, coderain, datawall, hud
- `filt` — filters (1 input): transform, level, hsv, blur, mirror, fractal, polar, pixelate, posterize, glitch, contour, edge, crt, vhs, halftone, warp, palette, bloom, echo, sharpen, tonemap, colorama, thresh
- `comp` — compositors (2 inputs): composite, displace, lens, modulate, rise
- `fb` — feedback (1 input, ping-pong): feedback, flow, reaction, life, timeecho
- `out` — output (1 input): output

### Special operator flags
- `canvas:true` — JS/2D canvas driven. Skips GL shader pipeline. Render loop dispatches `particles`→`runCanvasOp`, everything else (`text`, `text3d`, `coderain`, `datawall`, `hud`)→`run2D` (sets up `n._c2`/`n._cx`, calls `drawTextOp`/`drawText3D`/`drawCodeRain`/`drawDataWall`/`drawHUD`, uploads canvas to texture). `text` = flat (flat/outline/neon styles); `text3d` = faux-3D extruded text rotated via canvas transforms (squash by cos of each axis + depth-offset layers, shaded) with 3D-specific motion (spin Y/tumble X/swing/wobble/fly-through). Text params via `P.text`. `datawall` = stationary grid of glyphs that flip in place (per-cell brightness flashes on switch). These content ops are excluded from the randomiser (GEN_WEIGHT 0).
- `media:true` — uploads image/gif/video as texture each frame. Skips GL shader pipeline. Image elements MUST be appended to DOM for animated GIF/WebP to work.
- `cam:true` — uses live camera stream as uTex0 before running shader.
- `timeecho:true` — custom multi-tap delay-line render path (`runTimeEcho`), holds its own ring of FBOs. Skips GL shader pipeline.

### GLSL helpers available in all shaders
`hash21`, `hash22`, `vnoise`, `fbm`, `rot2(vec2,float)`, `wrapUV`, `rgb2hsv`, `hsv2rgb`, `blendm`, `sdSphere`, `sdBox`, `sdTorus`, `sdCapsule`, `sdOcta`, `sdCyl`, `smin3`

Constants: `TAU`, `PI`, `ASP` (= uRes.x/uRes.y)

### Aspect ratio in shaders
Output is widescreen (e.g. 16:9), but `uv` is [0,1]² — so geometry computed in raw `uv` stretches (circles become ellipses). Aspect-correct any op that draws round/regular geometry: use `aspectP(uv)` (returns centered coords with x×ASP) for centered SDFs, or multiply the x of tiling coords by `ASP` for square cells. 3D ops correct via `sp.x*=uRes.x/uRes.y` in their ray setup. Filters that warp an input image are generally left uncorrected.

### Adding a new operator
1. Add entry to `OPS` object with `cat`, `ins`, `params`, `body`
2. Add display name to `NAME` object
3. Add `GEN_WEIGHT` entry (0 = excluded from random generation)
4. Add `randParams` case if needed
5. Add `MODT` modulation targets if needed
6. Add harmony case in `applyHarmony` if it has color params

### Param types
- `P.f(key, label, min, max, def, step)` — float slider
- `P.sel(key, label, opts[], def)` — select (passes index as float uniform)
- `P.col(key, label, hexdef)` — color picker (vec4 uniform)
- `P.bool(key, label, def)` — toggle (float 0/1)
- `P.file(key, label)` — file URL string, no shader uniform, shows upload button in panel
- `P.text(key, label, def)` — multi-line text string, no shader uniform, shows a textarea in panel (used by the `text` op)

### Randomiser
- `randomize(feel)` — builds N candidates, scores each, keeps best
- `scoreCurrent()` — renders 14 frames, reads pixels, grades via `gradePixels` + `graphBonus`
- `gradePixels` — pixel scorer: rewards contrast/detail/saturation, crushes flat/washed/noise
- `graphBonus` — structural scorer: rewards multi-source, feedback, compositing; penalises trivial graphs
- `qualityToN`: fast=6, good=10, best=18
- Quality floor: 1.6 — keeps retrying until a candidate clears it

### Rise operator
- 2-input compositor: **port 0 (top) = content that gets thrown; port 1 (bottom, optional) = background**
- Directional thrown-arc: content is launched in a chosen direction (forward/back/left/right relative to camera), arcs up, then falls; depth drives perspective size (forward recedes/shrinks, back rushes toward camera/grows)
- Content alpha is respected — transparent areas show the background through
- True projectile trajectory: horizontal TRAVELS linearly across the range (`travel=t-0.5`) while height is a parabola (`4*t*(1-t)`), so it launches, arcs over and descends to a NEW spot — it never retraces, so there's no ceiling-bounce look. Launch/landing sit below `startY` (off-screen), hiding the loop reset. `steep` rounds the apex for a floatier hang (`pow(base, mix(1.0,0.55,steep))`).
- `throw` is the travel distance/range — change via slider or via the randomiser (randParams has a `rise` case).
- Params: dir (throw direction), speed, offset (time offset for staggering instances), throw (travel distance), arc (peak height), steep (apex hang), xpos/startY (launch point), scale (base size), persp (perspective strength)
- Stack multiple Rise nodes to layer several floating images at different timings (use offset param)

### Time Echo operator (timeecho)
- True multi-tap temporal dilator with a **custom render path** (`timeecho:true` flag → `runTimeEcho`, NOT a GLSL feedback loop). Keeps a ring (`n._ring`, capacity `TE_RING=8`) of frozen input snapshots taken every `spacing` frames, then composites N of them as discrete copies — each from a distinct past moment, shrunk (`size^k`), offset (`off*k`) and faded (`fade^k`). Feed it a moving input (e.g. shape→rise) for several real copies frozen at different times AND sizes.
- Implemented via `teProg`/`teBlit` (draws a texture scaled/offset/faded into an FBO). Composited with MAX (lighten, default — best for opaque content like rise output), ADD, or alpha OVER. Ring cleaned up in `removeNode`/`clearGraph`/on resolution change (`teFreeRing`).
- Params: taps (copies 1-7), spacing (frames between copies), size (size step/copy), fade (fade/copy), offx/offy (offset/copy), blend.

### Post-FX chain (locked through randomise)
- `✨ Post FX` toolbar button → a bottom bar to stack **filter** effects applied to the final output every frame, *outside* the node graph.
- Lives in a separate `postFX` array (not `nodes`), so the randomiser — which only rebuilds `nodes` — never touches it. Pin CRT/VHS here and randomise everything upstream.
- `applyPostFX(srcTex)` ping-pongs the output through each entry's shader (`opGL[op].prog` + `setUniformsFor`); injected right after the output resolve in `renderGraph` (skipped when `scoring`). Entries are node-like `{op,params,mods,post:true,_t}` and are editable by selecting their chip (sets `selected`, reuses the param panel). Saved/loaded with the patch (`post:` key); deck recall and load carry it.
- `🆕 Clear patch` (File menu) → `clearPatch()` wipes the graph to a single Output node for building from scratch; leaves the Post-FX chain intact.

### VJ deck bank
- 8 slots, persisted to localStorage
- `🎚 Decks` toolbar button
- Crossfade duration configurable, uses frozen prev frame + live blend

### Patch library (server)
- `☁ Library` button — only visible when server is detected via `/api/health`
- Saves patch JSON + base64 PNG thumbnail to SQLite
- `GET/POST/PUT/DELETE /api/patches`

### Media uploads (server)
- `POST /api/uploads` — base64 JSON body, saves to `DATA_DIR/uploads/`
- `GET /api/uploads` — list files
- Served statically at `/uploads/`
- 25MB body limit

## Key rules
- Never split public/index.html into multiple files
- Always validate JS syntax + GLSL arity + balance after changes
- canvas/media ops skip the GL shader pipeline — don't compile shaders for them
- file params have no shader uniform — setUniformsFor skips them via `loc==null` guard
- Animated GIFs/WebP: img element MUST be appended to document.body (off-screen) for browser to drive animation
- rot2 signature is `rot2(vec2, float)` — always
- fragColor is the output var
- texture() not texture2D()

## Validation commands
Run these after any change to public/index.html:
```bash
# JS syntax
node -e 'const fs=require("fs");new (require("vm").Script)(fs.readFileSync("public/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1],{filename:"f"});console.log("OK")'

# Balance check
node -e 'const fs=require("fs");const js=fs.readFileSync("public/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1];let st=[],pr={")":"(","]":"[","}":"{"};let s=0,sc=null,tpl=false,esc=false,lc=false,bc=false;for(let i=0;i<js.length;i++){const c=js[i],n=js[i+1];if(lc){if(c==="\n")lc=false;continue;}if(bc){if(c==="*"&&n==="/"){bc=false;i++;}continue;}if(s){if(esc){esc=false;continue;}if(c==="\\"){esc=true;continue;}if(c===sc)s=0;continue;}if(tpl){if(esc){esc=false;continue;}if(c==="\\"){esc=true;continue;}if(c==="`")tpl=false;continue;}if(c==="/"&&n==="/"){lc=true;i++;continue;}if(c==="/"&&n==="*"){bc=true;i++;continue;}if(c==="\x27"||c==="\""){s=1;sc=c;continue;}if(c==="`"){tpl=true;continue;}if("([{".includes(c))st.push(c);else if(")]}".includes(c)){if(st.pop()!==pr[c]){console.log("MISMATCH");process.exit(1);}}}console.log(st.length===0?"OK":"FAIL")'
```

## Unraid server
- IP: 192.168.8.208
- Port: 8811
- Path: /mnt/user/appdata/Nodeflow/nodeflow-server
- Data (SQLite + uploads): /mnt/user/appdata/Nodeflow/nodeflow-server/data
