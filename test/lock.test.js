import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';

test('concurrent starts reclaiming a dead-owner lock permit exactly one scheduler', { timeout: 10000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'crafter-lock-race-'));
  let winners = [];
  try {
    const stalePid = 2147483647;
    assert.throws(() => process.kill(stalePid, 0), (error) => error.code === 'ESRCH');
    await writeFile(join(dataDir, 'server.lock'), JSON.stringify({ pid: stalePid, token: 'dead-server-fixture' }));
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => startServer({
      config: { dataDir, port: 0, minFreeBytes: 0 }
    })));
    winners = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    assert.equal(winners.length, 1, `only one server may own the shared task directory: ${results.filter((result) => result.status === 'rejected').map((result) => result.reason.message).join(' | ')}`);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 11);
  } finally {
    await Promise.all(winners.map((app) => app.close()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
