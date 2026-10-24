# Auto Edit Robot 🎬

A self-hosted video editor for short product videos. Drop photos and phone clips into a Google Drive folder; my homelab turns them into a **muted, vertical 1080×1920 video** with editing that follows real film-editing theory, and puts it back in Drive. I only add the music or voice-over.

Built for **[Techlotics](https://techlotics.github.io)** (honest budget-gadget reviews) and runs 24/7 on my homelab: a Dell OptiPlex running **Proxmox**, with an LXC container that runs **Docker**.

```
Google Drive ──► n8n (workflow automation) ──► autoedit (this repo: Node.js + FFmpeg) ──► finished MP4 ──► Google Drive
                                                   │
                                                   └──► Ollama (local vision AI: product name + hands)
```

## What it does
- **6 editing styles**, picked by which Drive folder the clips are dropped into:

| Style | Look |
|---|---|
| `smart` | **Story editor**: looks at the footage first, then plans hook → context → details → payoff to a target length |
| `beat` | Hard cuts on a 0.6 s beat, motivated whip and zoom blurs (learned from desk-setup TikToks) |
| `hype` | Slow intro → flash-cut "drop", shakes, RGB splits, the reveal repeated, flash ending (learned from anime edits) |
| `soft` | Steady 1.1 s shots, crossfades, a small zoom pulse on the beat, warm colours |
| `smooth` | Fades and slow zooms |
| `punchy` | Fast slides and zoom punches |

- Handles real phone footage: sideways clips with a rotate flag, EXIF-rotated JPEGs, landscape media on a blurred background, mixed frame rates, broken files (skipped with a plain-English reason).
- Always keeps the **product sharp and clear**: no washed-out glow or blur looks.

## The Smart Editor
`smart.js` analyses every clip 10 times per second, with no AI needed:
- **Sharpness**: variance of the Laplacian, judged per clip (a keycap close-up has fewer edges than a wide shot but isn't blurry)
- **Camera motion**: a global shift estimate, coarse-to-fine so repeating patterns (rows of keys) can't fool it, with sub-pixel refinement. Known-answer tests: measured 0.277 vs a true 0.278 frame widths/s
- **Action**: what still changes after the camera motion is removed (hands, moving objects)

Then it plans like an editor:
- **Hook** first (the 3-second rule), then **context**, **details** in shooting order that get shorter to build tension, and a held **payoff**
- **Cuts on action** (each cut slides up to ±0.2 s to land during movement), never reuses a moment, skips blurry stretches
- **Motivated transitions only**: a whip only where the camera moves the same way on both sides of the cut, a zoom punch only on the reveal, plain cuts everywhere else
- Fits a **target length** (`?length=5–180` seconds) and reports when there isn't enough sharp footage
- Returns a **shot list with the reason** for every choice

**Shot sizes** come from file-name tags (`wide`, `medium`, `close`, `detail`, `hands`/`typing`). I tested local vision models on frames with known answers (qwen3-vl 2B / 4B / 8B: unreliable at shot size, 9/13 at best), so the AI (`qwen3-vl:4b-instruct` via Ollama) only does what it's good at: naming the product and spotting hands.

## Editing theory behind it
- Walter Murch's **Rule of Six** (emotion > story > rhythm > eye trace > 2D > 3D)
- Cut on action, eye trace, the 30° rule, shot sizes (wide = where, medium = what, close = detail)
- Rhythm: vary shot length, tension → release
- Transitions only when motivated
- Short-form: hook in the first 3 seconds

## API
No published port: only n8n on the same Docker network can reach it, at `http://autoedit:8090`.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | `{ ok, ffmpeg, jobsWaiting }` |
| POST | `/jobs/<job>` | reserves a fresh job (`receiving`) before its files are sent |
| PUT | `/jobs/<job>/files/<name>` | upload one photo or clip (raw body) |
| POST | `/jobs/<job>/render?style=smart&length=30` | starts editing **in the background**, answers `202` at once |
| GET | `/jobs/<job>/status` | `receiving` (+ files so far) / `queued` / `working` (+ current step) / `done` (+ summary and shot list) / `failed` (+ reason) |
| GET | `/jobs/<job>/video` | the finished MP4 |
| DELETE | `/jobs/<job>` | clean up |

### Built for slow hardware, running 24/7
On a CPU-only homelab a SMART edit with the vision AI can take **hours** (about 4 minutes per AI look). So:
- Renders are **background jobs**: n8n starts one, then checks `/status` every few minutes instead of holding one long request open
- n8n **reserves** a job before moving the Drive folder, so a job whose clips are still uploading is never mistaken for a lost one
- Job status is saved to disk; a job cut off by a restart or power cut is marked **failed** with a reason, so the workflow never waits forever. A reserved job that can't start (bad settings, no files) is marked failed with the reason too
- Each AI look gets up to **15 minutes** (`VISION_LOOK_LIMIT_MIN`) through Node's plain `http` client (the built-in `fetch` gives up on its own after 5 minutes without a response); a look that still doesn't answer is skipped and the edit carries on
- One render at a time; uploads, restarts and deletes of a running job are refused (`409`)

File and job names are sanitised so they can't escape the work folder, and the container runs as a non-root user.

## Run it
```bash
docker build -t autoedit .
docker run -d --name autoedit --network ai --restart unless-stopped -v autoedit_work:/work autoedit
```
Optional vision AI: an `ollama` container on the same network with `ollama pull qwen3-vl:4b-instruct` (without it, the editor still works).

## Tests
```bash
node test.js /tmp/autoedit-test
```
85 end-to-end checks against the real API with generated media: output format (H.264, 30 fps, 1080×1920, no audio, no leftover rotate flag), exact lengths per style, file order, broken-file handling, flash and fade timing, motion-analysis known-answer tests, the Smart Editor's story rules, the vision AI against a fake Ollama (including a look that's too slow), background jobs (reserving, instant start, progress, 409s, restart recovery), and path-traversal safety.

## Tech
Node.js (no dependencies) · FFmpeg (filter graphs, xfade, zoompan) · Docker · n8n · Ollama · Proxmox VE · Google Drive API (OAuth, least-privilege scopes)
