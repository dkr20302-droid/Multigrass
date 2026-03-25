const fs = require("fs");
const path = require("path");

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

function safePathJoin(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.resolve(rootDir, "." + normalized);
}

function createStaticHandler(rootDir) {
  const rootResolved = path.resolve(rootDir);
  return (req, res) => {
    const urlPath = req.url === "/" ? "/index.html" : req.url;
    const filePath = safePathJoin(rootDir, urlPath);

    // Ensure the resolved path stays within the static root (Windows-safe).
    if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME.get(ext) || "application/octet-stream",
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=600"
      });
      fs.createReadStream(filePath).pipe(res);
    });
  };
}

module.exports = { createStaticHandler };
