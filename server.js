// Auto Edit Robot API (no open port: only n8n on the Docker network "ai" can reach it at http://autoedit:8090).
//   GET    /health                       → { ok, ffmpeg }
//   PUT    /jobs/<job>/files/<name>      → raw file body, saved to <job>/in/<name>
//   POST   /jobs/<job>/render?style=...  → makes <job>/out.mp4 (smooth | punchy | beat | hype | soft), returns a summary
//   GET    /jobs/<job>/video             → the finished MP4
//   DELETE /jobs/<job>                   → removes the job's files
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

let queue = Promise.resolve(); // one render at a time (the Dell has 4 cores)

async function handle(req, res) {
  const url = new URL(req.url, "http://autoedit");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    const version = (await run(FFMPEG, ["-hide_banner", "-version"])).split("\n")[0];
    return send(res, 200, { ok: true, ffmpeg: version });
  }
  if (parts[0] !== "jobs" || !parts[1]) return send(res, 404, { ok: false, error: "not found" });
  const jobDir = path.join(WORK, clean(parts[1]));

  if (req.method === "PUT" && parts[2] === "files" && parts[3]) {
    const inDir = path.join(jobDir, "in");
    fs.mkdirSync(inDir, { recursive: true });
    const file = path.join(inDir, clean(parts[3]));
    await pipeline(req, fs.createWriteStream(file));
    return send(res, 200, { ok: true, file: path.basename(file), bytes: fs.statSync(file).size });
  }
  if (req.method === "POST" && parts[2] === "render") {
    const style = (url.searchParams.get("style") || "smooth").toLowerCase();
    if (!STYLE_NAMES.includes(style)) return send(res, 400, { ok: false, error: `unknown style "${style}"` });
    const length = url.searchParams.has("length") ? Number(url.searchParams.get("length")) : undefined; // smart only
    if (length !== undefined && !(length >= 5 && length <= 180)) return send(res, 400, { ok: false, error: "length must be 5-180 seconds" });
    const job = () => render({ inDir: path.join(jobDir, "in"), outFile: path.join(jobDir, "out.mp4"), style, length,
      log: (m) => console.log(`[${path.basename(jobDir)}] ${m}`) });
    const result = queue.then(job, job);
    queue = result.catch(() => {});
    return send(res, 200, await result);
  }
  if (req.method === "GET" && parts[2] === "video") {
    const file = path.join(jobDir, "out.mp4");
    if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: "no video yet" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size });
    return pipeline(fs.createReadStream(file), res);
  }
  if (req.method === "DELETE" && parts.length === 2) {
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
server.requestTimeout = 0; // big video uploads and long renders are normal here
server.listen(PORT, () => console.log(`autoedit listening on ${PORT}, work dir ${WORK}`));
