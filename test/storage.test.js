import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store.js';
import { TaskFiles } from '../src/files.js';
import { TaskLogger, redact } from '../src/logs.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'crafter-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function configuration(dataDir, overrides = {}) {
  return { dataDir, maxTaskBytes: 100_000_000, maxTotalBytes: 200_000_000, minFreeBytes: 0, maxPreviewBytes: 262144, logMaxBytes: 1024, ...overrides };
}

function task(id = randomUUID()) {
  return { id, paperName: "paper'; DROP TABLE tasks; --.pdf", pdfBytes: 256, mode: 'remote', baseUrl: 'https://example.com/v1', model: 'test-model' };
}

test('SQLite persists only approved task metadata and keeps independent rerun records', async t => {
  const root = await temporary(t);
  const dbPath = path.join(root, 'tasks.db');
  let store = new TaskStore(dbPath);
  const original = task();
  store.insert(original);
  store.update(original.id, { status: 'Failed', error: 'timeout', withdrawn: true });
  assert.throws(() => store.update(original.id, { apiKey: 'sk-never-persist' }), /not permitted/);
  assert.throws(() => store.insert({ ...task(), apiKey: 'sk-never-persist' }), /not permitted/);
  const rerun = task();
  store.insert({ ...rerun, rerunOf: original.id });
  store.close();
  store = new TaskStore(dbPath);
  assert.equal(store.get(original.id).withdrawn, true);
  assert.equal(store.get(original.id).error, 'timeout');
  assert.equal(store.list().length, 2);
  store.remove(original.id);
  assert.equal(store.get(rerun.id).rerunOf, original.id);
  assert.equal(store.get(original.id), undefined);
  store.close();
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
  for (const filename of await readdir(root)) assert.equal((await readFile(path.join(root, filename))).includes(Buffer.from('sk-never-persist')), false);
});

test('Published files reject traversal, hidden/sensitive paths, symlinks and hardlinks', async t => {
  const root = await temporary(t);
  const files = new TaskFiles(configuration(root));
  const id = randomUUID();
  const locations = await files.initTask(id);
  await writeFile(path.join(locations.output, 'main.py'), 'print("hello")\n');
  await writeFile(path.join(locations.output, '.env'), 'OPENAI_API_KEY=secret');
  await writeFile(path.join(locations.output, 'credentials.json'), '{}');
  await writeFile(path.join(locations.output, 'runtime.json'), '{}');
  await writeFile(path.join(locations.output, 'bundle.zip'), 'not-a-zip');
  await writeFile(path.join(root, 'outside.txt'), 'private');
  await symlink(path.join(root, 'outside.txt'), path.join(locations.output, 'linked.txt'));
  await link(path.join(root, 'outside.txt'), path.join(locations.output, 'hardlinked.txt'));
  await mkdir(path.join(locations.output, 'nested'));
  await writeFile(path.join(locations.output, 'nested', 'notes.md'), 'safe text');
  assert.deepEqual((await files.listOutputs(id)).map(file => file.path), ['main.py', 'nested/notes.md']);
  for (const relative of ['../input.pdf', '/etc/passwd', 'nested/../../input.pdf', 'nested\\notes.md', '.env', 'credentials.json', 'runtime.json', 'bundle.zip', 'linked.txt', 'hardlinked.txt']) {
    await assert.rejects(files.outputPath(id, relative), error => error.status === 403);
  }
  await assert.rejects(files.outputPath(id, 'missing.txt'), error => error.status === 404);
  assert.throws(() => files.paths('../../etc'), error => error.status === 400);
  assert.equal(await files.outputPath(id, 'main.py'), path.join(locations.output, 'main.py'));
  await files.removeTask(id);
  assert.equal((await readFile(path.join(root, 'outside.txt'), 'utf8')), 'private');
});

test('Storage checks include per-task files, total application files and free disk', async t => {
  const root = await temporary(t);
  const config = configuration(root, { maxTaskBytes: 100, maxTotalBytes: 200 });
  const files = new TaskFiles(config);
  const id = randomUUID();
  const locations = await files.initTask(id);
  await writeFile(locations.input, Buffer.alloc(100));
  assert.match(await files.runtimeReason(id), /Task storage/);
  await assert.rejects(files.assertCapacity(1, id), error => error.status === 507 && /task storage/.test(error.message));
  config.maxTaskBytes = 1000;
  await writeFile(path.join(root, 'temporary-download.bin'), Buffer.alloc(100));
  assert.match(await files.runtimeReason(id), /Application storage/);
  await assert.rejects(files.assertCapacity(1), error => error.status === 507);
  config.maxTotalBytes = 1000;
  config.minFreeBytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(files.assertCapacity(), error => error.status === 507 && /disk space/.test(error.message));
});

