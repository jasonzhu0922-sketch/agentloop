import { readFile } from "node:fs/promises";
import type { LocalAgentRelease } from "../api/router-api.ts";

export function validLocalAgentDownloadUrl(value: string): boolean {
  if (value.startsWith("/downloads/local-agent/")) {
    const path = value.slice("/downloads/local-agent/".length);
    return /^[a-zA-Z0-9_./-]+\.(pkg|msi)$/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  }
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

export function parseLocalAgentReleases(value: string): readonly LocalAgentRelease[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Local Agent releases must be a JSON array");
  const identities = new Set<string>();
  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid Local Agent release at ${index}`);
    const release = item as Record<string, unknown>;
    const required = (name: string): string => {
      const field = release[name];
      if (typeof field !== "string" || field.trim() === "") throw new Error(`Local Agent release ${index}: ${name} is required`);
      return field.trim();
    };
    const platform = required("platform");
    const arch = required("arch");
    if (platform !== "darwin" && platform !== "windows") throw new Error(`Invalid release platform: ${platform}`);
    if (arch !== "arm64" && arch !== "x64") throw new Error(`Invalid release architecture: ${arch}`);
    const version = required("version");
    const protocolVersion = required("protocolVersion");
    const identity = `${platform}/${arch}/${version}/${protocolVersion}`;
    if (identities.has(identity)) throw new Error(`Duplicate Local Agent release: ${identity}`);
    identities.add(identity);
    const downloadUrl = required("downloadUrl");
    if (!validLocalAgentDownloadUrl(downloadUrl)) throw new Error("Download URL must use HTTPS or a /downloads/local-agent/ installer path");
    const sha256 = required("sha256");
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Invalid release SHA-256");
    const fileName = required("fileName");
    if (!/^[a-zA-Z0-9_.-]+\.(pkg|msi)$/.test(fileName) || (platform === "darwin" && !fileName.endsWith(".pkg")) || (platform === "windows" && !fileName.endsWith(".msi"))) throw new Error("Invalid installer file name");
    const size = release.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error("Release size must be a positive byte count");
    const publishedAt = required("publishedAt");
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) throw new Error("Invalid release publish date");
    return {
      platform, arch, version, protocolVersion, downloadUrl, sha256, fileName, size, publishedAt,
      signature: required("signature"),
      ...(typeof release.releaseNotes === "string" ? { releaseNotes: release.releaseNotes } : {}),
      ...(typeof release.launchUrl === "string" ? { launchUrl: release.launchUrl } : {}),
    };
  });
}

/** Re-read the mounted catalog so publishing an installer never requires an image build. */
export function localAgentReleaseSource(environment: Readonly<Record<string, string | undefined>>): () => Promise<readonly LocalAgentRelease[]> {
  const file = environment.LOCAL_AGENT_RELEASES_FILE;
  const inline = environment.LOCAL_AGENT_RELEASES_JSON;
  if (file && inline?.trim()) throw new Error("Set only one of LOCAL_AGENT_RELEASES_FILE and LOCAL_AGENT_RELEASES_JSON");
  const fixed = file ? undefined : parseLocalAgentReleases(inline?.trim() || "[]");
  return async () => file ? parseLocalAgentReleases(await readFile(file, "utf8")) : fixed!;
}

export function orderedLocalAgentReleases(releases: readonly LocalAgentRelease[]): Array<LocalAgentRelease & { readonly isLatest: boolean }> {
  const seen = new Set<string>();
  return [...releases].sort((a, b) => Date.parse(b.publishedAt ?? "1970-01-01") - Date.parse(a.publishedAt ?? "1970-01-01") || b.version.localeCompare(a.version, "en", { numeric: true }) || a.downloadUrl.localeCompare(b.downloadUrl)).map((release) => {
    const key = `${release.platform}/${release.arch}/${release.protocolVersion}`;
    const isLatest = !seen.has(key);
    seen.add(key);
    return { ...release, isLatest };
  });
}
