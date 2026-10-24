// Auto Edit Robot: turns a folder of photos + clips into one muted vertical video (1080x1920, 60 fps) with transitions.
// See README.md. CLI: node render.js <inDir> <outFile> <smooth|punchy|beat|hype|soft|smart> [seconds]
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { analyzeClip, planSmart } = require("./smart");
const { labelShots, productName } = require("./vision");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const W = 1080, H = 1920;
const FPS = Number(process.env.OUTPUT_FPS) || 60; // 60 = smoother zooms, slides and shakes (platforms all accept 60)
// Effect timings below were tuned in frames at 30 fps; fr() turns them into this frame rate, so they last as long.
const fr = (frames30) => Math.max(1, Math.round((frames30 * FPS) / 30));
const PHOTO_SECONDS = 2.5;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".heif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp"]);

// Transitions and filters are limited to ones in FFmpeg 7.1 (Debian 13, the container) and newer.
const STYLES = {
  smooth: { transition: 0.6, transitions: ["fade", "smoothleft", "dissolve", "smoothup"] },
  punchy: { transition: 0.25, transitions: ["slideleft", "zoomin", "slideup", "wiperight", "circleopen", "slidedown"] },
  // Copies the "aesthetic desk unboxing" TikToks in autoedit/reference: hard cuts on a steady beat (0.6 s = 100 BPM),
  // a whip or zoom blur every 4th cut, a 4-frame stutter at the start, moody colours, and a quick fade to black.
  beat: { beat: 0.6, piecesPerClip: 6, blurEvery: 4, stutter: 3, grade: "eq=saturation=0.7:contrast=1.1:brightness=-0.02" },
  // Learned from 5 anime edits (README: "Editing notes"), kept product-friendly (shots >= 0.3 s):
  // slow dark intro → flash-cut "drop" on a 1, ½, ½ beat rhythm with zoom punches, shakes and RGB splits →
  // the drop's first 4 beats again → flash ending. No glow on the shots, so the product stays clear.
  hype: { beat: 0.6, piecesPerClip: 6, intro: 2, rhythm: [1, 0.5, 0.5], repeat: 6,
    introGrade: "eq=brightness=-0.08:contrast=1.1:saturation=0.6", grade: "eq=brightness=-0.03:contrast=1.15:saturation=1.1" },
  // Learned from 3 soft romance edits (README: "Editing notes"): steady 1.1 s shots (2 beats at
  // ~109 BPM), a dissolve at every cut, a small zoom pulse on the beat in between, warm colours. Kept sharp on purpose:
  // no white glow and no blur, so the product is always clear. Pieces run 0.2 s longer than a shot so the 0.2 s
  // crossfades keep the cuts 1.1 s apart; the pulse lands 0.55 s after each crossfade's middle.
  soft: { beat: 1.1, transition: 0.2, transitions: ["fade"], pulse: 0.65, piecesPerClip: 4,
    grade: "colorbalance=rs=0.06:gs=0.01:bs=-0.06:rm=0.04:bm=-0.03,eq=saturation=0.9" },
  // v2 Smart Editor (smart.js): looks at the footage, then plans a story to a target length (README: "Editing theory").
  smart: { beat: 0.6, target: 30 },
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} failed: ${err.trim().split("\n").slice(-3).join(" | ")}`))));
  });
}

async function probe(file, useRotation = true) {
  const info = JSON.parse(await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]));
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  if (!v) throw new Error("no picture or video inside");
  const rot = (v.side_data_list || []).find((s) => s.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate || 0);
  const sideways = useRotation && Math.abs(rot) % 180 === 90;
  const [num, den] = (v.r_frame_rate || "0/1").split("/").map(Number);
  return {
    width: sideways ? v.height : v.width,
    height: sideways ? v.width : v.height,
    duration: Number(info.format?.duration) || Number(v.duration) || 0,
    fps: den ? num / den : 0,
  };
}

// Phone JPEGs often store portrait photos sideways plus an EXIF "rotate" flag. Newer FFmpeg obeys the flag and older
// FFmpeg (like the container's) ignores it, so we read it ourselves and turn FFmpeg's autorotate off for JPEGs.
const EXIF_FIX = { 2: "hflip", 3: "hflip,vflip", 4: "vflip", 5: "transpose=0", 6: "transpose=1", 7: "transpose=3", 8: "transpose=2" };

function jpegOrientation(file) {
  try {
    const buf = Buffer.alloc(128 * 1024);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    for (let i = 2; buf[i] === 0xff && buf[i + 1] !== 0xda; i += 2 + buf.readUInt16BE(i + 2)) {
      if (buf[i + 1] !== 0xe1 || buf.toString("binary", i + 4, i + 10) !== "Exif\0\0") continue;
      const t = i + 10, le = buf.toString("binary", t, t + 2) === "II";
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const ifd = t + (le ? buf.readUInt32LE(t + 4) : buf.readUInt32BE(t + 4));
      for (let e = 0; e < u16(ifd); e++) if (u16(ifd + 2 + e * 12) === 0x0112) return u16(ifd + 2 + e * 12 + 8);
      return 1;
    }
  } catch {} // unreadable header: treat as upright
  return 1;
}

const even = (x) => Math.round(x / 2) * 2;

// Fills the 1080x1920 frame. Nearly vertical media is cropped to fill; anything else is fitted on a blurred copy of itself.
function fit(prefix, { width, height }) {
  if (Math.abs(width / height - W / H) < 0.03) {
    return `${prefix}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  }
  return `${prefix}split=2[bg][fg];` +
    `[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,scale=${W}:${H},eq=brightness=-0.1[bgb];` +
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

