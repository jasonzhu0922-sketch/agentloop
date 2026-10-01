import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/app/main.ts")],
  bundle: true,
  format: "esm",
  outfile: resolve(output, "app.js"),
});
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "styles.css"), resolve(output, "styles.css"));
