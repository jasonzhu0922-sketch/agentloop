import { open, realpath } from "node:fs/promises";
import { resolve, sep, basename } from "node:path";

export async function serveInstaller(request, response, pathname, directory) {
  const finish = (status, message) => { response.statusCode = status; response.end(message); };
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD"); return finish(405, "Method not allowed");
  }
  if (!directory) return finish(404, "Installer not published");
  let file;
  try {
    const relative = decodeURIComponent(pathname.slice("/downloads/local-agent/".length));
    if (!/^[a-zA-Z0-9_./-]+\.(pkg|msi)$/.test(relative) || relative.split("/").some(part => part === "" || part === "." || part === "..")) return finish(404, "Not found");
    const root = await realpath(directory);
    const target = await realpath(resolve(root, relative));
    if (!target.startsWith(root + sep)) return finish(404, "Not found");
    file = await open(target, "r");
    const info = await file.stat();
    if (!info.isFile()) { await file.close(); return finish(404, "Not found"); }
    let start = 0;
    let end = info.size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) { await file.close(); response.setHeader("content-range", `bytes */${info.size}`); return finish(416, "Invalid range"); }
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) { await file.close(); response.setHeader("content-range", `bytes */${info.size}`); return finish(416, "Invalid range"); }
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end}/${info.size}`);
    } else response.statusCode = 200;
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", `attachment; filename="${basename(target)}"`);
    response.setHeader("content-length", end - start + 1);
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    if (request.method === "HEAD") { await file.close(); response.end(); return; }
    const stream = file.createReadStream({ start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch {
    await file?.close().catch(() => {});
    if (response.headersSent) response.destroy();
    else finish(404, "Installer not published");
  }
}