// Photo motion: smooth and soft = slow zoom (alternating in/out), punchy and beat = quick zoom punch then a small drift.
function zoomExpr(style, index, frames) {
  if (style !== "smooth" && style !== "soft") return `if(lt(on,${fr(10)}),1.22-0.22*on/${fr(10)},1+0.03*(on-${fr(10)})/${frames - fr(10)})`;
  return index % 2 === 0 ? `1+0.10*on/${frames - 1}` : `1.10-0.10*on/${frames - 1}`;
}

// Turns items into pieces: each photo is one piece, each clip gives up to piecesPerClip pieces spread across it (jump
// cuts through the action). durationAt(k, total) sets piece k's length; a clip piece never runs past the clip's end.
function spread(items, look, durationAt) {
  const B = look.beat;
  const skipStart = (d) => (d > 2 ? 0.2 : 0); // skip the shaky first moment of longer clips
  const counts = items.map(({ kind, info: { duration: d } }) =>
    kind === "photo" || d < B + 0.1 ? 1 : Math.max(1, Math.min(look.piecesPerClip, Math.floor((d - skipStart(d) + B) / (2 * B)))));
  const total = counts.reduce((a, b) => a + b, 0), pieces = [];
  items.forEach((it, idx) => {
    const n = counts[idx], d = it.info.duration, s0 = d < B + 0.1 ? 0 : skipStart(d);
    for (let i = 0; i < n; i++) {
      const want = durationAt(pieces.length, total);
      if (it.kind === "photo") { pieces.push({ ...it, start: 0, dur: want }); continue; }
      const start = n > 1 ? s0 + (i * Math.max(0, d - s0 - want)) / (n - 1) : s0;
      pieces.push({ ...it, start, dur: Math.min(want, d - start) });
    }
  });
  return pieces;
}

// BEAT: 1-beat pieces; "into" says how a piece starts: a hard cut, or a whip / zoom blur every few cuts.
function planBeat(items, look) {
  const pieces = spread(items, look, () => look.beat);
  pieces.slice(0, look.stutter).forEach((p) => (p.dur = Math.min(p.dur, 4 / 30))); // stutter hook: 0.13 s flashes
  pieces.forEach((p, j) => (p.into = j && j % look.blurEvery === 0 ? ((j / look.blurEvery) % 2 ? "whip" : "zoomblur") : "cut"));
  return pieces;
}

