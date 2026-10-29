import { createReadStream, createWriteStream, constants } from 'node:fs';
import { mkdir, lstat, readdir, realpath, rm, rename, statfs, open, writeFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.rst', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.bash', '.c', '.h', '.cpp', '.hpp', '.cc', '.r', '.rs', '.java', '.go', '.sql', '.html', '.css', '.xml', '.csv', '.tsv', '.tex', '.ipynb']);
const SENSITIVE = /^(?:credentials?|secrets?|api[_-]?keys?|runtime(?:[-_.].*)?|config[._-]private|id_(?:rsa|ed25519))(?:\.|$)|\.(?:pem|key|p12|pfx|db|sqlite3?)$/i;
const ARCHIVES = /\.(?:zip|tar|gz|tgz|7z|rar|bz2|xz)$/i;
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '__pycache__', 'venv', 'env', 'internal', 'preprocessing']);

function allowedSegments(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\') || path.posix.isAbsolute(relative)) return false;
  return relative.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.startsWith('.') && !EXCLUDED_DIRECTORIES.has(segment.toLowerCase()) && !SENSITIVE.test(segment) && !ARCHIVES.test(segment));
}

function inside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function directoryBytes(directory) {
  let total = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      const info = await lstat(target);
      if (info.isDirectory() && !info.isSymbolicLink()) total += await directoryBytes(target);
      else total += info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return total;
}

function textFile(relative) {
  return TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) || /^(?:readme|license|makefile|dockerfile|requirements(?:[-_].*)?)$/i.test(path.basename(relative));
}

export class TaskFiles {
  constructor(config) {
    this.config = config;
    this.dataDir = path.resolve(config.dataDir);
    this.tasksDir = path.join(this.dataDir, 'tasks');
  }

  paths(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Invalid task ID.');
    const root = path.join(this.tasksDir, id);
    return { root, input: path.join(root, 'input.pdf'), work: path.join(root, 'work'), output: path.join(root, 'outputs'), log: path.join(root, 'task.log') };
  }

