import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/server.js';
import { validatePdf } from '../src/validation.js';
import { samplePdf, upload, eventually } from './helpers.js';

const key = 'secret-fixture-key-never-store-297413';
const remote = { mode: 'remote', model: 'fixture-model', baseUrl: 'https://fixture.example/v1', apiKey: key };
async function application(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'crafter-api-'));
  const config = {
    port: 0, dataDir, minFreeBytes: 0, monitorIntervalMs: 25,
    terminationGraceMs: 100, taskTimeoutMs: 10000, expectedOutputs: ['main.py'],
    preprocess: { command: process.execPath, args: ['test/fixtures/preprocess.mjs'], cwd: '.' },
    crafter: { command: process.execPath, args: ['test/fixtures/api-worker.mjs'], cwd: '.' },
    localModels: [{ id: 'fixture', label: 'Offline acceptance fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:8000/v1' }],
    remoteAllowedHosts: ['fixture.example'], ...overrides,
  };
  const app = await startServer({ config });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, options) => { const response = await fetch(app.url + path, options); const body = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text(); return { status: response.status, body }; };
  const submit = async (label, fields) => call('/api/tasks', { method: 'POST', body: upload(samplePdf(label), fields) });
  const done = id => eventually(() => { const task = app.store.get(id); return ['Completed', 'Failed'].includes(task?.status) && task; });
  return { app, call, submit, done, config, dataDir };
}

test('unconfigured production reports integration unavailable and creates no pretend task', async t => {
  const { call, app } = await application(t, { preprocess: null, crafter: null });
  assert.equal((await call('/api/config')).body.integration.ready, false);
  assert.equal((await call('/api/tasks', { method: 'POST', body: upload() })).status, 503);
  assert.equal(app.store.list().length, 0);
});

test('validates PDF structure and exact decimal 75 MB boundary', () => {
  const pdf = samplePdf();
  assert.equal(validatePdf(pdf, 'paper.pdf', 75_000_000), 'paper.pdf');
  assert.throws(() => validatePdf(Buffer.from('not PDF'), 'paper.pdf', 75_000_000), /valid PDF header/);
  assert.throws(() => validatePdf(pdf.subarray(0, -15), 'paper.pdf', 75_000_000), /trailer/);
  const trailerIndex = pdf.lastIndexOf(Buffer.from('startxref'));
  const atLimit = Buffer.concat([pdf.subarray(0, trailerIndex), Buffer.alloc(75_000_000 - pdf.length, 32), pdf.subarray(trailerIndex)]);
  assert.equal(atLimit.length, 75_000_000);
  assert.equal(validatePdf(atLimit, 'boundary.pdf', 75_000_000), 'boundary.pdf');
  assert.throws(() => validatePdf(Buffer.alloc(75_000_001), 'boundary.pdf', 75_000_000), /75 MB/);
});

test('rejects invalid input/model/key/origin and keeps the history empty', async t => {
  const { call, app } = await application(t);
  assert.equal((await call('/api/tasks', { method: 'POST', body: upload(Buffer.from('x')) })).status, 400);
  assert.equal((await call('/api/tasks', { method: 'POST', body: upload(samplePdf(), { mode: 'local', localModelId: 'unknown' }) })).status, 400);
  assert.equal((await call('/api/tasks', { method: 'POST', body: upload(samplePdf(), { ...remote, apiKey: '' }) })).status, 400);
  assert.equal((await call('/api/tasks', { method: 'POST', body: upload(samplePdf(), { ...remote, baseUrl: 'http://fixture.example/v1' }) })).status, 400);
  assert.equal((await call('/api/tasks', { method: 'POST', headers: { origin: 'https://malicious.example' }, body: upload() })).status, 403);
  assert.equal(app.store.list().length, 0);
});

test('HTTPS proxy origins require explicit trust and forwarding headers cannot bypass it', async t => {
  const { call, app } = await application(t, { publicOrigin: 'https://crafter.lab.example' });
  const trusted = await call('/api/tasks', { method: 'POST', headers: { origin: 'https://crafter.lab.example' }, body: upload() });
  assert.equal(trusted.status, 201);
  const untrusted = await call('/api/tasks', { method: 'POST', headers: { origin: 'https://attacker.example', 'x-forwarded-proto': 'https' }, body: upload() });
  assert.equal(untrusted.status, 403);
  assert.equal(app.store.list().length, 1);
});

