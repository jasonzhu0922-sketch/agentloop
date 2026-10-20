export const LOCAL_AGENT_PROTOCOL: string;
export interface InstallerRelease {
  platform: string;
  arch: string;
  protocolVersion: string;
  isLatest?: boolean;
  version?: string;
  downloadUrl?: string;
}
export interface InstallerTarget {
  platform: string;
  arch: string;
  title: string;
  architecture: string;
  description: string;
  extension?: string;
}
export const INSTALLER_TARGETS: InstallerTarget[];
export interface InstallerDevice { platform: string; arch: string }
export function detectInstallerDevice(browser?: {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }> };
}): Promise<InstallerDevice>;
export function recommendedInstaller(release: InstallerRelease, device: InstallerDevice): boolean;
export function installerGroups<T extends InstallerRelease>(releases: T[], filters?: { platform: string; arch: string }): Array<InstallerTarget & { current?: T; history: T[] }>;
export function safeInstallerUrl(value: unknown, origin: string): string | undefined;