// HYPE: 2-beat intro pieces → drop pieces on the 1, ½, ½ rhythm → the drop's first pieces again → a 2-beat ending.
// fx lists each drop piece's opening effect; every effect sits at the start of its piece, so pieces can be reused.
function planHype(items, look) {
  const B = look.beat;
  const introCount = (total) => (total >= 5 ? look.intro : 1);
  const pieces = spread(items, look, (k, total) => {
    const intro = introCount(total);
    if (k < intro || k === total - 1) return 2 * B;
    return look.rhythm[(k - intro) % look.rhythm.length] * B;
  });
  const intro = introCount(pieces.length);
  pieces.forEach((p, k) => {
    p.id = k;
    p.first = k === 0;
    p.part = k < intro ? "intro" : k === pieces.length - 1 && k > 0 ? "ending" : "drop";
    const c = k - intro; // cut number inside the drop; 0 = the reveal
    p.fx = p.part !== "drop" ? {} : { flash: c % 4 === 0, shake: c % 4 === 2, rgb: c % 8 === 5, punch: p.dur >= B - 0.01 };
  });
  // Like the anime edits: play the drop's first 4 beats (the reveal) again before the ending.
  const drop = pieces.filter((p) => p.part === "drop");
  const order = pieces.slice(0, -1);
  if (drop.length >= look.repeat + 4) order.push(...drop.slice(0, look.repeat).map((p) => ({ ...p, reuse: true })));
  return pieces.length > 1 ? [...order, pieces.at(-1)] : pieces;
}

// The frames of step k of a short effect that was 1 frame per step at 30 fps (e.g. a 3-step blur: strong → weak),
// counted from the start of a piece, or backwards from its end (fromEnd, with the piece's frame count).
function frameRange(k, fromEnd, frames) {
  const first = k === 0 ? 0 : fr(k), last = fr(k + 1) - 1;
  return fromEnd ? `between(n,${frames - 1 - last},${frames - 1 - first})` : `between(n,${first},${last})`;
}

// HYPE camera moves as zoompan expressions. N = frame number; s scales pixel offsets to zoompan's input size.
function hypeMotion(p, frames, N, s) {
  const fx = p.fx || {};
  let z = "1";
  if (fx.punch || fx.flash) z += `+0.15*max(0,1-${N}/${fr(5)})`; // zoom punch: starts 15% in, settles in 1/6 s
  if (fx.shake) z += "+0.07"; // room to shake
  z += p.part === "intro" ? `+0.08*${N}/${frames}` : `+0.03*${N}/${frames}`; // slow push-in / small drift
  const shake = (a, wave) => (fx.shake ? `+${a * s}*max(0,1-${N}/${fr(8)})*${wave}` : ""); // jitter that dies out in 0.27 s
  const speed = (30 / FPS).toFixed(3); // same wobble speed at any frame rate
  return `z='${z}':x='iw/2-(iw/zoom/2)${shake(30, `sin(${N}*2.9*${speed})`)}':y='ih/2-(ih/zoom/2)${shake(24, `cos(${N}*3.7*${speed})`)}'`;
}

// HYPE looks: dim intro (fading in from black), contrasty drop, a white frame + bright fade on flash cuts, red/blue
// edges pulling apart on RGB splits, and a white flash then fade to black at the end.
function hypeEffects(graph, p, frames, look) {
  const fx = p.fx || {}, D = frames / FPS;
  if (p.part === "intro") return graph + `,${look.introGrade}` + (p.first ? ",fade=t=in:st=0:d=0.5" : "");
  graph += `,${look.grade}`;
  if (fx.flash) graph += `,drawbox=color=white:t=fill:enable='lt(n,${fr(1)})',eq=brightness='0.5*max(0,1-n/${fr(4)})':eval=frame`;
  if (fx.rgb) [24, 14, 6].forEach((a, k) => (graph += `,rgbashift=rh=-${a}:bh=${a}:enable='${frameRange(k, false, 0)}'`));
  if (p.part === "ending") graph += `,fade=t=out:color=white:st=${(D - 0.7).toFixed(3)}:d=0.1,fade=t=out:st=${(D - 0.5).toFixed(3)}:d=0.5`;
  return graph;
}

// SOFT: steady pieces, one shot (+ the crossfade) long each; the first fades in from black and the last fades out.
function planSoft(items, look) {
  const pieces = spread(items, look, () => look.beat + look.transition);
  pieces.forEach((p, k) => {
    p.first = k === 0;
    p.last = k === pieces.length - 1;
  });
  return pieces;
}