test('Retained PDF and log descriptor opens reject external symlinks/hardlinks and unsafe ancestors', async t => {
  const root = await temporary(t);
  const files = new TaskFiles(configuration(root));
  const id = randomUUID();
  const locations = await files.initTask(id);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'private data outside the task');
  await assert.rejects(files.openRetained(id, 'output'), error => error.status === 400);
  await assert.rejects(files.openRetained(id, 'log'), error => error.status === 404);
  for (const kind of ['input', 'log']) {
    const expected = kind === 'input' ? '%PDF-1.7\nretained input' : 'retained safe log\n';
    await writeFile(locations[kind], expected);
    const handle = await files.openRetained(id, kind);
    try { assert.equal(await handle.readFile('utf8'), expected); }
    finally { await handle.close(); }
    await rm(locations[kind]);
    await symlink(outside, locations[kind]);
    await assert.rejects(files.openRetained(id, kind), error => error.status === 403);
    await rm(locations[kind]);
    await link(outside, locations[kind]);
    await assert.rejects(files.openRetained(id, kind), error => error.status === 403);
    await rm(locations[kind]);
  }
  await files.removeTask(id);
  const outsideDirectory = path.join(root, 'outside-directory');
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, 'input.pdf'), 'outside PDF');
  await symlink(outsideDirectory, locations.root);
  await assert.rejects(files.openRetained(id, 'input'), error => error.status === 403);
  assert.equal(await readFile(outside, 'utf8'), 'private data outside the task');
});

test('Output sanitization removes keys from text and removes sensitive binary files and names', async t => {
  const root = await temporary(t);
  const files = new TaskFiles(configuration(root));
  const id = randomUUID();
  const locations = await files.initTask(id);
  const secret = 'sk-sensitive-test-key';
  await writeFile(path.join(locations.output, 'main.py'), `# 中文 🧪\n# ${secret}\nprint('safe')\n`);
  await writeFile(path.join(locations.output, 'client.py'), 'api_key = os.environ.get("OPENAI_API_KEY")\n');
  await writeFile(path.join(locations.output, 'settings.txt'), `Authorization: Bearer ${secret}\napi_key="${secret}"\n`);
  await writeFile(path.join(locations.output, 'binary.dat'), Buffer.concat([Buffer.from([0, 1]), Buffer.from(secret)]));
  await writeFile(path.join(locations.output, `${secret}.txt`), 'safe contents but sensitive filename');
  await writeFile(path.join(locations.output, 'large.txt'), `${'x'.repeat(65530)}${secret}\n${'y'.repeat(1_100_000)}${secret}\n`);
  assert.equal(await files.outputsReady(id), false);
  await files.sanitizeOutputs(id, [secret]);
  assert.equal(await files.outputsReady(id), true);
  const listed = await files.listOutputs(id);
  assert.equal(listed.some(file => file.path.includes(secret) || file.path === 'binary.dat'), false);
  for (const file of listed) {
    const content = await readFile(await files.outputPath(id, file.path), 'utf8');
    assert.equal(content.includes(secret), false);
  }
  assert.match(await readFile(path.join(locations.output, 'main.py'), 'utf8'), /中文 🧪/);
  assert.equal(await readFile(path.join(locations.output, 'client.py'), 'utf8'), 'api_key = os.environ.get("OPENAI_API_KEY")\n');
  assert.equal((await readdir(locations.output)).some(name => name.includes(secret) || name === 'binary.dat'), false);
});

