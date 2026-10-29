import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKENS = new Set(['input', 'work', 'output', 'model', 'baseUrl', 'taskId']);

export function expandArguments(args = [], context = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Process arguments must be an array of strings.');
  }
  return args.map((arg) => arg.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, token) => {
    if (!TOKENS.has(token)) throw new Error(`Unsupported process argument token: ${token}`);
    if (typeof context[token] !== 'string') throw new Error(`Missing process argument value: ${token}`);
    return context[token];
  }));
}

// Only the task's current credential reaches the child. In particular, an unrelated
// provider key inherited by the web server must not leak into a model subprocess.
export function taskEnvironment(context, secret = '', inherited = process.env, credentialEnvNames = []) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !/(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)/i.test(name) && !credentialEnvNames.includes(name)));
  for (const [token, name] of Object.entries({ input: 'CRAFTER_INPUT', work: 'CRAFTER_WORK',
    output: 'CRAFTER_OUTPUT', model: 'CRAFTER_MODEL', baseUrl: 'CRAFTER_BASE_URL', taskId: 'CRAFTER_TASK_ID' })) {
    env[name] = String(context[token] ?? '');
  }
  if (secret) env.OPENAI_API_KEY = env.CRAFTER_API_KEY = secret;
  return env;
}

async function linuxProcesses() {
  const names = await readdir('/proc');
  const rows = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(name), state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]) };
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}

async function hasMarker(pid, taskId) {
  try {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environment.split('\0').includes(`CRAFTER_TASK_ID=${taskId}`);
  } catch { return false; }
}

function signalGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error('Invalid task process group.');
  try { process.kill(-pgid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function processGroupAlive(pgid) {
  if (process.platform === 'linux') {
    return (await linuxProcesses()).some((row) => row.pgid === pgid && !['Z', 'X'].includes(row.state));
  }
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

/** Restart recovery never signals an unverified persisted PID, which may be reused. */
export async function recoverProcessGroup(taskId, pgid, graceMs = 2000) {
  if (pgid !== null && (!Number.isSafeInteger(pgid) || pgid <= 1)) return { safe: false, reason: 'Invalid stored process group; queue is blocked.' };
  if (process.platform !== 'linux') {
    return pgid && await processGroupAlive(pgid)
      ? { safe: false, reason: 'An interrupted process group is still alive and its ownership cannot be verified on this platform; queue is blocked.' }
      : { safe: true };
  }
  const owned = async () => {
    const live = (await linuxProcesses()).filter((row) => !['Z', 'X'].includes(row.state));
    const rows = await Promise.all(live.map(async (row) => ({ ...row, owned: await hasMarker(row.pid, taskId) })));
    if (pgid && rows.some((row) => row.pgid === pgid && !row.owned)) return null;
    return rows.filter((row) => row.owned);
  };
  let members = await owned();
  if (!members) return { safe: false, reason: 'Interrupted process ownership could not be verified; queue is blocked to avoid stopping an unrelated service.' };
  for (const row of members) signalPid(row.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (members.length && Date.now() < deadline) { await pause(50); members = await owned(); if (!members) break; }
  const killDeadline = Date.now() + Math.max(graceMs, 2000);
  while (members?.length && Date.now() < killDeadline) {
    for (const row of members) signalPid(row.pid, 'SIGKILL');
    await pause(50);
    members = await owned();
  }
  return !members || members.length
    ? { safe: false, reason: 'Interrupted task termination is not yet confirmed; queue is blocked.' }
    : { safe: true };
}

export class TaskProcess {
  constructor({ taskId, logger, terminationGraceMs = 2000, onSpawn = () => {}, onClear = () => {}, credentialEnvNames = [] }) {
    Object.assign(this, { taskId, logger, terminationGraceMs, onSpawn, onClear, credentialEnvNames });
    this.groups = new Set();
    this.stopped = false;
    this.stopReason = null;
    this.stopPromise = null;
  }

  async taggedProcesses() {
    if (process.platform !== 'linux') return [];
    const candidates = (await linuxProcesses()).filter((row) => !['Z', 'X'].includes(row.state));
    const checks = await Promise.all(candidates.map(async (row) =>
      this.groups.has(row.pgid) || await hasMarker(row.pid, this.taskId) ? row : null));
    return checks.filter(Boolean);
  }

  async hasLiveProcesses() {
    if (process.platform === 'linux') return (await this.taggedProcesses()).length > 0;
    for (const group of this.groups) if (await processGroupAlive(group)) return true;
    return false;
  }

  async signalAll(signal) {
    // Scan for descendants that deliberately opened a new process group on Linux.
    const tagged = await this.taggedProcesses();
    for (const group of this.groups) signalGroup(group, signal);
    for (const row of tagged) if (!this.groups.has(row.pgid)) signalPid(row.pid, signal);
  }

  stop(reason = 'Task stopped.') {
    this.stopped = true;
    this.stopReason ||= reason;
    this.stopPromise ||= (async () => {
      let warned = false;
      const signal = async (name) => {
        try { await this.signalAll(name); }
        catch {
          if (!warned) this.logger.write('[server] Task termination could not yet be confirmed; the queue remains blocked.\n');
          warned = true;
        }
      };
      const alive = async () => {
        try { return await this.hasLiveProcesses(); }
        catch {
          if (!warned) this.logger.write('[server] Process inspection is unavailable; termination is unconfirmed and the queue remains blocked.\n');
          warned = true;
          return true;
        }
      };
      await signal('SIGTERM');
      const deadline = Date.now() + this.terminationGraceMs;
      while (Date.now() < deadline && await alive()) await pause(50);
      while (await alive()) {
        await signal('SIGKILL');
        await pause(50);
      }
    })();
    return this.stopPromise;
  }

  async run(spec, context, secret = '') {
    if (this.stopped) throw new Error(this.stopReason);
    if (process.platform === 'win32') throw new Error('Task process-group control requires Linux or macOS.');
    if (!spec || typeof spec.command !== 'string' || !spec.command.trim()) throw new Error('Processing command is not configured.');
    const args = expandArguments(spec.args, context);
    const cwd = spec.cwd ? expandArguments([spec.cwd], context)[0] : context.work;
    if (secret && [spec.command, cwd, ...args].some((value) => value.includes(secret))) {
      throw new Error('Credentials must be passed through memory-only environment variables, never process arguments.');
    }
    const child = spawn(spec.command, args, { cwd, env: taskEnvironment(context, secret, process.env, this.credentialEnvNames),
      shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    const closed = new Promise((resolve) => child.once('close', resolve));
    const exited = new Promise((resolve) => {
      child.once('error', (error) => { spawnError = error; resolve({ code: null, signal: null }); });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on('data', (chunk) => this.logger.write(chunk));
    child.stderr.on('data', (chunk) => this.logger.write(chunk));
    if (child.pid) {
      this.groups.add(child.pid);
      try { await this.onSpawn(child.pid); }
      catch (error) { await this.stop('Failed to persist task process information.'); throw error; }
    }
    const result = await exited;
    // An exited shell can leave workers alive and stdout open. Keep the task and
    // its deadline active until all descendants are gone, before advancing FIFO.
    while (await this.hasLiveProcesses()) await pause(50);
    await closed;
    if (child.pid) {
      this.groups.delete(child.pid);
      await this.onClear();
    }
    if (this.stopped) throw new Error(this.stopReason);
    if (spawnError) throw new Error(`Unable to start processing command: ${spawnError.message}`);
    if (result.code !== 0) throw new Error(`Processing command exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}.`);
    return result;
  }
}
