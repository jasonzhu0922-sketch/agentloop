export const LOCAL_AGENT_PROTOCOL = "1";
export const INSTALLER_TARGETS = [
  { platform: "darwin", arch: "arm64", title: "macOS", architecture: "Apple Silicon", description: "适用于 M 系列芯片的 Mac", extension: ".pkg" },
  { platform: "darwin", arch: "x64", title: "macOS", architecture: "Intel", description: "适用于 Intel 芯片的 Mac", extension: ".pkg" },
  { platform: "windows", arch: "x64", title: "Windows", architecture: "x64", description: "适用于 64 位 Intel / AMD 电脑", extension: ".msi" },
  { platform: "windows", arch: "arm64", title: "Windows", architecture: "ARM64", description: "适用于 ARM 架构的 Windows 电脑", extension: ".msi" },
];

export async function detectInstallerDevice(browser = navigator) {
  const ua = browser.userAgent || "";
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && browser.maxTouchPoints > 1);
  const os = browser.userAgentData?.platform || ua;
  const platform = mobile ? "unsupported" : /Windows/i.test(os) ? "windows" : /Mac/i.test(os) ? "darwin" : "unknown";
  let hints = {};
  if (!mobile && typeof browser.userAgentData?.getHighEntropyValues === "function") {
    let timer;
    try {
      hints = await Promise.race([
        browser.userAgentData.getHighEntropyValues(["architecture", "bitness"]),
        new Promise(resolve => { timer = setTimeout(() => resolve({}), 1500); }),
      ]);
    } catch { /* Browsers may decline architecture hints. Keep it unknown. */ }
    finally { clearTimeout(timer); }
  }
  const architecture = String(hints.architecture || "").toLowerCase();
  const arch = /arm/.test(architecture) && hints.bitness === "64" ? "arm64"
    : /x86|x64/.test(architecture) && hints.bitness === "64" ? "x64" : "unknown";
  return { platform, arch };
}

export function recommendedInstaller(release, device) {
  return release.isLatest === true && release.protocolVersion === LOCAL_AGENT_PROTOCOL && release.platform === device.platform && release.arch === device.arch && device.arch !== "unknown";
}

export function installerGroups(releases, filters = { platform: "all", arch: "all" }) {
  const extra = releases.filter(release => !INSTALLER_TARGETS.some(target => target.platform === release.platform && target.arch === release.arch)).map(release => ({ platform: release.platform, arch: release.arch, title: release.platform, architecture: release.arch, description: "请确认目标设备的系统与架构" }));
  const targets = [...INSTALLER_TARGETS, ...extra].filter((target, index, all) => all.findIndex(other => other.platform === target.platform && other.arch === target.arch) === index);
  return targets.filter(target => (filters.platform === "all" || filters.platform === target.platform) && (filters.arch === "all" || filters.arch === target.arch)).map(target => {
    const matching = releases.filter(release => release.platform === target.platform && release.arch === target.arch);
    return { ...target, current: matching.find(release => release.isLatest && release.protocolVersion === LOCAL_AGENT_PROTOCOL), history: matching.filter(release => !(release.isLatest && release.protocolVersion === LOCAL_AGENT_PROTOCOL)) };
  });
}

export function safeInstallerUrl(value, origin, basePath = "") {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/downloads/local-agent/") && !/[?#%\\]/.test(value) && value.split("/").every(part => part !== "." && part !== "..")) {
    const url = new URL(`${String(basePath).replace(/\/+$/, "")}${value}`, origin);
    if (url.origin === origin && /\.(pkg|msi)$/.test(url.pathname)) return url.href;
  }
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password) return url.href; } catch {}
  return undefined;
}
