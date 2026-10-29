import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, open, unlink, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { loadConfig, normalizeConfig, publicConfig, PROJECT_ROOT } from './config.js';
import { HttpError } from './errors.js';
import { TaskStore } from './store.js';
import { TaskFiles } from './files.js';
import { Scheduler } from './scheduler.js';
import { readSubmission, readJson, validateModel, validatePdf } from './validation.js';
import { streamArchive } from './archive.js';
import { checkIntegration } from './integration.js';

const terminal = status => status === 'Completed' || status === 'Failed';
const expose = task => { if (!task) throw new HttpError(404, 'Task not found.'); const { processGroupId, ...publicTask } = task; return publicTask; };
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const disposition = (name, attachment = true) => `${attachment ? 'attachment' : 'inline'}; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, x => `%${x.charCodeAt(0).toString(16)}`)}`;

async function acquireLock(dataDir) {
  const path = join(dataDir, 'server.lock'); const token = randomUUID();
  const create = async () => {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); }
    finally { await file.close(); }
    return async () => { try { const saved = JSON.parse(await readFile(path, 'utf8')); if (saved.token === token) await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  };
  try { return await create(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // A second exclusive gate serializes stale-owner checks and replacement.
  // A crash while reclaiming fails closed instead of allowing two schedulers.
  const reclaimPath = `${path}.reclaim`;
  let reclaim;
  try { reclaim = await open(reclaimPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another startup is checking this data directory. If a prior startup crashed, inspect server.lock.reclaim before removing it.'); throw error; }
  try {
    await reclaim.writeFile(JSON.stringify({ pid: process.pid, token }));
    const saved = await readFile(path, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (saved) {
      if (!Number.isInteger(saved.pid) || saved.pid <= 1) throw new Error('Invalid server lock; administrator inspection is required.');
      try { process.kill(saved.pid, 0); throw new Error('Another server owns this data directory.'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      await unlink(path);
    }
    return await create();
  } finally { await reclaim.close(); await unlink(reclaimPath); }
}

export async function startServer(options = {}) {
  const config = options.config ? normalizeConfig(options.config) : await loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const unlock = await acquireLock(config.dataDir);
  let store; let scheduler; let server; let closed = false;
  try {
    store = new TaskStore(join(config.dataDir, 'tasks.sqlite'));
    const files = new TaskFiles(config);
    await checkIntegration(config);
    scheduler = new Scheduler({ store, files, config });
    await scheduler.start();
    let creating = false;
    const clientConfig = () => {
      const result = publicConfig(config);
      const execution = scheduler.status();
      if (!execution.ready && result.integration.ready) result.integration = { ...result.integration, ready: false, message: execution.reason || 'Execution is temporarily unavailable.' };
      return result;
    };
    const ensureReady = () => { if (!clientConfig().integration.ready) throw new HttpError(503, clientConfig().integration.message); };
    const capacityFor = async bytes => {
      if (bytes >= config.maxTaskBytes) throw new HttpError(507, 'The PDF exceeds this server’s per-task storage limit.');
      await files.assertCapacity(bytes);
    };
    const createTask = async ({ bytes, name, fields, rerunOf = null }) => {
      const model = await validateModel(fields, config);
      await capacityFor(bytes.length);
      const id = randomUUID();
      const task = { id, paperName: name, pdfBytes: bytes.length, mode: model.mode, baseUrl: model.baseUrl, model: model.model, localModelId: model.localModelId, status: 'Queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, waitReason: null, rerunOf, withdrawn: false, processGroupId: null };
      try {
        await files.initTask(id);
        await writeFile(files.paths(id).input, bytes, { mode: 0o600, flag: 'wx' });
        store.insert(task);
        scheduler.credentials.set(id, model.key);
      } catch (error) { scheduler.credentials.delete(id); await files.removeTask(id).catch(() => {}); throw error; }
      scheduler.kick();
      return expose(task);
    };
    const sendFile = async (res, path, name, type, attachment = true) => {
      const info = await stat(path).catch(() => { throw new HttpError(404, 'The retained file is missing.'); });
      res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'content-disposition': disposition(name, attachment) });
      await pipeline(createReadStream(path), res);
    };
    const readRetained = async (id, kind, limit, expectedSize = null) => {
      const handle = await files.openRetained(id, kind);
      try {
        const info = await handle.stat();
        if (info.size > limit) throw new HttpError(413, 'The retained file exceeds its configured size limit.');
        if (expectedSize !== null && info.size !== expectedSize) throw new HttpError(409, 'The retained PDF changed unexpectedly.');
        const buffer = Buffer.alloc(info.size + 1); let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > info.size || total > limit) throw new HttpError(409, 'The retained file changed while being read.');
        return buffer.subarray(0, total);
      } finally { await handle.close(); }
    };
    const sendOriginal = async (res, task, attachment) => {
      const handle = await files.openRetained(task.id, 'input');
      try {
        const info = await handle.stat();
        if (info.size !== task.pdfBytes) throw new HttpError(409, 'The retained PDF changed unexpectedly.');
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': info.size, 'content-disposition': disposition(task.paperName, attachment) });
        await pipeline(handle.createReadStream({ autoClose: false, start: 0, end: info.size - 1 }), res);
      } finally { await handle.close(); }
    };
    const handler = async (req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      try {
        const host = req.headers.host || '';
        const hostname = new URL(`http://${host}`).hostname;
        if (!config.allowedHosts.includes(hostname)) throw new HttpError(403, 'Host is outside the restricted application configuration.');
        if (!['GET', 'HEAD'].includes(req.method)) {
          const expectedOrigin = config.publicOrigin || `${config.tlsCert ? 'https' : 'http'}://${host}`;
          if ((req.headers.origin && req.headers.origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site changes are not permitted.');
        }
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, ...clientConfig().integration });
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, clientConfig());
        if (url.pathname === '/api/tasks') {
          if (req.method === 'GET') return json(res, 200, { tasks: store.list().map(expose) });
          if (req.method === 'POST') {
            ensureReady();
            if (creating) { req.resume(); throw new HttpError(409, 'Another submission is being saved. Please retry.'); }
            creating = true;
            try { await files.assertCapacity(); const submission = await readSubmission(req, config.maxUploadBytes); return json(res, 201, { task: await createTask(submission) }); }
            finally { creating = false; }
          }
        }
        const match = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/([a-z.]+))?$/.exec(url.pathname);
        if (match) {
          const [, id, action] = match; const task = store.get(id); expose(task);
          if (!action && req.method === 'GET') return json(res, 200, { task: expose(task) });
          if (!action && req.method === 'DELETE') {
            const body = await readJson(req);
            if (body.confirmed !== true) throw new HttpError(400, 'Confirm deletion before continuing.');
            await scheduler.withdrawAndDelete(id); return json(res, 200, { deleted: true });
          }
          if (action === 'rerun' && req.method === 'POST') {
            ensureReady();
            if (creating) throw new HttpError(409, 'Another submission is being saved. Please retry.');
            creating = true;
            try {
              const fields = await readJson(req);
              const bytes = await readRetained(id, 'input', config.maxUploadBytes, task.pdfBytes);
              validatePdf(bytes, task.paperName, config.maxUploadBytes);
              return json(res, 201, { task: await createTask({ bytes, name: task.paperName, fields, rerunOf: id }) });
            } finally { creating = false; }
          }
          if (req.method === 'GET' && action === 'pdf') return await sendOriginal(res, task, url.searchParams.get('download') === '1');
          if (req.method === 'GET' && action === 'logs') {
            const bytes = await readRetained(id, 'log', config.logMaxBytes).catch(error => { if (error.status === 404) return Buffer.alloc(0); throw error; });
            const text = bytes.toString('utf8');
            return json(res, 200, { text, truncated: /(?:earlier|older).*entries removed|log.*truncat/i.test(text) });
          }
          if (req.method === 'GET' && ['outputs', 'preview', 'file', 'archive.zip'].includes(action)) {
            if (!terminal(task.status)) throw new HttpError(409, 'Outputs are available after execution ends.');
            if (!(await files.outputsPublished(id))) {
              const message = 'Outputs were not safely published before interruption or a protection failure. Review the retained logs and rerun the task.';
              if (action === 'outputs') return json(res, 200, { files: [], partial: task.status === 'Failed', unavailableReason: message });
              throw new HttpError(409, message);
            }
            const entries = await files.listOutputs(id);
            if (action === 'outputs') return json(res, 200, { files: entries, partial: task.status === 'Failed' });
            if (action === 'archive.zip') {
              if (!entries.length) throw new HttpError(404, 'There are no published outputs.');
              return await streamArchive(res, files, id, entries);
            }
            const relative = url.searchParams.get('path');
            const path = await files.outputPath(id, relative);
            const entry = entries.find(x => x.path === relative);
            if (!entry) throw new HttpError(404, 'Published output not found.');
            if (action === 'file') return await sendFile(res, path, basename(relative), 'application/octet-stream');
            if (!entry.previewable) throw new HttpError(415, 'This file has no text preview. Download it to inspect it.');
            const handle = await open(path, 'r');
            try {
              const buffer = Buffer.alloc(Math.min(entry.size, config.maxPreviewBytes));
              const { bytesRead } = await handle.read(buffer);
              return json(res, 200, { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: entry.size > bytesRead });
            } finally { await handle.close(); }
          }
        }
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
        if (req.method === 'GET' && assets[url.pathname]) {
          const [filename, type] = assets[url.pathname];
          return await sendFile(res, join(PROJECT_ROOT, 'public', filename), filename, type, false);
        }
        throw new HttpError(404, 'The requested page or API route does not exist.');
      } catch (error) {
        req.resume();
        if (res.headersSent) { res.destroy(); return; }
        const status = Number.isInteger(error.status) ? error.status : Number.isInteger(error.statusCode) ? error.statusCode : 500;
        // Only explicitly classified errors are returned; child output belongs in redacted logs.
        json(res, status, { error: { message: status < 500 || status === 503 || status === 507 ? error.message : 'The operation failed. Check available storage and server setup, then retry.' } });
      }
    };
    server = config.tlsCert ? https.createServer({ cert: await readFile(resolve(PROJECT_ROOT, config.tlsCert)), key: await readFile(resolve(PROJECT_ROOT, config.tlsKey)) }, handler) : http.createServer(handler);
    server.requestTimeout = 120_000; server.headersTimeout = 15_000; server.maxHeadersCount = 50;
    await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolveReady); });
    const address = server.address();
    const close = async () => {
      if (closed) return; closed = true;
      const stopped = new Promise(resolveStopped => server.close(resolveStopped));
      server.closeIdleConnections();
      await scheduler.shutdown();
      server.closeAllConnections(); await stopped; store.close(); await unlock();
    };
    return { config, server, store, files, scheduler, close, url: `${config.tlsCert ? 'https' : 'http'}://${config.host === '::1' ? '[::1]' : config.host}:${address.port}` };
  } catch (error) { await scheduler?.shutdown().catch(() => {}); store?.close(); server?.close(); await unlock(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(app => {
    console.log(`Crafter Web Interface: ${app.url}`);
    console.log(publicConfig(app.config).integration.message);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => { console.error(`Startup failed: ${error.message}`); process.exitCode = 1; });
}
