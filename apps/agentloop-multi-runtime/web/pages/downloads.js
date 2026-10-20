import { detectInstallerDevice, installerGroups, recommendedInstaller, safeInstallerUrl, LOCAL_AGENT_PROTOCOL } from "/client/local-runtime/release-selection.js";

const $ = id => document.getElementById(id);
let releases = [];
let device = { platform: "unknown", arch: "unknown" };
let selected;
let loaded = false;
const key = release => `${release.platform}/${release.arch}/${release.version}/${release.protocolVersion}`;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const filters = () => ({ platform: $("platform-filter").value, arch: $("arch-filter").value });
const date = value => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)) : "日期未提供";
const size = value => value ? `${(value / 1024 / 1024).toFixed(1)} MB` : "大小未提供";

for (const id of ["platform-filter", "arch-filter"]) $(id).addEventListener("change", render);
$("retry").addEventListener("click", () => void load());
void load();
void detectInstallerDevice().then(result => { device = result; describeDevice(); render(); });

function describeDevice() {
  const os = { darwin: "macOS", windows: "Windows" }[device.platform];
  const arch = device.platform === "darwin" ? { arm64: "Apple Silicon", x64: "Intel" }[device.arch] : { arm64: "ARM64", x64: "x64" }[device.arch];
  const available = releases.some(release => recommendedInstaller(release, device));
  $("device-hint").textContent = os ? arch ? `检测到 ${os} · ${arch}。${loaded && !available ? "暂未发布匹配的安装包，你仍可为其他设备下载。" : "匹配的安装包会标记推荐，你也可以选择其他版本。"}` : `检测到 ${os}，请确认芯片类型后选择。你也可以为其他设备下载。` : "请选择目标电脑的系统与架构。你可以自由下载已发布的安装包。";
}

async function load() {
  $("catalog-message").className = "catalog-message";
  $("catalog-message").textContent = "正在获取安装包…";
  $("retry").hidden = true;
  try {
    const api = String(globalThis.AGENTLOOP_ROUTER_URL || "/api").replace(/\/+$/, "");
    const response = await fetch(`${api}/v1/local-agent/releases`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.releases)) throw new Error("catalog unavailable");
    releases = body.releases;
    loaded = true;
    $("catalog-message").textContent = releases.some(release => release.isLatest && release.protocolVersion === LOCAL_AGENT_PROTOCOL) ? "" : "当前暂无可用的最新安装包，发布后会在这里提供。";
    render();
  } catch {
    loaded = false;
    $("installer-grid").replaceChildren();
    $("history").hidden = true;
    $("catalog-message").classList.add("error");
    $("catalog-message").textContent = "暂时无法获取安装包列表，请稍后重试。";
    $("retry").hidden = false;
  }
}

function render() {
  if (!loaded) return;
  describeDevice();
  const groups = installerGroups(releases, filters());
  const grid = $("installer-grid");
  grid.replaceChildren();
  for (const group of groups) {
    const release = group.current;
    const card = el("article", "installer-card");
    card.dataset.platform = group.platform;
    card.dataset.arch = group.arch;
    card.classList.toggle("recommended", Boolean(release && recommendedInstaller(release, device)));
    card.classList.toggle("selected", Boolean(release && selected === key(release)));
    const heading = el("div", "card-heading");
    heading.append(el("h3", "", group.title));
    if (release && recommendedInstaller(release, device)) heading.append(el("span", "badge", "推荐此设备使用"));
    else if (device.platform === group.platform && device.arch === "unknown") heading.append(el("span", "badge", "当前系统 · 请确认架构"));
    const intro = el("div");
    intro.append(heading, el("p", "architecture", group.architecture), el("p", "description", group.description));
    card.append(intro);
    const meta = el("div", "release-meta");
    const actions = el("div", "card-actions");
    if (release) {
      meta.append(el("span", "version", `v${release.version}`), el("span", "", size(release.size)), el("span", "", date(release.publishedAt)));
      actions.append(downloadLink(release, `下载 ${group.extension || "安装包"}`));
      const label = el("label", "select-installer");
      const radio = el("input"); radio.type = "radio"; radio.name = "installer"; radio.checked = selected === key(release);
      radio.setAttribute("aria-label", `选择 ${group.title} ${group.architecture} v${release.version}`);
      radio.addEventListener("change", () => {
        selected = key(release);
        // Update selection without replacing focused controls or open details.
        for (const node of grid.children) node.classList.toggle("selected", node === card);
        for (const input of grid.querySelectorAll(".select-installer input")) input.nextSibling.textContent = input.checked ? "已选择" : "选择此版本";
      });
      label.append(radio, el("span", "", radio.checked ? "已选择" : "选择此版本"));
      actions.append(label);
    } else {
      meta.append(el("span", "unpublished", "暂未发布"));
      const button = el("button", "download-button", "暂未提供"); button.disabled = true; actions.append(button);
    }
    card.append(meta, actions);
    if (release) card.append(releaseDetails(release));
    grid.append(card);
  }
  if (!groups.length) grid.append(el("p", "muted", "没有匹配的安装包，请调整筛选条件。"));
  const history = groups.flatMap(group => group.history.map(release => ({ group, release })));
  $("history").hidden = history.length === 0;
  $("history-count").textContent = `${history.length} 个`;
  $("history-list").replaceChildren();
  for (const { group, release } of history) {
    const row = el("div", "history-row");
    const copy = el("div");
    copy.append(el("strong", "", `${group.title} · ${group.architecture} · v${release.version}`), el("p", "", `${date(release.publishedAt)} · ${size(release.size)}${release.protocolVersion !== LOCAL_AGENT_PROTOCOL ? " · 与当前工作区协议不兼容" : ""}`), releaseDetails(release));
    row.append(copy, downloadLink(release, "下载"));
    $("history-list").append(row);
  }
}

function downloadLink(release, text) {
  const url = safeInstallerUrl(release.downloadUrl, location.origin);
  if (!url) { const button = el("button", "download-button", "下载地址不可用"); button.disabled = true; return button; }
  const link = el("a", "download-button", text);
  link.href = url; link.download = release.fileName || "";
  if (new URL(url).origin !== location.origin) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  link.setAttribute("aria-label", `${text} ${release.platform} ${release.arch} v${release.version}`);
  return link;
}

function releaseDetails(release) {
  const details = el("details", "release-details");
  details.append(el("summary", "", "校验信息与更新说明"));
  const list = el("dl");
  for (const [label, value] of [["签名状态", release.signature], ["SHA-256", release.sha256], ["文件名", release.fileName]]) {
    const content = el("dd"); content.append(el(label === "SHA-256" ? "code" : "span", "", value || "未提供"));
    list.append(el("dt", "", label), content);
  }
  details.append(list);
  if (release.releaseNotes) details.append(el("p", "release-notes", release.releaseNotes));
  return details;
}