test('remote-mode offline fixture publishes safe files, retained PDF, redacted logs and valid streamed ZIP', async t => {
  const { call, submit, done, app, dataDir } = await application(t);
  const accepted = await submit('REMOTE_FIXTURE', remote);
  assert.equal(accepted.status, 201);
  const id = accepted.body.task.id;
  assert.equal((await done(id)).status, 'Completed');
  assert.equal(app.scheduler.credentials.has(id), false);
  const outputs = await call(`/api/tasks/${id}/outputs`);
  assert.deepEqual(outputs.body.files.map(x => x.path), ['main.py']);
  const logs = (await call(`/api/tasks/${id}/logs`)).body.text;
  assert.ok(logs.includes('[REDACTED]')); assert.ok(!logs.includes(key));
  const preview = (await call(`/api/tasks/${id}/preview?path=main.py`)).body.text;
  assert.ok(preview.includes('[REDACTED]')); assert.ok(!preview.includes(key));
  assert.equal((await call(`/api/tasks/${id}/file?path=../work/internal.txt`)).status, 403);
  assert.equal((await call(`/api/tasks/${id}/file?path=.env`)).status, 403);
  assert.equal((await call(`/api/tasks/${id}/file?path=outside.pdf`)).status, 403);
  const pdf = await fetch(`${app.url}/api/tasks/${id}/pdf?download=1`);
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), samplePdf('REMOTE_FIXTURE'));
  const zipResponse = await fetch(`${app.url}/api/tasks/${id}/archive.zip`);
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.ok(!zip.includes(Buffer.from(key)));
  const zipPath = join(dataDir, 'acceptance.zip'); await writeFile(zipPath, zip);
  const checked = spawnSync('/usr/bin/unzip', ['-t', zipPath], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr); await rm(zipPath);
  for (const file of await readdir(dataDir)) assert.ok(!file.endsWith('.zip'));
  for (const suffix of ['', '-wal']) {
    const db = await readFile(join(dataDir, `tasks.sqlite${suffix}`)).catch(() => Buffer.alloc(0));
    assert.ok(!db.includes(Buffer.from(key)));
  }
});

test('queued withdrawal is confirmed and atomic; active deletion is rejected; reruns are independent', async t => {
  const { call, submit, done, app } = await application(t);
  const first = (await submit('FIRST_FIXTURE', remote)).body.task;
  await eventually(() => app.store.get(first.id).status === 'Running Crafter');
  const second = (await submit('SECOND_FIXTURE')).body.task;
  assert.equal(app.store.get(second.id).status, 'Queued');
  const deletion = { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) };
  assert.equal((await call(`/api/tasks/${first.id}`, deletion)).status, 409);
  assert.equal((await call(`/api/tasks/${second.id}`, { ...deletion, body: '{}' })).status, 400);
  assert.equal((await call(`/api/tasks/${second.id}`, deletion)).status, 200);
  assert.equal(app.store.get(second.id), undefined);
  await done(first.id);
  const rerun = fields => call(`/api/tasks/${first.id}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
  assert.equal((await rerun({ ...remote, apiKey: '' })).status, 400);
  const repeated = await rerun(remote); assert.equal(repeated.status, 201);
  assert.notEqual(first.id, repeated.body.task.id);
  assert.equal(repeated.body.task.rerunOf, first.id);
  assert.equal((await call(`/api/tasks/${first.id}`, deletion)).status, 200);
  assert.equal((await done(repeated.body.task.id)).status, 'Completed');
  assert.deepEqual(await readFile(app.files.paths(repeated.body.task.id).input), samplePdf('FIRST_FIXTURE'));
});

test('timeout kills stubborn descendants before the next queued task starts', async t => {
  const { submit, done, app } = await application(t, { taskTimeoutMs: 700 });
  const first = (await submit('HANG_FIXTURE')).body.task;
  await eventually(async () => readFile(join(app.files.paths(first.id).work, 'descendant.pid'), 'utf8').catch(() => null));
  const second = (await submit('NEXT_FIXTURE')).body.task;
  const failed = await done(first.id); const completed = await done(second.id);
  assert.equal(failed.status, 'Failed'); assert.match(failed.error, /timeout/);
  assert.equal(completed.status, 'Completed');
  assert.ok(completed.startedAt >= failed.finishedAt);
  const pid = Number(await readFile(join(app.files.paths(first.id).work, 'descendant.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('storage failures preserve partial outputs and log rotation is visible', async t => {
  const { submit, done, call } = await application(t, { maxTaskBytes: 32000, logMaxBytes: 1024 });
  const logTask = (await submit('LOG_FIXTURE')).body.task;
  assert.equal((await done(logTask.id)).status, 'Completed');
  const log = (await call(`/api/tasks/${logTask.id}/logs`)).body;
  assert.equal(log.truncated, true); assert.ok(Buffer.byteLength(log.text) <= 1024);
  const storageTask = (await submit('STORAGE_FIXTURE')).body.task;
  const failed = await done(storageTask.id); assert.equal(failed.status, 'Failed'); assert.match(failed.error, /Storage/);
  const partial = (await call(`/api/tasks/${storageTask.id}/outputs`)).body;
  assert.equal(partial.partial, true); assert.equal(partial.files[0].path, 'main.py');
  const failTask = (await submit('FAIL_FIXTURE')).body.task;
  assert.equal((await done(failTask.id)).status, 'Failed');
});

test('low disk rejects uploads; queued resource waits give a visible reason', async t => {
  const { call, app, submit, done } = await application(t);
  app.config.minFreeBytes = Number.MAX_SAFE_INTEGER;
  assert.equal((await submit('LOW_DISK')).status, 507);
  app.config.minFreeBytes = 0;
  const first = (await submit('RESOURCE_FIRST')).body.task;
  await eventually(() => app.store.get(first.id).status === 'Running Crafter');
  const second = (await submit('RESOURCE_SECOND')).body.task;
  app.config.maxTaskBytes = Number.MAX_SAFE_INTEGER;
  // New task starts wait under a resource shortage; already running task's stop is independently enforced.
  const capacity = app.files.assertCapacity.bind(app.files);
  app.files.assertCapacity = async () => { throw Object.assign(new Error('test capacity shortage'), { status: 507 }); };
  await done(first.id);
  await eventually(() => app.store.get(second.id).waitReason);
  assert.equal((await call(`/api/tasks/${second.id}`)).body.task.status, 'Queued');
  assert.match(app.store.get(second.id).waitReason, /Waiting for storage/);
  app.files.assertCapacity = capacity; app.scheduler.kick();
  assert.equal((await done(second.id)).status, 'Completed');
});

test('retained PDF/log and rerun endpoints reject links outside the permitted task files', async t => {
  const { app, submit, done, call, dataDir } = await application(t);
  const task = (await submit('FILE_CONFINEMENT')).body.task;
  await done(task.id);
  const outside = join(dataDir, 'outside-private.txt');
  await writeFile(outside, 'private file must never be exposed');
  const paths = app.files.paths(task.id);
  for (const path of [paths.input, paths.log]) { await rm(path); await symlink(outside, path); }
  assert.equal((await call(`/api/tasks/${task.id}/pdf`)).status, 403);
  assert.equal((await call(`/api/tasks/${task.id}/logs`)).status, 403);
  const rerun = await call(`/api/tasks/${task.id}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'local', localModelId: 'fixture' }) });
  assert.equal(rerun.status, 403);
  assert.ok(!JSON.stringify(rerun.body).includes('private file'));
});

