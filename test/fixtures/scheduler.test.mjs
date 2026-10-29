import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../../src/store.js';
import { TaskFiles } from '../../src/files.js';
import { Scheduler } from '../../src/scheduler.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtures = fileURLToPath(new URL('.', import.meta.url));

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'crafter-scheduler-test-'));
  const config = { dataDir, taskTimeoutMs: 3000, terminationGraceMs: 100, monitorIntervalMs: 25,
    logMaxBytes: 8192, maxTaskBytes: 1e7, maxTotalBytes: 1e8, minFreeBytes: 0, maxPreviewBytes: 65536,
    localModels: [], expectedOutputs: ['generated_code.py'],
    preprocess: { command: process.execPath, args: [path.join(fixtures, 'preprocess.mjs')] },
    crafter: { command: process.execPath, args: [path.join(fixtures, 'crafter.mjs'), '--delay-ms=30'] } };
  const store = new TaskStore(path.join(dataDir, 'tasks.sqlite'));
  const files = new TaskFiles(config);
  const scheduler = new Scheduler({ store, files, config });
  await scheduler.start();
  const submit = async (model = 'demo') => {
    const id = randomUUID();
    const paths = await files.initTask(id);
    await writeFile(paths.input, '%PDF-1.4\nfixture');
    store.insert({ id, paperName: 'fixture.pdf', pdfBytes: 17, mode: 'remote', model,
      baseUrl: 'https://example.invalid/v1', createdAt: '2026-10-28T00:00:00.000Z' });
    scheduler.credentials.set(id, 'key-only-in-memory');
    return id;
  };
  const cleanup = async () => { await scheduler.shutdown(); store.close(); await rm(dataDir, { recursive: true, force: true }); };
  return { config, store, files, scheduler, submit, cleanup };
}

async function terminal(store, id) {
  for (let tries = 0; tries < 400; tries++) {
    const task = store.get(id);
    if (['Completed', 'Failed'].includes(task?.status)) return task;
    await wait(10);
  }
  throw new Error('Task did not finish.');
}

test('one-at-a-time FIFO handles equal submission timestamps and releases credentials', { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    const first = await app.submit();
    const second = await app.submit();
    app.scheduler.kick();
    const [a, b] = await Promise.all([terminal(app.store, first), terminal(app.store, second)]);
    assert.equal(a.status, 'Completed');
    assert.equal(b.status, 'Completed');
    assert.ok(b.startedAt >= a.finishedAt, 'second task starts after the first has finished');
    assert.equal(app.scheduler.credentials.size, 0);
    assert.ok(await app.files.outputsPublished(first));
    assert.ok((await readFile(app.files.paths(first).log, 'utf8')).includes('[DEMO ONLY]'));
  } finally { await app.cleanup(); }
});

test('successful command without expected output is Failed and retains safe partial files', { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    app.config.expectedOutputs = ['missing.py'];
    const id = await app.submit();
    app.scheduler.kick();
    const task = await terminal(app.store, id);
    assert.equal(task.status, 'Failed');
    assert.match(task.error, /expected output/);
    assert.ok((await app.files.listOutputs(id)).length > 0);
    assert.equal(app.scheduler.credentials.has(id), false);
  } finally { await app.cleanup(); }
});

test('queued withdrawal wins a concurrent capacity check and cannot start the task', { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    let release;
    let checked;
    const checking = new Promise((resolve) => { checked = resolve; });
    app.files.assertCapacity = async () => { checked(); await new Promise((resolve) => { release = resolve; }); };
    const id = await app.submit();
    app.scheduler.kick();
    await checking;
    const deletion = app.scheduler.withdrawAndDelete(id);
    assert.equal(app.store.get(id).withdrawn, true);
    assert.equal(app.scheduler.credentials.has(id), false);
    release();
    await deletion;
    await wait(50);
    assert.equal(app.store.get(id), undefined);
    assert.equal(app.scheduler.activeId, null);
  } finally { await app.cleanup(); }
});

test('timeout terminates stubborn descendants before the next task begins', { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    app.config.taskTimeoutMs = 300;
    app.config.crafter = { command: process.execPath, args: [path.join(fixtures, 'conditional-crafter.mjs'), '--delay-ms=10'] };
    const first = await app.submit('test-timeout');
    const second = await app.submit('demo');
    app.scheduler.kick();
    const a = await terminal(app.store, first);
    const b = await terminal(app.store, second);
    assert.equal(a.status, 'Failed');
    assert.equal(a.error, 'timeout');
    assert.equal(b.status, 'Completed');
    assert.ok(b.startedAt >= a.finishedAt);
    const pid = Number(await readFile(path.join(app.files.paths(first).work, 'descendant.pid'), 'utf8'));
    if (process.platform !== 'linux') assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await app.cleanup(); }
});
