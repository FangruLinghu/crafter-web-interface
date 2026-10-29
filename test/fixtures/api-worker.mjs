// Offline acceptance fixture. It never queries a model or implements a paper.
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const paper = await readFile(process.env.CRAFTER_INPUT, 'latin1');
if (paper.includes('HANG_FIXTURE')) {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { env: process.env, stdio: 'ignore' });
  await writeFile(join(process.env.CRAFTER_WORK, 'descendant.pid'), String(child.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const key = process.env.CRAFTER_API_KEY || '';
  console.log('[FIXTURE] Offline acceptance run.');
  if (key) { process.stdout.write(key.slice(0, 7)); await new Promise(r => setTimeout(r, 10)); process.stdout.write(`${key.slice(7)}\n`); }
  if (paper.includes('LOG_FIXTURE')) console.log('retained bounded log entry\n'.repeat(2000));
  await new Promise(r => setTimeout(r, 100));
  await writeFile(join(process.env.CRAFTER_OUTPUT, 'main.py'), `# OFFLINE ACCEPTANCE FIXTURE\nprint('fixture')\n# ${key}\n`);
  await writeFile(join(process.env.CRAFTER_OUTPUT, '.env'), `API_KEY=${key}`);
  await writeFile(join(process.env.CRAFTER_WORK, 'internal.txt'), 'private preprocessing artifact');
  if (key) await writeFile(join(process.env.CRAFTER_OUTPUT, 'unsafe.bin'), Buffer.from(`\0${key}\0`));
  await symlink(process.env.CRAFTER_INPUT, join(process.env.CRAFTER_OUTPUT, 'outside.pdf'));
  if (paper.includes('STORAGE_FIXTURE')) await writeFile(join(process.env.CRAFTER_WORK, 'large.bin'), Buffer.alloc(65536));
  if (paper.includes('FAIL_FIXTURE')) { console.error('[FIXTURE] Requested failure.'); process.exitCode = 2; }
}