  async initTask(id) {
    const locations = this.paths(id);
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.tasksDir)).isSymbolicLink()) throw new HttpError(500, 'Task storage is not a regular directory.');
    await mkdir(locations.root, { mode: 0o700 });
    await mkdir(locations.work, { mode: 0o700 });
    await mkdir(locations.output, { mode: 0o700 });
    return locations;
  }

  async removeTask(id) {
    const locations = this.paths(id);
    let info;
    try { info = await lstat(this.tasksDir); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new HttpError(500, 'Task storage is not a regular directory.');
    await rm(locations.root, { recursive: true, force: true });
  }

  async deleteTask(id) { return this.removeTask(id); }

  async cleanupRuntimeTemps(id) {
    const locations = this.paths(id);
    try {
      for (const directory of [this.dataDir, this.tasksDir, locations.root]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(403, 'Temporary-file cleanup requires a regular task directory.');
      }
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    const resolvedRoot = await realpath(locations.root);
    if (resolvedRoot !== path.join(await realpath(this.dataDir), 'tasks', id)) throw new HttpError(403, 'Temporary-file cleanup is outside the permitted task directory.');
    const patterns = [
      [locations.root, /^task\.log\.next-([0-9a-f-]+)$/i],
      [locations.work, /^sanitized-([0-9a-f-]+)$/i],
    ];
    let removed = 0;
    for (const [directory, pattern] of patterns) {
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(resolvedRoot, await realpath(directory))) throw new HttpError(403, 'Temporary-file cleanup requires a permitted task directory.');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = pattern.exec(entry.name);
        if (!match || !UUID.test(match[1])) continue;
        const filename = path.join(directory, entry.name);
        let candidate;
        try { candidate = await lstat(filename); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!candidate.isFile() && !candidate.isSymbolicLink()) continue;
        try { await unlink(filename); removed++; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return removed;
  }

  async openRetained(id, kind) {
    if (kind !== 'input' && kind !== 'log') throw new HttpError(400, 'Invalid retained file type.');
    const locations = this.paths(id);
    const filename = locations[kind];
    let handle;
    try {
      const ancestors = [];
      for (const directory of [this.dataDir, this.tasksDir, locations.root]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(403, 'Retained file is outside a permitted task directory.');
        ancestors.push({ directory, info });
      }
      const resolvedData = await realpath(this.dataDir);
      const resolvedRoot = await realpath(locations.root);
      if (resolvedRoot !== path.join(resolvedData, 'tasks', id)) throw new HttpError(403, 'Retained file is outside a permitted task directory.');
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new HttpError(403, 'This retained file is not permitted.');
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new HttpError(403, 'The retained file changed while it was being opened.');
      for (const { directory, info } of ancestors) {
        const after = await lstat(directory);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) throw new HttpError(403, 'The retained file directory changed while it was being opened.');
      }
      const resolvedFile = await realpath(filename);
      if (!inside(resolvedRoot, resolvedFile) || resolvedFile !== path.join(resolvedRoot, path.basename(filename))) throw new HttpError(403, 'Retained file is outside a permitted task directory.');
      const after = await lstat(filename);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino) throw new HttpError(403, 'The retained file changed while it was being opened.');
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, 'The retained file was not found.');
      if (error.code === 'ELOOP') throw new HttpError(403, 'This retained file is not permitted.');
      throw error;
    }
  }

  async usage() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const [totalBytes, disk] = await Promise.all([directoryBytes(this.dataDir), statfs(this.dataDir)]);
    return { totalBytes, freeBytes: disk.bavail * disk.bsize };
  }

  async assertCapacity(extraBytes = 0, taskId = null) {
    if (!Number.isSafeInteger(extraBytes) || extraBytes < 0) throw new TypeError('Invalid requested storage size.');
    const { totalBytes, freeBytes } = await this.usage();
    const cfg = this.config;
    if (totalBytes + extraBytes >= cfg.maxTotalBytes) throw new HttpError(507, 'Application storage limit reached. Delete an unneeded finished task to free space.');
    if (freeBytes - extraBytes <= cfg.minFreeBytes) throw new HttpError(507, 'Available disk space is below the configured minimum.');
    const existingTaskBytes = taskId ? await directoryBytes(this.paths(taskId).root) : 0;
    if (existingTaskBytes + extraBytes >= cfg.maxTaskBytes) throw new HttpError(507, 'The task storage limit would be exceeded.');
  }

  async runtimeReason(id) {
    const [{ totalBytes, freeBytes }, taskBytes] = await Promise.all([this.usage(), directoryBytes(this.paths(id).root)]);
    if (taskBytes >= this.config.maxTaskBytes) return 'Task storage limit reached.';
    if (totalBytes >= this.config.maxTotalBytes) return 'Application storage limit reached.';
    if (freeBytes <= this.config.minFreeBytes) return 'Available disk space fell below the configured minimum.';
    return null;
  }

  async #outputRoot(id) {
    const locations = this.paths(id);
    for (const directory of [this.tasksDir, locations.root, locations.output]) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(403, 'Output location is not a permitted task directory.');
    }
    return { locations, resolved: await realpath(locations.output) };
  }

  async outputPath(id, relative) {
    if (!allowedSegments(relative)) throw new HttpError(403, 'This output path is not permitted.');
    let context;
    try { context = await this.#outputRoot(id); }
    catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'Output file was not found.'); throw error; }
    let candidate = context.locations.output;
    const segments = relative.split('/');
    try {
      for (let index = 0; index < segments.length; index++) {
        candidate = path.join(candidate, segments[index]);
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw new HttpError(403, 'This output file is not permitted.');
      }
      if (!inside(context.resolved, await realpath(candidate))) throw new HttpError(403, 'Output file is outside the permitted directory.');
      return candidate;
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, 'Output file was not found.'); throw error; }
  }

  async listOutputs(id) {
    let context;
    try { context = await this.#outputRoot(id); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const outputs = [];
    const visit = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!allowedSegments(relative)) continue;
        let info;
        const candidate = path.join(directory, entry.name);
        try { info = await lstat(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(candidate, relative);
        else if (info.isFile() && info.nlink === 1) {
          let previewable = textFile(relative) && info.size <= this.config.maxPreviewBytes;
          if (previewable) {
            const handle = await open(candidate, 'r');
            try {
              const sample = Buffer.alloc(Math.min(info.size, 4096));
              await handle.read(sample, 0, sample.length, 0);
              previewable = !sample.includes(0);
            } finally { await handle.close(); }
          }
          outputs.push({ path: relative, size: info.size, previewable });
        }
      }
    };
    await visit(context.locations.output);
    return outputs.sort((a, b) => a.path.localeCompare(b.path));
  }

  async sanitizeOutputs(id, secrets = []) {
    const activeSecrets = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length))];
    const locations = this.paths(id);
    for (const directory of [this.tasksDir, locations.root, locations.work]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(403, 'Task workspace is not a permitted directory.');
    }
    await rm(path.join(locations.work, 'outputs-sanitized'), { force: true });
    const removeNamedSecrets = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (activeSecrets.some(secret => entry.name.includes(secret))) {
          // Keeping a secret in a private filename would still persist it.
          await rm(candidate, { recursive: true, force: true });
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) await removeNamedSecrets(candidate);
      }
    };
    await removeNamedSecrets(locations.output);
    const candidates = await this.listOutputs(id);
    for (const entry of candidates) {
      const source = await this.outputPath(id, entry.path);
      const temporary = path.join(locations.work, `sanitized-${randomUUID()}`);
      const result = await sanitizeFile(source, temporary, activeSecrets);
      if (result.binary) {
        await rm(temporary, { force: true });
        if (result.sensitive) {
          // Binary replacement can corrupt an artifact; remove a credential-
          // bearing binary instead of retaining its secret in quarantine.
          await rm(source, { force: true });
        }
      } else await rename(temporary, source);
    }
    await writeFile(path.join(locations.work, 'outputs-sanitized'), new Date().toISOString(), { mode: 0o600 });
  }

  async outputsReady(id) {
    try {
      const workspace = await lstat(this.paths(id).work);
      if (!workspace.isDirectory() || workspace.isSymbolicLink()) return false;
      const info = await lstat(path.join(this.paths(id).work, 'outputs-sanitized'));
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async outputsPublished(id) { return this.outputsReady(id); }

  async quarantineInterruptedOutputs(id) {
    if (await this.outputsReady(id)) return;
    const locations = this.paths(id);
    await mkdir(locations.work, { recursive: true, mode: 0o700 });
    try { await rename(locations.output, path.join(locations.work, `interrupted-outputs-${randomUUID()}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(locations.output, { mode: 0o700 });
  }
}

async function sanitizeFile(source, target, secrets) {
  const needles = secrets.map(secret => Buffer.from(secret));
  const retain = Math.max(0, ...needles.map(needle => needle.length - 1));
  const destination = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  destination.on('error', () => {});
  let pending = Buffer.alloc(0);
  let binary = false;
  let sensitive = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const emit = async buffer => {
    let replaced = buffer;
    for (const needle of needles) {
      let start = 0;
      let index = replaced.indexOf(needle);
      const pieces = [];
      while (index !== -1) {
        sensitive = true;
        pieces.push(replaced.subarray(start, index), Buffer.from('[REDACTED]'));
        start = index + needle.length;
        index = replaced.indexOf(needle, start);
      }
      if (pieces.length) replaced = Buffer.concat([...pieces, replaced.subarray(start)]);
    }
    if (!destination.write(replaced)) await once(destination, 'drain');
  };
  try {
    for await (const chunk of createReadStream(source)) {
      if (chunk.includes(0)) binary = true;
      try { decoder.decode(chunk, { stream: true }); } catch { binary = true; }
      pending = Buffer.concat([pending, chunk]);
      let cut = Math.max(0, pending.length - retain);
      // Whole lines preserve UTF-8 characters and assignment-style redaction.
      const lastLine = pending.lastIndexOf(10, Math.max(0, cut - 1));
      if (lastLine >= 0) cut = lastLine + 1;
      else if (pending.length < 1_048_576) continue;
      let moved;
      do {
        moved = false;
        for (const needle of needles) {
          let index = pending.indexOf(needle);
          while (index >= 0 && index < cut) {
            if (index + needle.length > cut) { cut = index; moved = true; break; }
            index = pending.indexOf(needle, index + needle.length);
          }
        }
      } while (moved);
      if (cut) { await emit(pending.subarray(0, cut)); pending = pending.subarray(cut); }
    }
    try { decoder.decode(); } catch { binary = true; }
    await emit(pending);
    destination.end();
    await once(destination, 'close');
    return { binary, sensitive };
  } catch (error) {
    destination.destroy();
    await rm(target, { force: true });
    throw error;
  }
}
