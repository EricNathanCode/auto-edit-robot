// Smart Editor's shot labels: shot size from the file name, product name and hands from the home vision AI on lab1
// (Ollama, same Docker network).
// Tested 2026-10-24 on 13 known keyboard frames: asked "how much of the product is in the frame?", qwen3-vl:4b got 9/13
// and qwen3-vl:8b 6/13 (it called almost everything "wide"), and both flip-flopped between near-identical frames. So
// the AI is NOT trusted with shot size; it reliably names the product (it even read the brand) and spots hands.
const http = require("http");
const https = require("https");
const { readFrames } = require("./smart");

// Settings are read on every call, so they can be changed per run (and in tests).
const ollama = () => process.env.OLLAMA_URL || "http://ollama:11434";
const MODEL = process.env.VISION_MODEL || "qwen3-vl:4b-instruct";
// One look takes ~4 s on a laptop GPU but ~4 min on the Dell's 4-core CPU, so allow 15 min per look.
const lookLimitMs = () => (Number(process.env.VISION_LOOK_LIMIT_MIN) || 15) * 60 * 1000;
const EVERY = 2; // seconds between looks in a clip
const MAX_LOOKS = 4; // per clip

// POST JSON with no time limit except ours. (Node's built-in fetch gives up by itself after 5 min without an answer,
// which a slow CPU can hit.)
function postJson(url, body, limitMs) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).request(url, { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
        res.on("error", reject);
      });
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${Math.round(limitMs / 1000)} s`)), limitMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// "01 wide desk.mp4" → wide. Words: wide, medium (mid), close / close-up, detail (macro); hands / typing = in use.
const TAGS = [[/\bwide\b/i, "wide"], [/\b(medium|mid)\b/i, "medium"], [/\bclose([- ]?up)?\b/i, "close-up"], [/\b(detail|macro)\b/i, "detail"]];
const tagSize = (name) => (TAGS.find(([re]) => re.test(name)) || [])[1] || null;
const tagHands = (name) => /\b(hands?|typing)\b/i.test(name);

const SCHEMA = {
  type: "object",
  properties: { product: { type: "string" }, hands: { type: "boolean" } },
  required: ["product", "hands"],
};
const PROMPT = `Look at this frame from a phone video of a tech gadget on a desk.
product: name the gadget in 1-4 words. If you can read a brand name on it, start with the brand; if not, just say what it is (like "mechanical keyboard"). Never write "unknown".
hands: are any hands visible? Answer only with JSON.`;

async function ask(png) {
  const r = await postJson(`${ollama()}/api/chat`, { model: MODEL, stream: false, format: SCHEMA, think: false, options: { temperature: 0 },
    messages: [{ role: "user", content: PROMPT, images: [png.toString("base64")] }] }, lookLimitMs());
  if (r.status !== 200) throw new Error(`vision AI said ${r.status}: ${r.text.slice(0, 200)}`);
  const a = JSON.parse(JSON.parse(r.text).message.content);
  return { product: String(a.product || "").slice(0, 40), hands: !!a.hands };
}

// Why the vision AI can't help right now ("" = it can).
async function visionProblem() {
  try {
    const r = await fetch(`${ollama()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const models = (await r.json()).models || [];
    return models.some((m) => m.name === MODEL) ? "" : `vision AI is missing the model ${MODEL} (run: ollama pull ${MODEL})`;
  } catch {
    return `vision AI not reachable at ${ollama()}: no product names or hand spotting`;
  }
}

// Adds item.labels = [{ t, size, product, hands }] (size from the file name tag, or null). Returns a note when the
// vision AI couldn't help; the tags work either way.
async function labelShots(ffmpeg, items, log = () => {}) {
  const problem = await visionProblem();
  for (const it of items) {
    const size = tagSize(it.name), handsTag = tagHands(it.name);
    const d = it.kind === "photo" ? 0 : it.info.duration;
    it.labels = [];
    if (problem) {
      if (size || handsTag) it.labels.push({ t: d / 2, size, product: "", hands: handsTag });
      continue;
    }
    const times = it.kind === "photo" ? [0] : [];
    for (let t = Math.min(0.5, d / 2); it.kind !== "photo" && t < d && times.length < MAX_LOOKS; t += EVERY) times.push(+t.toFixed(1));
    for (const t of times) {
      try {
        const png = await readFrames(ffmpeg, ["-v", "error", ...(it.kind === "photo" ? [] : ["-ss", String(t)]), "-i", it.file,
          "-frames:v", "1", "-vf", "scale=-2:448", "-f", "image2pipe", "-vcodec", "png", "-"]);
        const seen = await ask(png);
        it.labels.push({ t, size, product: seen.product, hands: seen.hands || handsTag });
        log(`vision ${it.name} @${t}s: ${seen.product}${seen.hands ? ", hands" : ""}${size ? ` (tagged ${size})` : ""}`);
      } catch (e) {
        log(`vision ${it.name} @${t}s failed: ${e.message}`);
        if (size || handsTag) it.labels.push({ t, size, product: "", hands: handsTag });
      }
    }
  }
  return problem;
}

// The best single name for the product across all looks: the most common one, preferring names with a brand.
function productName(items) {
  const counts = {};
  for (const l of items.flatMap((it) => it.labels || [])) {
    const n = l.product.trim();
    if (n && !/unknown/i.test(n)) counts[n] = (counts[n] || 0) + 1;
  }
  const generic = /^(mechanical |gaming |wireless )*(keyboard|mouse|earbuds|headphones|microphone|webcam|camera|gadget)s?$/i;
  return Object.keys(counts).sort((a, b) => generic.test(a) - generic.test(b) || counts[b] - counts[a] || b.length - a.length)[0] || "";
}

module.exports = { labelShots, productName, tagSize, tagHands, MODEL };
