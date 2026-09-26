import { spawnSync } from "node:child_process";

const failures = [];
if (process.platform !== "win32" || process.arch !== "x64") {
  failures.push(`Windows MSI must be built on Windows x64; current host is ${process.platform}/${process.arch}.`);
}
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 26) failures.push(`Node 26 or newer is required; current Node is ${process.versions.node}.`);
if (process.platform === "win32") {
  if (!available("dotnet")) failures.push(".NET 8 SDK is required. Install it from https://dotnet.microsoft.com/download/dotnet/8.0.");
  else if (!dotnet8Available()) failures.push(".NET 8 SDK is required; install an 8.x SDK from https://dotnet.microsoft.com/download/dotnet/8.0.");
  if (!available("wix")) failures.push("WiX Toolset v4 CLI is required. Install it with: dotnet tool install --global wix --version 4.*");
}
if (failures.length > 0) {
  process.stderr.write(["Cannot package AgentLoop Local Runtime for Windows:", ...failures.map((failure) => `- ${failure}`), "Run npm run package:local-agent:win on a configured Windows x64 build runner."].join("\n") + "\n");
  process.exitCode = 1;
}

function available(command) {
  return spawnSync("where", [command], { stdio: "ignore" }).status === 0;
}

function dotnet8Available() {
  const result = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" });
  return result.status === 0 && /(?:^|\n)8\./.test(result.stdout);
}
