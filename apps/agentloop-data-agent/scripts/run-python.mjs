import { spawnSync } from 'node:child_process';

const executable = process.env.DATA_AGENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error) {
  console.error(`Unable to start Python: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
