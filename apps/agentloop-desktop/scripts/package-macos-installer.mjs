import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const commands = { pgrep: '/usr/bin/pgrep', kill: '/bin/kill', sleep: '/bin/sleep', stat: '/usr/bin/stat', id: '/usr/bin/id', launchctl: '/bin/launchctl', sudo: '/usr/bin/sudo', open: '/usr/bin/open' };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const regex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Commands are injectable for isolated lifecycle tests, never from installer environment variables. */
export function macInstallerScripts(options, binaries = commands, applicationsDirectory = '/Applications') {
  const expectedName = options.channel === 'local' ? '玄武（本地）' : '玄武';
  if (!['local', 'production'].includes(options.channel) || options.productName !== expectedName) throw new Error('Invalid Desktop installer identity');
  const expectedId = options.channel === 'local' ? 'com.agentloop.desktop.local' : 'com.agentloop.desktop';
  const app = `${applicationsDirectory}/${options.productName}.app`;
  const legacy = `${applicationsDirectory}/${options.channel === 'local' ? 'AgentLoop Desktop Local' : 'AgentLoop Desktop'}.app`;
  const backend = `^${regex(app)}/Contents/Resources/runtime/bin/node( |$)`;
  const supervisor = `^${regex(app)}/Contents/Resources/runtime/bin/node .*module-supervisor\\.mjs( |$)`;
  const tray = `^${regex(app)}/Contents/MacOS/AgentLoop Desktop( |$)`;
  const oldBackend = `^${regex(legacy)}/Contents/Resources/runtime/bin/node( |$)`;
  const oldTray = `^${regex(legacy)}/Contents/MacOS/AgentLoop Desktop( |$)`;
  const q = Object.fromEntries(Object.entries(binaries).map(([name, path]) => [name, quote(path)]));
  const header = `#!/bin/sh
set -eu
# Installing onto another volume must not affect this Mac's running apps.
[ "\${3:-/}" = "/" ] || exit 0
readonly BACKEND_PATTERN=${quote(backend)}
readonly SUPERVISOR_PATTERN=${quote(supervisor)}
readonly TRAY_PATTERN=${quote(tray)}
readonly OLD_BACKEND_PATTERN=${quote(oldBackend)}
readonly OLD_TRAY_PATTERN=${quote(oldTray)}
readonly LEGACY_APP=${quote(legacy)}
readonly APP=${quote(app)}
readonly EXPECTED_ID=${quote(expectedId)}
check_identity() {
  target="$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -d "$target" ] && [ ! -L "$target" ] || { echo "Unexpected Desktop application path." >&2; return 1; }
    actual=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null) || return 1
    [ "$actual" = "$EXPECTED_ID" ] || { echo "Desktop application identifier mismatch." >&2; return 1; }
  fi
}
`;
  return {
    preinstall: `${header}
matching_pids() {
  if found=$(${q.pgrep} -f "$1"); then
    printf '%s\\n' "$found"
  else
    code=$?
    [ "$code" -eq 1 ] || { echo "Unable to inspect Desktop processes; installation aborted." >&2; return 1; }
  fi
}
stop_matching() {
  pids=$(matching_pids "$1") || return 1
  for pid in $pids; do ${q.kill} -TERM "$pid" 2>/dev/null || true; done
}
wait_stopped() {
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    pids=$(matching_pids "$1") || return 1
    [ -n "$pids" ] || return 0
    ${q.sleep} 1
  done
  return 1
}
# Ask the backend to close first. Active Runs may refuse shutdown; never kill
# the tray first (closing its pipe would force the backend to exit).
check_identity "$APP"
check_identity "$LEGACY_APP"
supervisors=$(matching_pids "$SUPERVISOR_PATTERN") || exit 1
if [ -n "$supervisors" ]; then
  # The supervisor asks its child to close, and refuses while Runs are active.
  stop_matching "$SUPERVISOR_PATTERN"
else
  stop_matching "$BACKEND_PATTERN"
fi
stop_matching "$OLD_BACKEND_PATTERN"
if ! wait_stopped "$BACKEND_PATTERN" || ! wait_stopped "$OLD_BACKEND_PATTERN"; then
  echo "Desktop is still busy. Finish or cancel tasks and quit from its tray before installing." >&2
  exit 1
fi
stop_matching "$TRAY_PATTERN"
stop_matching "$OLD_TRAY_PATTERN"
if ! wait_stopped "$TRAY_PATTERN" || ! wait_stopped "$OLD_TRAY_PATTERN"; then
  echo "Unable to stop Desktop tray; installation aborted." >&2
  exit 1
fi
# Refuse replacement if a user restarted the backend during shutdown.
pids=$(matching_pids "$BACKEND_PATTERN") || exit 1
[ -z "$pids" ] || { echo "Desktop restarted; installation aborted." >&2; exit 1; }
pids=$(matching_pids "$OLD_BACKEND_PATTERN") || exit 1
[ -z "$pids" ] || { echo "Old Desktop restarted; installation aborted." >&2; exit 1; }
# All user data lives outside the app bundle and is deliberately untouched.
`,
    postinstall: `${header}
check_identity "$LEGACY_APP"
CONSOLE_USER="$(${q.stat} -f '%Su' /dev/console 2>/dev/null || true)"
case "$CONSOLE_USER" in ''|root|loginwindow) exit 0 ;; esac
USER_UID="$(${q.id} -u "$CONSOLE_USER" 2>/dev/null || true)"
case "$USER_UID" in ''|*[!0-9]*) echo "Unable to identify the desktop login session." >&2; exit 1 ;; esac
# Run as the logged-in user; never initialize Runtime data as root.
if ! ${q.launchctl} asuser "$USER_UID" ${q.sudo} -H -u "$CONSOLE_USER" ${q.open} -a "$APP"; then
  echo "Unable to open the installed Desktop for the logged-in user." >&2
  exit 1
fi
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if ${q.pgrep} -u "$USER_UID" -f "$TRAY_PATTERN" >/dev/null 2>&1 && ${q.pgrep} -u "$USER_UID" -f "$BACKEND_PATTERN" >/dev/null 2>&1; then
    if [ -d "$LEGACY_APP" ]; then
      # Keep the old bundle for operator recovery; the backup name no longer
      # has an .app extension, so it will not appear as a second application.
      backup=$(/usr/bin/mktemp -d ${quote(`${applicationsDirectory}/.agentloop-desktop-legacy.XXXXXXXX`)})
      /bin/mv "$LEGACY_APP" "$backup/previous-app"
    fi
    exit 0
  fi
  ${q.sleep} 1
done
echo "Desktop did not start from /Applications. Quit any other copy of this channel, then open the installed app." >&2
exit 1
`,
    components: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>Applications/${options.productName}.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>\n`,
  };
}

export async function writeMacInstallerFiles(directory, options) {
  const scripts = join(directory, 'scripts'); await mkdir(scripts, { recursive: true });
  const generated = macInstallerScripts(options);
  for (const name of ['preinstall', 'postinstall']) await writeFile(join(scripts, name), generated[name], { mode: 0o755 });
  const components = join(directory, 'components.plist');
  await writeFile(components, generated.components);
  return { scripts, components };
}
