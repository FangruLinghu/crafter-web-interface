import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamArchive } from '../src/archive.js';

class DisconnectingResponse extends EventEmitter {
  constructor(triggerWrite = 1, event = 'close') {
    super();
    this.destroyed = false;
    this.writes = 0;
    this.triggerWrite = triggerWrite;
    this.event = event;
  }
  writeHead() {}
  write() {
    if (++this.writes !== this.triggerWrite) return true;
    setImmediate(() => {
      this.destroyed = true;
      this.emit(this.event, ...(this.event === 'error' ? [new Error('Fixture socket error')] : []));
    });
    return false;
  }
  end() { this.ended = true; }
}

test('streaming ZIP rejects on disconnect while a header is backpressured', { timeout: 1000 }, async () => {
  const res = new DisconnectingResponse();
  await assert.rejects(streamArchive(res, { outputPath: async () => '/never-opened' }, 'fixture', [{ path: 'main.py', size: 1 }]), /disconnected/);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
});

test('streaming ZIP rejects on socket error while backpressured', { timeout: 1000 }, async () => {
  const res = new DisconnectingResponse(1, 'error');
  await assert.rejects(streamArchive(res, { outputPath: async () => '/never-opened' }, 'fixture', [{ path: 'main.py', size: 1 }]), /Fixture socket error/);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
});

test('streaming ZIP closes an open source when a body write disconnects', { timeout: 2000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crafter-zip-close-'));
  try {
    const file = join(directory, 'result.txt');
    const size = 131072;
    await writeFile(file, Buffer.alloc(size, 65));
    const res = new DisconnectingResponse(3);
    await assert.rejects(streamArchive(res, { outputPath: async () => file }, 'fixture', [{ path: 'result.txt', size }]), /disconnected/);
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('error'), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
