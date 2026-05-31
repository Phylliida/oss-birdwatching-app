// Tiny static file server for local development. Serves the `web/` directory
// at http://localhost:8000. No dependencies.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 8000);
const DIR = "web";
// Extra mounts: paths under these keys are served from the corresponding
// directory outside web/. Used to expose data/audio and data/images without
// duplicating those large folders into web/.
const MOUNTS = {
  "/audio/": "data/audio",
  "/images/": "data/images",
  "/sonograms/": "data/sonograms",
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
};

function resolvePath(urlPath) {
  // Strip query/fragment already done by caller. Path-traversal-safe join.
  for (const [prefix, dir] of Object.entries(MOUNTS)) {
    if (urlPath.startsWith(prefix)) {
      const rel = normalize(urlPath.slice(prefix.length)).replace(/^([/\\])+/, "");
      return join(dir, rel);
    }
  }
  // Directory URLs (ending in /) resolve to that directory's index.html so
  // the sub-app at /conifers/ works without the user typing index.html.
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const rel = normalize(urlPath).replace(/^([/\\])+/, "");
  return join(DIR, rel);
}

createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const fp = resolvePath(p);
  try {
    const data = await readFile(fp);
    res.writeHead(200, { "Content-Type": MIME[extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`Serving ${DIR}/ at http://localhost:${PORT} (mounts: ${Object.keys(MOUNTS).join(", ")})`);
});