test('failed queued cleanup stays withdrawn across restart and supports deletion retry', async t => {
  const { app, submit, config, call } = await application(t);
  const first = (await submit('HANG_FIXTURE')).body.task;
  await eventually(() => app.store.get(first.id).status === 'Running Crafter');
  const queued = (await submit('WITHDRAWN_FIXTURE')).body.task;
  const remove = app.files.removeTask.bind(app.files);
  app.files.removeTask = async id => { if (id === queued.id) throw new Error('fixture cleanup failure'); return remove(id); };
  const deletion = { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) };
  assert.equal((await call(`/api/tasks/${queued.id}`, deletion)).status, 500);
  assert.equal(app.store.get(queued.id).withdrawn, true);
  assert.equal(app.store.get(queued.id).status, 'Failed');
  app.files.removeTask = remove;
  await app.close();
  const restarted = await startServer({ config });
  try {
    assert.equal(restarted.store.get(queued.id).withdrawn, true);
    assert.equal(restarted.scheduler.activeId, null);
    assert.equal((await fetch(`${restarted.url}/api/tasks/${queued.id}`, deletion)).status, 200);
    assert.equal(restarted.store.get(queued.id), undefined);
  } finally { await restarted.close(); }
});

test('restart preserves history/PDF and fails unrecoverable queued records without publishing unsafe files', async t => {
  const { app, submit, config, dataDir } = await application(t);
  const first = (await submit('RESTART_FIRST')).body.task;
  await eventually(() => app.store.get(first.id).status === 'Running Crafter');
  const queued = (await submit('RESTART_QUEUED', remote)).body.task;
  await app.close();
  const restarted = await startServer({ config });
  try {
    assert.equal(restarted.store.get(queued.id).status, 'Failed');
    assert.match(restarted.store.get(queued.id).error, /interruption/);
    assert.equal(restarted.scheduler.credentials.size, 0);
    assert.deepEqual(await readFile(restarted.files.paths(queued.id).input), samplePdf('RESTART_QUEUED'));
    const result = await fetch(`${restarted.url}/api/tasks/${queued.id}/outputs`).then(x => x.json());
    assert.equal(result.files.length, 0); assert.ok(result.unavailableReason);
    assert.equal((await readdir(dataDir)).includes('tasks.sqlite'), true);
  } finally { await restarted.close(); }
});
