import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandArguments, taskEnvironment, TaskProcess, processGroupAlive, recoverProcessGroup } from '../../src/runner.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));

test('argument substitution treats values as literal arguments and rejects credential tokens', () => {
  assert.deepEqual(expandArguments(['--model={model}'], { model: 'abc; touch /tmp/never-run' }), ['--model=abc; touch /tmp/never-run']);
  assert.throws(() => expandArguments(['{apiKey}'], {}), /Unsupported/);
});

test('child environment contains only the current API credential', () => {
  const env = taskEnvironment({ taskId: 'id' }, 'current', { PATH: '/bin', DEEPSEEK_API_KEY: 'other', TOKEN: 'hidden', OPENAI_API_KEY: 'old' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, 'current');
  assert.equal(env.CRAFTER_TASK_ID, 'id');
});

test('termination escalates for an entire task process group before resolving', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crafter-runner-test-'));
  let pgid;
  const runner = new TaskProcess({ taskId: `test-${Date.now()}`, logger: { write() {} },
    terminationGraceMs: 100, onSpawn: (pid) => { pgid = pid; } });
  const execution = runner.run({ command: process.execPath, args: [fixture] }, { work: root });
  const failed = assert.rejects(execution, /test timeout/);
  try {
    let pid;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(path.join(root, 'descendant.pid'), 'utf8')); break; }
      catch { await wait(20); }
    }
    assert.ok(pid, 'descendant starts');
    await runner.stop('test timeout');
    await failed;
    assert.equal(await processGroupAlive(pgid), false);
    if (process.platform !== 'linux') assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await runner.stop('test cleanup'); await rm(root, { recursive: true, force: true }); }
});

test('recovery refuses invalid persisted process identifiers', async () => {
  assert.equal((await recoverProcessGroup('test', -1)).safe, false);
});