test('Retained logs redact secrets across writes and flushes, preserve UTF-8, and enforce the byte cap', async t => {
  const root = await temporary(t);
  const filename = path.join(root, 'task.log');
  const secret = 'sk-long-secret-key';
  const logger = new TaskLogger(filename, { maxBytes: 256, secrets: [secret] });
  logger.write('Starting\nkey: sk-long-');
  await logger.flush();
  assert.equal((await readFile(filename, 'utf8')).includes('sk-long-'), false);
  logger.write('secret-key\nAuthorization: Bearer different-key\n');
  const emoji = Buffer.from('测试 🧪\n');
  logger.write(emoji.subarray(0, 8));
  logger.write(emoji.subarray(8));
  await logger.flush();
  let output = await readFile(filename, 'utf8');
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('different-key'), false);
  assert.match(output, /测试 🧪/);
  for (let index = 0; index < 20; index++) logger.write(`line ${index} ${'x'.repeat(30)}\n`);
  await logger.close();
  output = await readFile(filename, 'utf8');
  assert.ok(Buffer.byteLength(output) <= 256);
  assert.match(output, /Earlier log entries removed/);
  const reopened = new TaskLogger(filename, { maxBytes: 256 });
  reopened.write('Recovered task\n');
  await reopened.close();
  assert.match(await readFile(filename, 'utf8'), /line 19[\s\S]*Recovered task/);
  assert.equal(redact(`secret=${secret}`, [secret]).includes(secret), false);
});

test('Unterminated progress becomes visible within one second while incomplete credential fields stay buffered', async t => {
  const root = await temporary(t);
  const filename = path.join(root, 'task.log');
  const logger = new TaskLogger(filename, { maxBytes: 4096 });
  t.after(() => logger.close());
  logger.write('partial progress: 10%');
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.match(await readFile(filename, 'utf8'), /partial progress: 10%/);
  logger.write('\nAuthoriza');
  await logger.flush();
  logger.write('tion: Bearer unknown-');
  await logger.flush();
  logger.write('credential\n');
  await logger.close();
  const text = await readFile(filename, 'utf8');
  assert.equal(text.includes('unknown-'), false);
  assert.match(text, /Authorization: \[REDACTED\]/);
});

test('Interruption recovery quarantines unpublished output and preserves already sanitized output', async t => {
  const root = await temporary(t);
  const files = new TaskFiles(configuration(root));
  const interrupted = randomUUID();
  const locations = await files.initTask(interrupted);
  await writeFile(path.join(locations.output, 'crash.txt'), 'unknown lost API key');
  await files.quarantineInterruptedOutputs(interrupted);
  assert.deepEqual(await files.listOutputs(interrupted), []);
  assert.equal(await files.outputsPublished(interrupted), false);
  assert.equal((await readdir(locations.work)).some(name => name.startsWith('interrupted-outputs-')), true);
  const finished = randomUUID();
  const finishedPaths = await files.initTask(finished);
  await writeFile(path.join(finishedPaths.output, 'main.py'), 'safe code');
  await files.sanitizeOutputs(finished, []);
  await files.quarantineInterruptedOutputs(finished);
  assert.equal(await files.outputsPublished(finished), true);
  assert.equal((await files.listOutputs(finished))[0].path, 'main.py');
});

test('Runtime-temp recovery removes only known temporary files without traversing symlinks', async t => {
  const root = await temporary(t);
  const files = new TaskFiles(configuration(root));
  const id = randomUUID();
  const locations = await files.initTask(id);
  const retained = [locations.input, locations.log, path.join(locations.work, 'paper.md'), path.join(locations.work, 'sanitized-report'), path.join(locations.work, 'outputs-sanitized'), path.join(locations.output, 'main.py'), path.join(locations.root, 'task.log.next-backup')];
  for (const filename of retained) await writeFile(filename, 'retained content');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'external content');
  const staleLog = path.join(locations.root, `task.log.next-${randomUUID()}`);
  const staleOutput = path.join(locations.work, `sanitized-${randomUUID()}`);
  const staleLink = path.join(locations.work, `sanitized-${randomUUID()}`);
  await writeFile(staleLog, 'temporary log snapshot');
  await writeFile(staleOutput, 'temporary sanitized output');
  await symlink(outside, staleLink);
  const matchingDirectory = path.join(locations.work, `sanitized-${randomUUID()}`);
  await mkdir(matchingDirectory);
  await writeFile(path.join(matchingDirectory, 'keep.txt'), 'retained directory contents');
  assert.equal(await files.cleanupRuntimeTemps(id), 3);
  assert.equal(await files.cleanupRuntimeTemps(id), 0);
  for (const filename of retained) assert.equal(await readFile(filename, 'utf8'), 'retained content');
  assert.equal(await readFile(outside, 'utf8'), 'external content');
  assert.equal(await readFile(path.join(matchingDirectory, 'keep.txt'), 'utf8'), 'retained directory contents');
  const missing = randomUUID();
  assert.equal(await files.cleanupRuntimeTemps(missing), 0);
});
