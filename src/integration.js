import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taskEnvironment } from './runner.js';

const execute = promisify(execFile);

export async function checkIntegration(config) {
  if (!config.ptc) return;
  const check = config.integrationCheck;
  try {
    const { stdout } = await execute(check.command, check.args, {
      cwd: check.cwd, env: { ...taskEnvironment({}), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      maxBuffer: 65536, timeout: 30000,
    });
    const result = JSON.parse(stdout.trim());
    if (!result.ready) throw new Error('The adapter reported missing dependencies or an incompatible entry point.');
    if (result.dependencies?.mineru !== true || result.capabilities?.mineru !== true || result.parser !== 'mineru') throw new Error('The adapter must provide installed MinerU preprocessing without a fallback parser.');
    config.integrationStatus = { ready: true, details: result };
  } catch {
    config.integrationStatus = { ready: false, message: 'Crafter could not be loaded. Check the repository path and its conda environment, then restart the server. See the integration check command in the README.' };
  }
}
