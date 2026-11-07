import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktop } from './dist/application.js';
import { CloudAccountAuth } from './dist/auth/cloud-auth.js';
import { packagedToolEnvironment, verifyPackagedPython } from './packaged-tools.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'desktop-config.json'), 'utf8'));
function notify(message) { process.stdout.write(`AGENTLOOP_DESKTOP:${JSON.stringify(message)}\n`); }
let desktop;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    if (desktop && !desktop.existing) await desktop.close();
    notify({ type: 'closed' });
    process.exit(0);
  } catch {
    closing = false;
    notify({ type: 'close-refused' });
  }
}
const commands = createInterface({ input: process.stdin });
commands.on('line', line => { if (line === 'close') void shutdown(); });
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
// A closed tray must not leave an invisible Runtime process behind.
commands.on('close', () => {
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  void shutdown();
});
try {
  if (!process.env.AGENTLOOP_DESKTOP_DATA_DIR) throw new Error('desktop_data_directory_required');
  const computerCommandEnvironment = await packagedToolEnvironment(root, config);
  await verifyPackagedPython(root, config, computerCommandEnvironment);
  Object.assign(process.env, computerCommandEnvironment);
  desktop = await startDesktop({
    computerCommandEnvironment,
    mode: 'packaged', dataDirectory: process.env.AGENTLOOP_DESKTOP_DATA_DIR,
    runtimeTurnDefaults: { ...config.turnDefaults, webSearch: config.searchDefaults },
    webDirectory: join(root, 'web'), openBrowser: false,
    cloudAuth: new CloudAccountAuth(config.accountServiceUrl),
    connectorModules: [
      ['@zhujun/connector-feishu', 'feishuConnector'],
      ['@zhujun/connector-126-mail', 'createConfigured126MailConnector'],
      ['@zhujun/connector-wps', 'createConfiguredWpsConnector'],
    ].map(([name, exportName]) => ({ modulePath: fileURLToPath(import.meta.resolve(name)), exportName })),
  });
  if (desktop.existing) throw new Error('desktop_backend_already_owned');
  notify({ type: 'ready', origin: desktop.origin });
} catch {
  notify({ type: 'startup-error' });
  console.error('Desktop backend initialization failed.');
  process.exit(1);
}