// SOFT beat pulse: a 3% zoom bump around the beat in the middle of the shot (N = zoompan's frame number).
const softPulse = (look, N) => `0.03*max(0,1-abs(${N}-${Math.round(look.pulse * FPS)})/${fr(4)})`;

// SOFT looks: warm colours, fade in / out at the ends. (The dissolves are crossfades made when the pieces are joined.)
function softEffects(graph, p, frames, look) {
  const D = frames / FPS;
  graph += `,${look.grade}`;
  if (p.first) graph += ",fade=t=in:st=0:d=0.5";
  if (p.last) graph += `,fade=t=out:st=${Math.max(0, D - 0.5).toFixed(3)}:d=${Math.min(0.5, D).toFixed(3)}`;
  return graph;
}

// SMART: measure every item, ask the home vision AI what each shot shows, then let the story planner choose shots.
// The shot list comes back as the plan; plan.note says what limited it (too little footage, no vision AI…).
// A file the robot can't look at (broken) is skipped, like in the other styles.
async function planSmartEdit(items, look, { length, skip, log } = {}) {
  const seen = [];
  for (const it of items) {
    try {
      it.frames = await analyzeClip(FFMPEG, it.file, it.info);
      if (it.frames.length) seen.push(it);
    } catch (e) {
      skip(it.name, e);
    }
  }
  const vision = await labelShots(FFMPEG, seen, log); // the home AI's shot sizes ("" = fine)
  const { shots, note } = planSmart(seen, { target: length || look.target, beat: look.beat });
  return Object.assign(shots, { note: [note, vision].filter(Boolean).join("; "), product: productName(seen) });
}

// SMART looks: real colours (buyers should see the true product); whips only where the plan found the camera moving
// the same way on both sides of a cut (blurred along that move, strongest at the cut); a fade out at the end.
function smartEffects(graph, p, next, frames) {
  const whip = (angle, fromEnd) => [60, 35, 15].map((r, k) => `,dblur=angle=${angle}:radius=${r}:enable='${frameRange(k, fromEnd, frames)}'`).join("");
  if (p.into === "whip") graph += whip(p.angle, false);
  if (next?.into === "whip") graph += whip(next.angle, true);
  if (p.last) {
    const f = Math.min(0.4, frames / FPS / 2);
    graph += `,fade=t=out:st=${(frames / FPS - f).toFixed(3)}:d=${f.toFixed(3)}`;
  }
  return graph;
}

// BEAT blur transitions live inside the pieces: the 0.1 s before a blur cut and the 0.1 s after it (strongest at the cut).
function beatEffects(graph, p, next, frames, isLast, look) {
  graph += `,${look.grade}`;
  const head = p.into, tail = next?.into || "cut";
  if (head === "whip" || tail === "whip") {
    [60, 35, 15].forEach((radius, k) => {
      const on = [head === "whip" && frameRange(k, false, frames), tail === "whip" && frameRange(k, true, frames)].filter(Boolean).join("+");
      graph += `,dblur=angle=0:radius=${radius}:enable='${on}'`;
    });
  }
  if (head === "zoomblur" || tail === "zoomblur") {
    // A zoom blur is the frame averaged with bigger and bigger copies of itself (8 copies = smooth streaks).
    const on = [head === "zoomblur" && `lte(n,${fr(3) - 1})`, tail === "zoomblur" && `gte(n,${frames - fr(3)})`].filter(Boolean).join("+");
    const copies = [0, 1, 2, 3, 4, 5, 6, 7];
    graph += `[zin];[zin]split=2[zo][z];[z]split=8${copies.map((k) => `[z${k}]`).join("")};` +
      copies.map((k) => `[z${k}]scale=${even(W * (1 + 0.05 * k))}:${even(H * (1 + 0.05 * k))},crop=${W}:${H}[zs${k}];`).join("") +
      `${copies.map((k) => `[zs${k}]`).join("")}mix=inputs=8[zb];[zo][zb]overlay=enable='${on}'`;
  }
  if (isLast) {
    const f = Math.min(0.3, frames / FPS / 2);
    graph += `,fade=t=out:st=${(frames / FPS - f).toFixed(3)}:d=${f.toFixed(3)}`;
  }
  return graph;
}

