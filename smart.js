// Smart Editor (v2): looks at the footage first, then plans a story the way an editor would.
// Theory: README.md, "Editing theory". Step 1 "look": analyzeClip(). Step 2 "plan": planSmart().
const { spawn } = require("child_process");

const AN_FPS = 10; // measurements per second
const AW = 270; // analysis width: small is fast, and still shows whether the focus is sharp
const SHRINK = 3; // motion is measured on a 3x smaller copy (90 px wide), first roughly on a 9x smaller one (30 px)
const R = 6; // rough search range on the 30 px copy (= 18 px on the 90 px copy, a fifth of the frame)
const GAP = 2; // compare frames 0.2 s apart, so slow camera slides still move a few pixels

function readFrames(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`analysis failed: ${err.trim()}`))));
  });
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function shrink(img, w, h) {
  const sw = Math.floor(w / SHRINK), sh = Math.floor(h / SHRINK), out = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0;
    for (let j = 0; j < SHRINK; j++) for (let i = 0; i < SHRINK; i++) s += img[(y * SHRINK + j) * w + x * SHRINK + i];
    out[y * sw + x] = s / (SHRINK * SHRINK);
  }
  return { px: out, w: sw, h: sh };
}

// Average difference between frame b and frame a slid by (sx, sy), over the middle of the picture.
function cost(a, b, sx, sy, margin, step) {
  const { w, h } = b;
  let s = 0, n = 0;
  for (let y = margin; y < h - margin; y += step) for (let x = margin; x < w - margin; x += step) {
    s += Math.abs(b.px[y * w + x] - a.px[(y - sy) * w + (x - sx)]); n++;
  }
  return s / n;
}

function bestShift(a, b, cx, cy, r, margin, step) {
  let best = { sx: cx, sy: cy, c: Infinity };
  for (let sy = cy - r; sy <= cy + r; sy++) for (let sx = cx - r; sx <= cx + r; sx++) {
    const c = cost(a, b, sx, sy, margin, step);
    if (c < best.c) best = { sx, sy, c };
  }
  return best;
}

// Focus: how strong the fine edges are (variance of the Laplacian). Blurry frames score low.
function sharpness(img, w, h) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * img[i] - img[i - 1] - img[i + 1] - img[i - w] - img[i + w];
    s += l; s2 += l * l; n++;
  }
  return s2 / n - (s / n) ** 2;
}

// How far the whole picture slid between two frames, and how much still changed after lining them up ("action":
// hands, moving objects). Rough first on the 30 px copy, where repeating patterns like rows of keys blur together and
// can't fool the match; then fine-tuned on the 90 px copy, down to a fraction of a pixel.
function shift(a, b) {
  const rough = bestShift(a.tiny, b.tiny, 0, 0, R, R, 1);
  const margin = SHRINK * R + 3, fine = bestShift(a.small, b.small, rough.sx * SHRINK, rough.sy * SHRINK, 2, margin, 2);
  const c = (sx, sy) => cost(a.small, b.small, sx, sy, margin, 2);
  const refine = (cm, c0, cp) => (cm + cp - 2 * c0 > 0 ? (cm - cp) / (2 * (cm + cp - 2 * c0)) : 0);
  const { sx, sy } = fine;
  return { sx: sx + refine(c(sx - 1, sy), fine.c, c(sx + 1, sy)), sy: sy + refine(c(sx, sy - 1), fine.c, c(sx, sy + 1)), action: fine.c };
}

