import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startDesktop } from "../../src/application.ts";
const directory = process.argv[2]!; const skills = join(directory, "skills"); await mkdir(skills, { recursive: true });
try {
  const app = await startDesktop({ mode: "development", dataDirectory: join(directory, "desktop-data"), openBrowser: false, bundledSkillDirectories: [skills],
    models: { modelKeys: () => [], create() { throw new Error("no_test_provider"); } } });
  process.send?.({ existing: app.existing, origin: app.origin });
  if (app.existing) process.disconnect?.();
  else process.on("message", message => {
    if (message === "close") void app.close().then(() => process.disconnect?.());
  });
} catch { process.exitCode = 1; process.disconnect?.(); }
