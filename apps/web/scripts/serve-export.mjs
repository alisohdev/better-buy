import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  process.env.BETTER_BUY_EXPORT_DIR ?? "out"
);
const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
http
  .createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname
      );
      const file = path.resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`
      );
      if (!file.startsWith(path.resolve(root) + path.sep)) {
        response.writeHead(400).end();
        return;
      }
      const resolved =
        pathname === "/" ||
        (!path.extname(pathname) &&
          !/^\/(?:api|assets)(?:\/|$)|^\/healthz$/.test(pathname))
          ? path.join(root, "index.html")
          : file;
      const bytes = await readFile(resolved);
      response
        .writeHead(200, {
          "content-type":
            types[path.extname(resolved)] ?? "application/octet-stream",
        })
        .end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  })
  .listen(Number(process.env.PLAYWRIGHT_PORT ?? "3100"), "127.0.0.1");