// Every segment leaves upright with no leftover "rotate" flag (else it gets turned again when joined), and in TV-range
// colour: JPEG photos are "full range", and mixing ranges makes apps show the wrong contrast.
const NORMAL = ",sidedata=mode=delete:type=DISPLAYMATRIX,scale=out_range=tv,format=yuv420p";
const ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];

// One piece of the final video: a photo (dur seconds), part of a clip (start + dur), or a whole clip (dur 0).
async function makeSegment(p, style, look, index, outFile, next, isLast) {
  const { file, kind, info } = p;
  const frames = Math.round((p.dur || info.duration) * FPS);
  let input, graph;
  if (kind === "photo") {
    const turn = EXIF_FIX[info.orientation] ? `${EXIF_FIX[info.orientation]},` : "";
    input = info.jpeg ? ["-noautorotate", "-i", file] : ["-i", file];
    const pulse = style === "soft" ? `+${softPulse(look, "on")}` : "";
    const punch = style === "smart" && p.into === "punch";
    const move = style === "hype" ? hypeMotion(p, frames, "on", 2)
      : `z='${punch ? zoomExpr("punchy", index, frames) : zoomExpr(style, index, frames)}${pulse}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    graph = fit(`[0:v]${turn}`, info) + `,scale=${W * 2}:${H * 2},zoompan=${move}:d=${frames}:s=${W}x${H}:fps=${FPS}`;
  } else {
    // HYPE intro clips play at half speed when filmed at 50+ fps (slower footage would stutter).
    const slow = style === "hype" && p.part === "intro" && info.fps >= 50;
    const take = slow ? p.dur / 2 : p.dur;
    input = p.dur ? ["-ss", p.start.toFixed(3), "-t", take.toFixed(3), "-i", file] : ["-i", file];
    graph = fit(`[0:v]${slow ? "setpts=2*PTS," : ""}fps=${FPS},`, info);
    const fx = p.fx || {};
    if (style === "hype" && (p.part === "intro" || fx.punch || fx.flash || fx.shake)) {
      graph += `,zoompan=${hypeMotion(p, frames, "on", 1)}:d=1:s=${W}x${H}:fps=${FPS}`;
    }
    if (style === "soft") graph += `,zoompan=z='1+${softPulse(look, "on")}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
    if (style === "smart" && p.into === "punch") { // the payoff reveal: starts 15% in, settles in 1/6 s
      graph += `,zoompan=z='1+0.15*max(0,1-on/${fr(5)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
    }
  }
  if (style === "beat") graph = beatEffects(graph, p, next, frames, isLast, look);
  if (style === "hype") graph = hypeEffects(graph, p, frames, look);
  if (style === "soft") graph = softEffects(graph, p, frames, look);
  if (style === "smart") graph = smartEffects(graph, p, next, frames);
  const limit = p.dur ? ["-frames:v", String(frames)] : [];
  await run(FFMPEG, ["-y", "-v", "error", ...input, "-filter_complex", `${graph}${NORMAL}[v]`, "-map", "[v]", ...limit, ...ENCODE, "-crf", "18", outFile]);
  return (await probe(outFile)).duration;
}

async function render({ inDir, outFile, style = "smooth", length, tmpDir, log = console.log }) {
  const started = Date.now();
  const look = STYLES[style];
  if (!look) throw new Error(`unknown style "${style}" (use ${Object.keys(STYLES).join(", ")})`);
  if (!fs.existsSync(inDir)) throw new Error("no files were uploaded");
  tmpDir = tmpDir || path.join(path.dirname(outFile), "tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const skipped = [];
  const skip = (name, e) => {
    const reason = /no picture|too short/.test(e.message) ? e.message : "can't read this file (broken, or a type FFmpeg doesn't support)";
    skipped.push({ file: name, reason });
    log(`skip ${name}: ${e.message}`);
  };

  // File name order = shooting order for phone files; "2" sorts before "10".
  const names = fs.readdirSync(inDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const items = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    const kind = IMAGE_EXT.has(ext) ? "photo" : VIDEO_EXT.has(ext) ? "video" : null;
    if (!kind) continue; // not media (e.g. desktop.ini)
    const file = path.join(inDir, name);
    try {
      const jpeg = /\.jpe?g$/i.test(name);
      const info = { ...(await probe(file, !jpeg)), jpeg, orientation: jpeg ? jpegOrientation(file) : 1 };
      if (info.orientation >= 5) [info.width, info.height] = [info.height, info.width];
      items.push({ name, file, kind, info });
    } catch (e) {
      skip(name, e);
    }
  }

  const planners = { beat: planBeat, hype: planHype, soft: planSoft, smart: planSmartEdit };
  const plan = planners[style] ? await planners[style](items, look, { length, skip, log })
    : items.map((it) => ({ ...it, start: 0, dur: it.kind === "photo" ? PHOTO_SECONDS : 0 }));
  const segments = [], used = [], failed = new Set(), made = new Map();
  for (const [k, p] of plan.entries()) {
    if (failed.has(p.name)) continue;
    if (p.reuse) { // a repeated piece: same file again
      if (made.has(p.id)) segments.push(made.get(p.id));
      continue;
    }
    const seg = path.join(tmpDir, `seg_${String(segments.length).padStart(3, "0")}.mp4`);
    try {
      const duration = await makeSegment(p, style, look, segments.length, seg, plan[k + 1], k === plan.length - 1);
      if (duration < 0.1) throw new Error("too short");
      segments.push({ file: seg, duration });
      made.set(p.id, segments.at(-1));
      if (used.at(-1) !== p.name) used.push(p.name);
      log(`ok   ${p.name} (${p.kind}, ${duration.toFixed(2)} s)`);
    } catch (e) {
      failed.add(p.name);
      if (!used.includes(p.name)) skip(p.name, e);
    }
  }
  if (!segments.length) throw new Error("no usable photos or videos found");

  if (planners[style] && !look.transition) {
    // Hard cuts: glue the pieces end to end (their effects are already inside them).
    const list = path.join(tmpDir, "list.txt");
    fs.writeFileSync(list, segments.map((s) => `file '${path.basename(s.file)}'`).join("\n"));
    await run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v", "-r", String(FPS),
      ...ENCODE, "-crf", "20", "-movflags", "+faststart", outFile]);
  } else {
    // Each transition overlaps two neighbours; it never eats more than a third of a short clip.
    const inputs = segments.flatMap((s) => ["-i", s.file]);
    let graph = "", last = "[0:v]", total = segments[0].duration;
    for (let k = 1; k < segments.length; k++) {
      const T = Math.min(look.transition, segments[k - 1].duration / 3, segments[k].duration / 3);
      const name = look.transitions[(k - 1) % look.transitions.length];
      graph += `${last}[${k}:v]xfade=transition=${name}:duration=${T.toFixed(3)}:offset=${(total - T).toFixed(3)}[x${k}];`;
      total += segments[k].duration - T;
      last = `[x${k}]`;
    }
    graph += `${last}format=yuv420p[out]`;
    await run(FFMPEG, ["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[out]", "-r", String(FPS),
      ...ENCODE, "-crf", "20", "-movflags", "+faststart", outFile]);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const count = (kind) => items.filter((it) => it.kind === kind && used.includes(it.name)).length;
  const seconds = (await probe(outFile)).duration;
  const result = { ok: true, style, photos: count("photo"), videos: count("video"), used, skipped, seconds: +seconds.toFixed(2),
    renderSeconds: Math.round((Date.now() - started) / 1000) };
  if (style === "smart") { // the editor's shot list, with the reason for every choice
    result.shots = plan.map((s) => ({ role: s.role, file: s.name, from: +s.start.toFixed(1), to: +(s.start + s.dur).toFixed(1),
      size: s.label ? s.label.size : null, transition: s.into, why: s.why }));
    result.note = plan.note;
    result.product = plan.product; // e.g. "Attack Shark keyboard", for captions and the email
  }
  return result;
}

module.exports = { render, probe, run, jpegOrientation, FFMPEG, FPS, STYLE_NAMES: Object.keys(STYLES) };

if (require.main === module) {
  const [inDir, outFile, style, length] = process.argv.slice(2);
  render({ inDir, outFile, style, length: Number(length) || undefined }).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
