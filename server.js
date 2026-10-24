// Auto Edit Robot API (no open port: only n8n on the Docker network "ai" can reach it at http://autoedit:8090).
//   GET    /health                       → { ok, ffmpeg, jobsWaiting }
//   POST   /jobs/<job>                   → reserves a fresh job ("receiving") before its files are sent
//   PUT    /jobs/<job>/files/<name>      → raw file body, saved to <job>/in/<name>
//   POST   /jobs/<job>/render?style=...  → starts editing in the background (smooth | punchy | beat | hype | soft | smart,
//                                          &length= seconds for smart) and answers 202 at once
//   GET    /jobs/<job>/status            → { status: receiving | queued | working | done | failed, step, seconds, files,
//                                          result | error }
//   GET    /jobs/<job>/video             → the finished MP4
//   DELETE /jobs/<job>                   → removes the job's files
// A SMART edit can take hours on a CPU-only homelab, so n8n starts the job and checks /status every few minutes
// instead of waiting on one long request.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { render, run, FFMPEG, STYLE_NAMES } = require("./render");

const PORT = Number(process.env.PORT || 8090);
const WORK = process.env.WORK_DIR || "/work";

// Folder and file names come from Google Drive; keep them readable but unable to escape the job folder.
const clean = (s) => {
  let name;
  try { name = decodeURIComponent(s); } catch { name = s; }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 150);
  if (!name) throw Object.assign(new Error("bad name"), { status: 400 });
  return name;
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Each job's status lives in memory and in <job>/status.json, so it can still be read after a restart.
const statusFile = (jobDir) => path.join(jobDir, "status.json");
function saveStatus(jobDir, st) {
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(statusFile(jobDir), JSON.stringify(st, null, 1));
  return st;
}
function readStatus(jobDir) {
  try { return JSON.parse(fs.readFileSync(statusFile(jobDir), "utf8")); } catch { return null; }
}
const busy = (st) => st && (st.status === "queued" || st.status === "working");

const inFiles = (jobDir) => { try { return fs.readdirSync(path.join(jobDir, "in")).length; } catch { return 0; } };

// A job that was receiving, queued or working when the editor stopped will never finish: say so, so n8n stops waiting.
fs.mkdirSync(WORK, { recursive: true });
for (const name of fs.readdirSync(WORK)) {
  const jobDir = path.join(WORK, name), st = readStatus(jobDir);
  if (busy(st) || st?.status === "receiving") saveStatus(jobDir, { ...st, status: "failed", finishedAt: new Date().toISOString(),
    error: "the editor restarted before this job finished: start it again" });
}

let queue = Promise.resolve(); // one render at a time (the Dell has 4 cores)
let waiting = 0; // jobs queued or working

function startJob(jobDir, style, length) {
  const name = path.basename(jobDir);
  const update = (change) => saveStatus(jobDir, { ...readStatus(jobDir), ...change });
  saveStatus(jobDir, { job: name, status: "queued", style, length: length ?? null, queuedAt: new Date().toISOString() });
  const position = waiting++;
  const job = async () => {
    update({ status: "working", startedAt: new Date().toISOString(), step: "starting" });
    try {
      const result = await render({ inDir: path.join(jobDir, "in"), outFile: path.join(jobDir, "out.mp4"), style, length,
        log: (m) => { console.log(`[${name}] ${m}`); update({ step: m.slice(0, 200) }); } });
      update({ status: "done", finishedAt: new Date().toISOString(), step: "finished", result });
    } catch (e) {
      console.error(`[${name}] failed: ${e.message}`);
      update({ status: "failed", finishedAt: new Date().toISOString(), error: e.message });
    } finally {
      waiting--;
    }
  };
  queue = queue.then(job, job);
  return position;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://autoedit");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    const version = (await run(FFMPEG, ["-hide_banner", "-version"])).split("\n")[0];
    return send(res, 200, { ok: true, ffmpeg: version, jobsWaiting: waiting });
  }
  if (parts[0] !== "jobs" || !parts[1]) return send(res, 404, { ok: false, error: "not found" });
  const jobDir = path.join(WORK, clean(parts[1]));
  const st = readStatus(jobDir);

  if (req.method === "POST" && parts.length === 2) { // reserve a fresh job (any old files of the same name are cleared)
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    fs.rmSync(jobDir, { recursive: true, force: true });
    saveStatus(jobDir, { job: path.basename(jobDir), status: "receiving", createdAt: new Date().toISOString() });
    return send(res, 201, { ok: true, job: path.basename(jobDir), status: "receiving" });
  }

  if (req.method === "PUT" && parts[2] === "files" && parts[3]) {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    const inDir = path.join(jobDir, "in");
    fs.mkdirSync(inDir, { recursive: true });
    const file = path.join(inDir, clean(parts[3]));
    await pipeline(req, fs.createWriteStream(file));
    return send(res, 200, { ok: true, file: path.basename(file), bytes: fs.statSync(file).size });
  }
  if (req.method === "POST" && parts[2] === "render") {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is already ${st.status}` });
    // A reserved job that can't start is marked failed, so whoever checks its status learns why.
    const refuse = (error) => {
      if (st) saveStatus(jobDir, { ...st, status: "failed", finishedAt: new Date().toISOString(), error });
      return send(res, 400, { ok: false, error });
    };
    const style = (url.searchParams.get("style") || "smooth").toLowerCase();
    if (!STYLE_NAMES.includes(style)) return refuse(`unknown style "${style}"`);
    const length = url.searchParams.has("length") ? Number(url.searchParams.get("length")) : undefined; // smart only
    if (length !== undefined && !(length >= 5 && length <= 180)) return refuse("length must be 5-180 seconds");
    if (!inFiles(jobDir)) return refuse("no files were uploaded");
    const ahead = startJob(jobDir, style, length);
    return send(res, 202, { ok: true, job: path.basename(jobDir), status: "queued", jobsAhead: ahead });
  }
  if (req.method === "GET" && parts[2] === "status") {
    if (!st) return send(res, 404, { ok: false, error: "no such job" });
    const since = st.startedAt || st.queuedAt || st.createdAt, until = st.finishedAt ? Date.parse(st.finishedAt) : Date.now();
    return send(res, 200, { ok: true, ...st, seconds: since ? Math.round((until - Date.parse(since)) / 1000) : 0, files: inFiles(jobDir) });
  }
  if (req.method === "GET" && parts[2] === "video") {
    const file = path.join(jobDir, "out.mp4");
    if (st?.status !== "done" || !fs.existsSync(file)) return send(res, 404, { ok: false, error: "no video yet" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size });
    return pipeline(fs.createReadStream(file), res);
  }
  if (req.method === "DELETE" && parts.length === 2) {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    fs.rmSync(jobDir, { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { ok: false, error: e.message });
    else res.destroy();
  }));
server.requestTimeout = 0; // big video uploads are normal here
server.listen(PORT, () => console.log(`autoedit listening on ${PORT}, work dir ${WORK}`));