// Measures a clip 10 times a second: sharp (focus), bright, camera vx/vy (frame widths per second; + = camera moves
// right / down), speed, and action. A photo gives one measurement.
async function analyzeClip(ffmpeg, file, { width, height }) {
  const AH = Math.max(6, Math.round((AW * height) / width / 2) * 2);
  const raw = await readFrames(ffmpeg, ["-v", "error", "-i", file, "-vf", `fps=${AN_FPS},scale=${AW}:${AH}:flags=area,format=gray`,
    "-f", "rawvideo", "-"]);
  const size = AW * AH, count = Math.floor(raw.length / size), copies = [], frames = [];
  for (let k = 0; k < count; k++) {
    const img = raw.subarray(k * size, (k + 1) * size), small = shrink(img, AW, AH);
    copies.push({ small, tiny: shrink(small.px, small.w, small.h) });
    const f = { t: k / AN_FPS, sharp: sharpness(img, AW, AH), bright: mean(img), vx: 0, vy: 0, speed: 0, action: 0 };
    const back = Math.min(GAP, k);
    if (back) {
      const m = shift(copies[k - back], copies[k]), secs = back / AN_FPS, sw = small.w;
      f.vx = -m.sx / sw / secs; // the picture slides left when the camera moves right
      f.vy = -m.sy / sw / secs;
      f.speed = Math.hypot(f.vx, f.vy);
      f.action = m.action;
    }
    frames.push(f);
  }
  if (frames.length > 1) Object.assign(frames[0], { vx: frames[1].vx, vy: frames[1].vy, speed: frames[1].speed });
  return frames;
}

// One-line description of a stretch of measurements, e.g. "camera slides left" or "camera still".
function describeMove(vx, vy) {
  if (Math.hypot(vx, vy) < 0.03) return "camera still";
  return Math.abs(vx) >= Math.abs(vy) ? `camera slides ${vx > 0 ? "right" : "left"}` : `camera moves ${vy > 0 ? "down" : "up"}`;
}

// ---------- Step 2: plan the story ----------

const pct = (values, p) => {
  const s = values.filter((v) => v > 0).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 1;
};
const snap = (x, grid) => Math.max(grid, Math.round(x / grid) * grid);

// Scores a stretch of one item (start s, length L) against the whole footage ("ref" = 90th percentiles).
function measure(item, s, L, ref) {
  const fr = item.kind === "photo" ? item.frames : item.frames.filter((f) => f.t >= s - 1e-6 && f.t < s + L - 1e-6);
  if (!fr.length) return null;
  const m = (k) => mean(fr.map((f) => f[k]));
  const shake = fr.length > 1 ? mean(fr.slice(1).map((f, i) => Math.hypot(f.vx - fr[i].vx, f.vy - fr[i].vy))) / ref.speed : 0;
  return {
    sharp: m("sharp") / ref.sharp,
    sharpMin: Math.min(...fr.map((f) => f.sharp)) / ref.sharp,
    speed: Math.min(1.5, m("speed") / ref.speed),
    action: Math.min(1.5, m("action") / ref.action),
    shake,
    bright: m("bright"),
    vx: m("vx"), vy: m("vy"),
  };
}

// The label nearest to the middle of a stretch (vision.js: size from the file name, product + hands from the AI), or null.
function sizeAt(item, s, L) {
  const mid = s + L / 2;
  return (item.labels || []).reduce((b, l) => (!b || Math.abs(l.t - mid) < Math.abs(b.t - mid) ? l : b), null);
}
const whole = (c) => c.label && (c.label.size === "wide" || c.label.size === "medium");

// What each part of the story wants from a shot (q = measurements, c = the candidate with its vision label).
// With size labels: the payoff and the context want the whole product in view, details want parts (close-ups).
const SCORE = {
  hook: (q) => q.sharp + 0.6 * Math.min(q.speed, 1) + 0.6 * Math.min(q.action, 1) - 0.5 * q.shake, // striking + moving
  hero: (q, c) => 1.3 * q.sharp + 0.3 * Math.min(q.speed, 1) - 0.8 * q.shake + (whole(c) ? 0.6 : 0), // sharp, smooth, whole
  detail: (q, c) => q.sharp + 0.5 * Math.min(q.action, 1) + 0.3 * Math.min(q.speed, 1) - 0.4 * q.shake - (whole(c) ? 0.3 : 0),
};

