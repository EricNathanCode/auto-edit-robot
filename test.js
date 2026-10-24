// End-to-end test of the Auto Edit Robot API with made-up photos and clips.
// Usage: node test.js <scratchDir>   (needs ffmpeg/ffprobe on PATH, or FFMPEG/FFPROBE set). All sample media is generated.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { run, jpegOrientation, FFMPEG } = require("./render");
const { analyzeClip } = require("./smart");
const { tagSize, tagHands, labelShots, MODEL } = require("./vision");

const scratch = path.resolve(process.argv[2]);
const samples = path.join(scratch, "samples"), work = path.join(scratch, "work"), out = path.join(scratch, "out");
const PORT = 18090, API = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "✅" : "❌"} ${what}`); if (!ok) failures++; };
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const ff = (...args) => run(FFMPEG, ["-y", "-v", "error", ...args]);

async function makeSamples() {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const d of [samples, work, out]) fs.mkdirSync(d, { recursive: true });
  const s = (n) => path.join(samples, n);
  // Made-up "photos": dark navy cards with bright boxes and fine grain (like a product shot on a dark desk).
  const card = (size, out) => ff("-f", "lavfi", "-i", `color=c=0x0B1020:s=${size}`, "-frames:v", "1", "-vf",
    "drawbox=x=iw*0.1:y=ih*0.3:w=iw*0.8:h=ih*0.25:color=0x00E5FF@0.5:t=fill,drawbox=x=iw*0.2:y=ih*0.62:w=iw*0.6:h=ih*0.08:color=0x7C4DFF:t=fill,noise=alls=12",
    out);
  await card("1080x1350", s("01 portrait photo.jpg"));
  await ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=60:duration=3", "-f", "lavfi", "-i", "sine=duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", s("02 vertical clip with sound.mp4"));
  await card("1640x924", s("03 landscape photo.png"));
  // A phone video stored sideways + a "rotate 90°" flag, like most phones record.
  const raw = path.join(scratch, "raw.mp4");
  await ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", raw);
  await ff("-display_rotation", "90", "-i", raw, "-c", "copy", s("04 rotated phone clip.mp4"));
  await ff("-f", "lavfi", "-i", "mandelbrot=size=1280x720:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", s("05 landscape clip.mov"));
  await card("1080x1920", s("06 vertical photo.png"));
  fs.writeFileSync(s("07 broken.jpg"), "this is not a picture");
  fs.writeFileSync(s("desktop.ini"), "[.ShellClassInfo]");
  await ff("-f", "lavfi", "-i", "testsrc=size=720x1280:rate=30:duration=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", s("9 short clip.mp4"));
  fs.copyFileSync(s("01 portrait photo.jpg"), s("10 last photo.jpg"));
  // A portrait phone photo saved sideways with an EXIF "rotate 90° clockwise" flag (orientation 6).
  const sideways = path.join(scratch, "sideways.jpg");
  await ff("-i", s("06 vertical photo.png"), "-vf", "transpose=2", sideways);
  const jpg = fs.readFileSync(sideways);
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from("Exif\0\0", "binary"), tiff]);
  fs.writeFileSync(s("11 sideways phone photo.jpg"), Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));

  // Known-answer clips for the Smart Editor's eyes: a detailed random pattern filmed sliding right, moving up, still, blurry.
  const eyes = path.join(scratch, "eyes"), big = path.join(eyes, "big.png");
  fs.mkdirSync(eyes);
  await ff("-f", "lavfi", "-i", "life=size=405x720:ratio=0.5:mold=0:life_color=#e0e0e0:death_color=#203040", "-frames:v", "1",
    "-vf", "scale=1620:2880:flags=neighbor", big);
  const clip = (name, vf) => ff("-loop", "1", "-i", big, "-vf", `${vf},format=yuv420p`, "-t", "3", "-r", "30", path.join(eyes, name));
  await clip("pan-right.mp4", "crop=1080:1920:x='t*300':y=400");
  await clip("pan-up.mp4", "crop=1080:1920:x=200:y='700-t*250'");
  await clip("still.mp4", "crop=1080:1920:x=200:y=400");
  await clip("blurry.mp4", "crop=1080:1920:x=200:y=400,gblur=sigma=8");
}

// Average brightness of frame n (TV range: 16 = black, 235 = white).
async function lumaAt(video, n) {
  const raw = path.join(out, `luma-${n}.raw`);
  await ff("-i", video, "-vf", `select='eq(n,${n})',scale=1:1:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", raw);
  return fs.readFileSync(raw)[0];
}

