import { loadConfig } from '../src/config.js';
import { checkIntegration } from '../src/integration.js';

const config = await loadConfig();
if (!config.ptc) {
  console.error('Configure the ptc profile in config/server.json first. See config/ptc.example.json.');
  process.exitCode = 1;
} else {
  await checkIntegration(config);
  console.log(JSON.stringify(config.integrationStatus, null, 2));
  process.exitCode = config.integrationStatus.ready ? 0 : 1;
}