// Plans a story from analysed items (file order = shooting order):
//   hook (best striking moment, first 3 s rule) → context (a shot tagged wide/medium if there is one, else how the
//   footage starts) → details in shooting order, getting shorter to build tension → in use (shots with hands) →
//   payoff (the sharpest, smoothest shot, whole product if possible, held: the release) → fade out.
// Cuts land during movement ("cut on action"); a whip only where the camera moves the same way on both sides of the
// cut; a zoom punch on the payoff reveal; plain cuts everywhere else. Lengths sit on a half-beat grid for music.
function planSmart(items, { target = 30, beat = 0.6 } = {}) {
  const half = beat / 2, all = items.flatMap((it) => it.frames);
  const ref = { sharp: pct(all.map((f) => f.sharp), 0.9), speed: Math.max(0.05, pct(all.map((f) => f.speed), 0.9)), action: Math.max(0.5, pct(all.map((f) => f.action), 0.9)) };
  // A shot is usable only if the product stays clear the whole time: no moment much blurrier than its clip normally is
  // (judged per clip, because a close-up of big keycaps has fewer fine edges than a wide shot but isn't blurry), no
  // all-blurry clip, and not too dark or blown out.
  const med = items.map((it) => pct(it.frames.map((f) => f.sharp), 0.5) / ref.sharp);
  const usable = (q, i) => q && med[i] >= 0.15 && q.sharpMin >= 0.5 * med[i] && q.bright > 35 && q.bright < 225;
  const taken = items.map(() => []); // [start, end] stretches already used, per item
  const free = (i, s, L) => taken[i].every(([a, b]) => s + L + half <= a || s >= b + half);
  const length = (it) => (it.kind === "photo" ? Infinity : it.info.duration);

  // Every usable stretch of length L in the footage (photos: one each).
  const candidates = (L, filter = () => true) => items.flatMap((it, i) => {
    if (!filter(it, i)) return [];
    const starts = it.kind === "photo" ? [0] : [];
    for (let s = 0; it.kind !== "photo" && s + L <= length(it) + 1e-6; s += 0.1) starts.push(+s.toFixed(1));
    return starts.filter((s) => free(i, s, L)).map((s) => ({ i, s, L, q: measure(it, s, L, ref), label: sizeAt(it, s, L) })).filter((c) => usable(c.q, i));
  });
  const take = (c, role, why) => {
    taken[c.i].push([c.s, c.s + c.L]);
    return { ...items[c.i], idx: c.i, role, start: c.s, dur: c.L, q: c.q, label: c.label, why };
  };
  const best = (list, score) => list.reduce((b, c) => (!b || score(c.q, c) > score(b.q, b) ? c : b), null);
  const said = (c) => { // where a label came from: shot size from the file name, product name from the vision AI
    const bits = c.label ? [c.label.size && `${c.label.size} (file name)`, c.label.product && `${c.label.product} (vision AI)`].filter(Boolean) : [];
    return bits.length ? ` [${bits.join(", ")}]` : "";
  };
  const hasClips = items.some((it) => it.kind === "video");
  const clipsOnly = (it) => !hasClips || it.kind === "video";

  // The payoff is chosen first: it matters more than the hook, and it needs the longest stretch of one shot.
  const heroC = best(candidates(4 * beat), SCORE.hero) || best(candidates(2 * beat), SCORE.hero);
  const hero = heroC && take(heroC, "payoff", `sharpest, smoothest shot${whole(heroC) ? ", whole product in view" : ""}, held at the end (the payoff)${said(heroC)}`);
  const hookC = best(candidates(2 * beat, clipsOnly), SCORE.hook);
  if (!hookC && !hero) return { shots: [], note: "no sharp, usable footage found" };
  const hook = hookC && take(hookC, "hook", "most striking sharp moment, so it opens the video (3-second rule)");
  const wideC = best(candidates(3 * beat).filter(whole), SCORE.detail);
  const firstL = items.map((_, i) => candidates(3 * beat, (it, j) => j === i)).find((l) => l.length);
  const firstC = firstL && firstL.reduce((a, c) => (c.s < a.s ? c : a));
  const context = wideC ? take(wideC, "context", `whole product in view: sets the scene${said(wideC)}`)
    : firstC && take(firstC, "context", `how the footage starts: sets the scene${said(firstC)}`);

  // Details: best stretches, at most 4 per clip, until the target length is used up; then put back in shooting order.
  const fixed = (hook ? hook.dur : 0) + (hero ? hero.dur : 0) + (context ? context.dur : 0);
  const details = [];
  for (let budget = target - fixed; budget >= beat - 1e-6;) {
    const c = best(candidates(1.5 * beat, (it, i) => taken[i].length < (it.kind === "photo" ? 1 : 4)), SCORE.detail);
    if (!c) break;
    const inUse = c.label && c.label.hands;
    details.push(take(c, inUse ? "in use" : "detail", `${inUse ? "hands using it" : "sharp moment with movement"}${said(c)}`));
    budget -= 1.5 * beat;
  }
  details.sort((a, b) => (a.role === "in use") - (b.role === "in use") || a.idx - b.idx || a.start - b.start); // in use last
  // Build tension: details get shorter towards the payoff (2 beats → 1.5 → 1).
  // A shot only grows if it still leaves a gap before the next shot from the same clip (else the cut would be invisible).
  details.forEach((d, k) => {
    const want = snap([2, 1.5, 1][Math.min(2, Math.floor((3 * k) / Math.max(1, details.length)))] * beat, half);
    taken[d.idx] = taken[d.idx].filter(([a]) => Math.abs(a - d.start) > 1e-6);
    const fits = (L) => (d.kind === "photo" || d.start + L <= length(d) + 1e-6) && free(d.idx, d.start, L);
    d.dur = [want, 1.5 * beat, beat, half].find((L) => L <= want + 1e-6 && fits(L)) || d.dur;
    taken[d.idx].push([d.start, d.start + d.dur]);
  });

  const shots = [hook, context, ...details, hero].filter(Boolean);
  // Trim to the target from the middle of the details (keep hook, context and payoff).
  while (shots.reduce((a, s) => a + s.dur, 0) > target + 1e-6 && shots.length > 3) shots.splice(Math.floor(shots.length / 2), 1);
  taken.forEach((t) => (t.length = 0));
  shots.forEach((sh) => taken[sh.idx].push([sh.start, sh.start + sh.dur]));

  // Cut on action: slide each clip shot up to ±0.2 s so its last moment is the most moving one (if it stays sharp).
  for (const s of shots) {
    if (s.kind === "photo") continue;
    const i = s.idx, it = items[i];
    taken[i] = taken[i].filter(([a]) => Math.abs(a - s.start) > 1e-6);
    let bestS = s.start, bestMove = -1;
    for (const d of [-0.2, -0.1, 0, 0.1, 0.2]) {
      const st = +(s.start + d).toFixed(1);
      if (st < 0 || st + s.dur > length(it) + 1e-6 || !free(i, st, s.dur) || !usable(measure(it, st, s.dur, ref), i)) continue;
      const end = measure(it, st + s.dur - 0.2, 0.2, ref), move = end ? end.speed + end.action : 0;
      if (move > bestMove + 1e-9) { bestMove = move; bestS = st; }
    }
    s.start = bestS;
    taken[i].push([s.start, s.start + s.dur]);
  }

  // Transitions with a reason.
  shots.forEach((s, k) => {
    s.into = "cut";
    s.last = k === shots.length - 1;
    if (!k) return;
    const prev = shots[k - 1], a = measure(items[prev.idx], prev.start + prev.dur - 0.2, 0.2, ref);
    const b = measure(items[s.idx], s.start, 0.2, ref);
    const moving = (q) => q && Math.hypot(q.vx, q.vy) / ref.speed > 0.4;
    const cos = moving(a) && moving(b) ? (a.vx * b.vx + a.vy * b.vy) / (Math.hypot(a.vx, a.vy) * Math.hypot(b.vx, b.vy)) : 0;
    if (cos > 0.8) {
      s.into = "whip";
      s.angle = Math.round(((Math.atan2(a.vy + b.vy, a.vx + b.vx) * 180) / Math.PI + 360) % 180);
      s.why += `; whip: ${describeMove(a.vx, a.vy)} on both sides of the cut`;
    } else if (s.role === "payoff") {
      s.into = "punch";
      s.why += "; zoom punch for the reveal";
    }
  });
  const total = +shots.reduce((a, s) => a + s.dur, 0).toFixed(2);
  const note = total < target - beat ? `only ${total} s of sharp footage for a ${target} s target: film more clips for a longer video` : "";
  return { shots, note };
}

module.exports = { analyzeClip, describeMove, planSmart, readFrames, AN_FPS };