// Average brightness of every frame, one number each (0 = black, 255 = white).
async function frameLumas(video) {
  const raw = path.join(out, "lumas.raw");
  await ff("-i", video, "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", raw);
  return [...fs.readFileSync(raw)];
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(`${API}/health`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("server did not start");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (base) => (await fetch(`${base}/status`)).json();

// Checks the job's status (like n8n does, but every 0.3 s) until it is done or failed.
async function waitForJob(base, limitMs = 15 * 60 * 1000) {
  for (const end = Date.now() + limitMs; Date.now() < end; await sleep(300)) {
    const st = await statusOf(base);
    if (st.status === "done" || st.status === "failed") return st;
  }
  throw new Error("job did not finish in time");
}

async function upload(base, files) {
  for (const [name, file] of files) {
    const r = await fetch(`${base}/files/${encodeURIComponent(name)}`, { method: "PUT", body: fs.readFileSync(file) });
    if (!r.ok) throw new Error(`upload ${name}: ${r.status}`);
  }
}
const sampleFiles = () => fs.readdirSync(samples).map((n) => [n, path.join(samples, n)]);

// extra: more files for this job only, { "new name": source path }.
async function renderJob(job, style, query = "", extra = {}) {
  const base = `${API}/jobs/${encodeURIComponent(job)}`;
  await upload(base, [...sampleFiles(), ...Object.entries(extra)]);
  const started = await fetch(`${base}/render?style=${style}${query}`, { method: "POST" });
  if (started.status !== 202) throw new Error(`render did not start: ${started.status} ${await started.text()}`);
  const st = await waitForJob(base);
  const summary = st.status === "done" ? st.result : { ok: false, error: st.error };
  const video = path.join(out, `test-${style}.mp4`);
  fs.writeFileSync(video, Buffer.from(await (await fetch(`${base}/video`)).arrayBuffer()));
  await fetch(base, { method: "DELETE" });
  return { summary, video };
}

async function main() {
  await makeSamples();
  // A job that was "working" when the editor stopped (power cut): the restarted editor must mark it failed.
  fs.mkdirSync(path.join(work, "Interrupted job"), { recursive: true });
  fs.writeFileSync(path.join(work, "Interrupted job", "status.json"), JSON.stringify({ job: "Interrupted job", status: "working" }));
  fs.mkdirSync(path.join(work, "Interrupted upload"), { recursive: true });
  fs.writeFileSync(path.join(work, "Interrupted upload", "status.json"), JSON.stringify({ job: "Interrupted upload", status: "receiving" }));
  // No vision AI during tests (port 9 never answers): results stay the same on every PC, and the fallback gets tested.
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, WORK_DIR: work, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "inherit"] });
  server.stdout.on("data", (d) => process.stdout.write(`   server: ${d}`));
  try {
    const health = await waitForServer();
    check(health.ok && /ffmpeg version/.test(health.ffmpeg), `health: ${health.ffmpeg}`);

    const order = ["01 portrait photo.jpg", "02 vertical clip with sound.mp4", "03 landscape photo.png", "04 rotated phone clip.mp4",
      "05 landscape clip.mov", "06 vertical photo.png", "9 short clip.mp4", "10 last photo.jpg", "11 sideways phone photo.jpg"];
    // 5 photos x 2.5 s + clips 3 + 4 + 3 + 0.6 s, minus the overlaps (transitions next to the 0.6 s clip shrink to 0.2 s).
    // BEAT: 13 pieces (photos 1 beat each; clips 2 + 3 + 2 pieces; the 0.6 s clip whole), the first 3 cut to 4-frame stutters.
    // HYPE: 2 intro pieces (36 frames each) + 10 drop pieces on the 18/9/9-frame rhythm (126) + the drop's first 6 again (72)
    // + a 36-frame ending = 306 frames.
    // SOFT: 10 pieces of 39 frames (photos 1 each; clips 1 + 2 + 1; the 0.6 s clip whole, 18 frames) = 369 frames,
    // minus 9 crossfades of 6 frames = 315 frames (a cut every 1.1 s).
    const expected = { smooth: 23.1 - (6 * 0.6 + 2 * 0.2), punchy: 23.1 - (6 * 0.25 + 2 * 0.2), beat: (3 * 4 + 10 * 18) / 30, hype: 306 / 30,
      soft: (9 * 33 + 18) / 30 };
    check(jpegOrientation(path.join(samples, "11 sideways phone photo.jpg")) === 6 && jpegOrientation(path.join(samples, "01 portrait photo.jpg")) === 1,
      "reads the phone's EXIF rotate flag");

    console.log("\n--- SMART EDITOR EYES ---");
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const look = async (name) => {
      const fr = await analyzeClip(FFMPEG, path.join(scratch, "eyes", name), { width: 1080, height: 1920 });
      return { vx: med(fr.map((f) => f.vx)), vy: med(fr.map((f) => f.vy)), sharp: med(fr.map((f) => f.sharp)) };
    };
    const [right, up, still, blurry] = await Promise.all(["pan-right.mp4", "pan-up.mp4", "still.mp4", "blurry.mp4"].map(look));
    check(near(right.vx, 300 / 1080, 0.05) && Math.abs(right.vy) < 0.03, `sees the camera slide right (${right.vx.toFixed(3)}, truth 0.278 frame widths/s)`);
    check(near(up.vy, -250 / 1080, 0.05) && Math.abs(up.vx) < 0.03, `sees the camera move up (${up.vy.toFixed(3)}, truth -0.231)`);
    check(Math.hypot(still.vx, still.vy) < 0.02, `sees a still camera (speed ${Math.hypot(still.vx, still.vy).toFixed(3)})`);
    check(blurry.sharp < 0.3 * still.sharp, `sees blur (sharpness ${blurry.sharp.toFixed(0)} vs ${still.sharp.toFixed(0)} sharp)`);

    console.log("\n--- VISION AI (a fake Ollama) ---");
    let delay = 50;
    const answer = JSON.stringify({ message: { content: JSON.stringify({ product: "Aula F75 keyboard", hands: true }) } });
    const fake = http.createServer((req, res) => {
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: MODEL }] }));
      req.resume();
      req.on("end", () => setTimeout(() => res.end(answer), delay));
    });
    await new Promise((r) => fake.listen(18091, "127.0.0.1", r));
    process.env.OLLAMA_URL = "http://127.0.0.1:18091";
    process.env.VISION_LOOK_LIMIT_MIN = String(1 / 60); // a 1 s limit, so the test doesn't wait 15 minutes
    const photo = () => [{ name: "01 portrait photo.jpg", kind: "photo", file: path.join(samples, "01 portrait photo.jpg"), info: { duration: 0 } }];
    let items = photo();
    const note = await labelShots(FFMPEG, items);
    check(!note && items[0].labels[0]?.product === "Aula F75 keyboard" && items[0].labels[0].hands === true,
      "asks the vision AI for the product name and hands");
    delay = 3000;
    items = photo();
    const logs = [], t1 = Date.now();
    await labelShots(FFMPEG, items, (m) => logs.push(m));
    const waited = Date.now() - t1;
    check(waited < 2500 && logs.some((l) => /failed: no answer within 1 s/.test(l)) && items[0].labels.length === 0,
      `a look slower than the limit is skipped, never stuck (gave up after ${waited} ms)`);
    fake.close();
    delete process.env.OLLAMA_URL;
    delete process.env.VISION_LOOK_LIMIT_MIN;

    for (const style of ["smooth", "punchy", "beat", "hype", "soft"]) {
      console.log(`\n--- ${style.toUpperCase()} ---`);
      const { summary, video } = await renderJob(`Test ${style} (Aula F75)`, style);
      console.log(`   ${JSON.stringify({ ...summary, used: undefined })}`);
      check(summary.ok === true, "render ok");
      check(JSON.stringify(summary.used) === JSON.stringify(order), "file order: name order, 9 before 10, junk ignored");
      check(summary.skipped.length === 1 && summary.skipped[0].file === "07 broken.jpg" && /^can't read/.test(summary.skipped[0].reason),
        "broken file skipped with a plain-English reason");
      check(summary.photos === 5 && summary.videos === 4, "5 photos + 4 videos used");
      const info = JSON.parse(await run(process.env.FFPROBE || "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", video]));
      const v = info.streams.find((s) => s.codec_type === "video");
      check(v && v.width === 1080 && v.height === 1920, "vertical 1080x1920");
      check(v && v.r_frame_rate === "30/1" && v.pix_fmt === "yuv420p" && v.codec_name === "h264", "H.264, 30 fps, yuv420p");
      check(!info.streams.some((s) => s.codec_type === "audio"), "muted (no audio track)");
      check(!(v.side_data_list || []).some((d) => d.rotation !== undefined), "no leftover rotate flag (apps show it upright)");
      check(near(Number(info.format.duration), expected[style]), `length ${Number(info.format.duration).toFixed(2)} s ≈ ${expected[style].toFixed(2)} s`);
      if (style === "hype") {
        // Brightness (16 = black, 235 = white) at key frames: intro fades in, reveal flash at frame 72, the repeat
        // starts with the same flash at frame 198, the ending flashes white (frame 289) then fades to black.
        const [first, reveal, repeat, endFlash, last] = await Promise.all([0, 72, 198, 289, 305].map((n) => lumaAt(video, n)));
        check(first < 30, `intro fades in from black (frame 0 brightness ${first})`);
        check(reveal > 200 && repeat > 200, `flash cut on the reveal and again on the repeat (${reveal}, ${repeat})`);
        check(endFlash > 200 && last < 30, `ending flashes white then fades to black (${endFlash} → ${last})`);
      }
      if (style === "soft") {
        // No white anywhere. The 1st crossfade (dark logo photo → bright colour bars) runs over frames 33-38.
        const lumas = await frameLumas(video);
        check(lumas[0] < 30 && lumas.at(-1) < 30, `fades in from black and out to black (${lumas[0]}, ${lumas.at(-1)})`);
        check(Math.max(...lumas) < 200, `no white frames (brightest frame ${Math.max(...lumas)} of 255)`);
        check(lumas[30] < lumas[36] && lumas[36] < lumas[42], `crossfade: the cut blends from one shot to the next (${lumas[30]} → ${lumas[36]} → ${lumas[42]})`);
      }
      const sheet = { beat: "fps=10,scale=135:240,tile=16x4", hype: "fps=10,scale=135:240,tile=17x6", soft: "fps=10,scale=135:240,tile=18x6" }[style]
        || "fps=2,scale=216:384,tile=10x5";
      await ff("-i", video, "-vf", sheet, "-frames:v", "1", path.join(out, `sheet-${style}.png`));
    }

    console.log("\n--- SMART (8 s target) ---");
    const { summary: sm, video: smv } = await renderJob("Test smart", "smart", "&length=8");
    const shots = sm.shots || [];
    shots.forEach((sh, k) => console.log(`   ${k + 1}. ${sh.role} ${sh.file} ${sh.from}-${sh.to}s ${sh.transition}`));
    check(sm.ok === true && sm.seconds <= 8.1 && sm.seconds > 3, `fits the 8 s target (${sm.seconds} s)`);
    check(shots[0]?.role === "hook" && shots.at(-1)?.role === "payoff", "story: opens on the hook, ends on the payoff");
    const overlap = shots.some((a, i) => shots.some((b, j) => i < j && a.file === b.file && a.from < b.to - 1e-6 && b.from < a.to - 1e-6));
    check(shots.length >= 3 && !overlap, "never shows the same moment twice");
    check(shots.every((sh) => ["cut", "whip", "punch"].includes(sh.transition) && sh.why), "every shot has a transition and a reason");
    const si = JSON.parse(await run(process.env.FFPROBE || "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", smv]));
    check(si.streams.length === 1 && si.streams[0].width === 1080 && si.streams[0].height === 1920, "vertical 1080x1920, muted");
    const silly = await fetch(`${API}/jobs/empty/render?style=smart&length=500`, { method: "POST" });
    check(silly.status === 400, "silly target length refused (400)");
    check(/vision AI not reachable/.test(sm.note || ""), "no vision AI: still works and says so");

    console.log("\n--- SMART with file-name tags ---");
    check(tagSize("01 wide desk.mp4") === "wide" && tagSize("02 Close-up keys.mp4") === "close-up" && tagSize("IMG_20261024_1028.mp4") === null
      && tagHands("06 hands typing.mp4"), "reads shot-size tags from file names");
    const { summary: tg } = await renderJob("Test smart tags", "smart", "&length=8", { "12 wide desk.mov": path.join(samples, "05 landscape clip.mov") });
    const tagged = (tg.shots || []).filter((sh) => sh.file === "12 wide desk.mov");
    (tg.shots || []).forEach((sh, k) => console.log(`   ${k + 1}. ${sh.role} ${sh.file} ${sh.from}-${sh.to}s [${sh.size}]`));
    check(tagged.length && tagged.every((sh) => sh.size === "wide" && ["context", "payoff"].includes(sh.role)),
      "the clip tagged 'wide' becomes the context or payoff shot (whole product in view)");

    console.log("\n--- BACKGROUND JOBS ---");
    const bg = `${API}/jobs/${encodeURIComponent("Test background")}`;
    await upload(bg, sampleFiles());
    const t0 = Date.now();
    const post = await fetch(`${bg}/render?style=soft`, { method: "POST" });
    const answeredIn = Date.now() - t0;
    check(post.status === 202 && (await post.json()).status === "queued" && answeredIn < 2000, `starts in the background, answers at once (202 in ${answeredIn} ms)`);
    let st = await statusOf(bg);
    for (let i = 0; i < 100 && !(st.status === "working" && st.step !== "starting"); i++) { await sleep(100); st = await statusOf(bg); }
    check(st.status === "working" && !!st.step, `status shows progress while editing ("${st.step}")`);
    check((await fetch(`${bg}/render?style=soft`, { method: "POST" })).status === 409, "a second start while working is refused (409)");
    check((await fetch(`${bg}/files/extra.jpg`, { method: "PUT", body: "x" })).status === 409, "uploads while working are refused (409)");
    check((await fetch(bg, { method: "DELETE" })).status === 409, "deleting while working is refused (409)");
    check((await fetch(`${bg}/video`)).status === 404, "no video until it is done (404)");
    const fin = await waitForJob(bg);
    check(fin.status === "done" && fin.result?.ok === true && fin.seconds >= 1, `finishes as "done" with a summary (${fin.seconds} s)`);
    const vid = await fetch(`${bg}/video`);
    check(vid.ok && Number(vid.headers.get("content-length")) > 100000, "the video can be downloaded when done");
    await vid.arrayBuffer();
    await fetch(bg, { method: "DELETE" });
    check((await fetch(`${bg}/status`)).status === 404, "a deleted job is gone (404)");
    const cut = await statusOf(`${API}/jobs/${encodeURIComponent("Interrupted job")}`);
    const cutUp = await statusOf(`${API}/jobs/${encodeURIComponent("Interrupted upload")}`);
    check(cut.status === "failed" && /restarted/.test(cut.error || "") && cutUp.status === "failed",
      "jobs cut off by a restart (editing or receiving) are marked failed, so n8n stops waiting");

    console.log("\n--- RESERVING A JOB (what n8n does first) ---");
    const rj = `${API}/jobs/${encodeURIComponent("1AbC-drive_folder_id")}`;
    let r0 = await fetch(rj, { method: "POST" });
    let s0 = await statusOf(rj);
    check(r0.status === 201 && s0.status === "receiving" && s0.files === 0, `reserving answers 201 and the job waits for files ("${s0.status}", ${s0.files} files)`);
    await upload(rj, [["01 portrait photo.jpg", path.join(samples, "01 portrait photo.jpg")]]);
    s0 = await statusOf(rj);
    check(s0.status === "receiving" && s0.files === 1, `status counts the files that arrived (${s0.files})`);
    r0 = await fetch(`${rj}/render?style=smart&length=500`, { method: "POST" });
    s0 = await statusOf(rj);
    check(r0.status === 400 && s0.status === "failed" && /length must be/.test(s0.error || ""),
      `a reserved job that can't start is marked failed with the reason ("${s0.error}")`);
    r0 = await fetch(rj, { method: "POST" });
    s0 = await statusOf(rj);
    check(r0.status === 201 && s0.status === "receiving" && s0.files === 0, "reserving again starts fresh (old files cleared)");
    await fetch(rj, { method: "DELETE" });

    console.log("\n--- SAFETY ---");
    let r = await fetch(`${API}/jobs/..%2F..%2Fescape/files/..%2Fevil.txt`, { method: "PUT", body: "x" });
    const escaped = fs.existsSync(path.join(scratch, "escape")) || fs.existsSync(path.join(scratch, "evil.txt")) || fs.existsSync(path.join(work, "..", "evil.txt"));
    check(r.ok && !escaped, "sneaky ../ names stay inside the work folder");
    r = await fetch(`${API}/jobs/empty/render?style=sparkly`, { method: "POST" });
    check(r.status === 400, "unknown style refused (400)");
    r = await fetch(`${API}/jobs/empty/render?style=smooth`, { method: "POST" });
    const body = await r.json();
    check(r.status === 400 && /no files were uploaded/.test(body.error), `empty job is refused clearly: "${body.error}"`);
  } finally {
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
