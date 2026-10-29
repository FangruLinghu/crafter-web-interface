import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
  stdio: 'ignore', env: process.env
});
await writeFile(path.join(process.env.CRAFTER_WORK, 'descendant.pid'), String(child.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
