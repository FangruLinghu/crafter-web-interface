import { readFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  host: '127.0.0.1', port: 3000, dataDir: 'var',
  maxUploadBytes: 75_000_000, taskTimeoutMs: 3_600_000,
  terminationGraceMs: 5_000, monitorIntervalMs: 1_000, pollIntervalMs: 2_000,
  logMaxBytes: 2_000_000, maxTaskBytes: 2_000_000_000,
  maxTotalBytes: 10_000_000_000, minFreeBytes: 1_000_000_000,
  maxPreviewBytes: 262_144, localModels: [], expectedOutputs: [],
  preprocess: null, crafter: null, demo: false,
  remoteAllowedHosts: [], allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
  allowInsecureRemote: false, tlsCert: null, tlsKey: null, publicOrigin: null,
  ptc: null,
};

export function normalizeConfig(values = {}) {
  const config = { ...defaults, ...values };
  if (config.ptc) {
    const profile = config.ptc;
    if (typeof profile.repo !== 'string' || !profile.repo.trim()) throw new Error('Configure the Crafter repository path.');
    const repo = resolve(profile.repo.startsWith('~/') ? resolve(homedir(), profile.repo.slice(2)) : resolve(PROJECT_ROOT, profile.repo));
    const condaEnv = profile.condaEnv || 'ptc';
    if (!/^[A-Za-z0-9_.-]+$/.test(condaEnv)) throw new Error('Invalid Crafter conda environment name.');
    const parser = profile.parser === undefined ? 'mineru' : profile.parser;
    if (parser !== 'mineru') throw new Error('MinerU is the only supported paper preprocessing parser.');
    const command = profile.condaExecutable || 'conda';
    const adapter = resolve(PROJECT_ROOT, 'adapters/ptc_adapter.py');
    const prefix = ['run', '--no-capture-output', '-n', condaEnv, 'python', '-B', adapter];
    config.ptc = { ...profile, repo, condaEnv, parser, condaExecutable: command };
    config.integrationCheck = { command, args: [...prefix, 'check', '--repo', repo], cwd: PROJECT_ROOT };
    config.preprocess = { command, args: [...prefix, 'preprocess', '--repo', repo, '--parser', parser], cwd: '{work}' };
    config.crafter = { command, args: [...prefix, 'run', '--repo', repo, ...(profile.skipDebug ? ['--skip-debug'] : [])], cwd: '{work}' };
    config.expectedOutputs = ['crafter-manifest.json', 'codebase/requirements.txt'];
    config.demo = false;
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error('Bind to loopback and use SSH forwarding or a restricted HTTPS reverse proxy.');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  for (const name of ['maxUploadBytes', 'taskTimeoutMs', 'terminationGraceMs', 'monitorIntervalMs', 'pollIntervalMs', 'logMaxBytes', 'maxTaskBytes', 'maxTotalBytes', 'maxPreviewBytes']) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`${name} must be a positive integer.`);
  }
  if (config.maxUploadBytes > 75_000_000) throw new Error('The proposal limits PDFs to 75 MB (75,000,000 bytes).');
  if (!Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes < 0) throw new Error('Invalid minFreeBytes.');
  if (config.logMaxBytes < 512) throw new Error('logMaxBytes must be at least 512.');
  config.dataDir = resolve(PROJECT_ROOT, config.dataDir);
  for (const name of ['preprocess', 'crafter']) {
    const command = config[name];
    if (!command) continue;
    if (typeof command.command !== 'string' || !command.command.trim() || command.command.includes('\0') || !Array.isArray(command.args) || command.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error(`Invalid ${name} command.`);
    const cwd = /^\{(?:work|output)\}$/.test(command.cwd || '') ? command.cwd : resolve(PROJECT_ROOT, command.cwd || '.');
    config[name] = { ...command, command: command.command === '{node}' ? process.execPath : command.command, cwd };
    for (const arg of command.args) {
      if (/\{(?:apiKey|key|secret)\}/i.test(arg)) throw new Error('Credentials must be passed in memory through the child environment, never arguments.');
    }
  }
  for (const name of ['remoteAllowedHosts', 'allowedHosts', 'expectedOutputs', 'localModels']) if (!Array.isArray(config[name])) throw new Error(`${name} must be an array.`);
  for (const item of config.expectedOutputs) {
    if (typeof item !== 'string' || isAbsolute(item) || item.split(/[\\/]/).some(x => x === '..' || x.startsWith('.')) || item.includes('\0')) throw new Error('Expected outputs must be safe relative paths.');
  }
  const ids = new Set();
  for (const model of config.localModels) {
    if (!model || typeof model.id !== 'string' || !/^[\w.-]{1,80}$/.test(model.id) || ids.has(model.id) || typeof model.model !== 'string' || !model.model.trim()) throw new Error('Invalid or duplicate local model.');
    ids.add(model.id);
    const url = new URL(model.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid local endpoint.');
    if ('apiKey' in model) throw new Error('Configure local API credentials with apiKeyEnv, not persistent keys.');
    if (model.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) throw new Error('Invalid local credential environment variable.');
  }
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) throw new Error('Configure both TLS certificate and private-key paths.');
  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('publicOrigin must be an HTTPS origin without a path.');
    config.publicOrigin = origin.origin;
  }
  return config;
}

export async function loadConfig(overrides = {}) {
  const filename = process.env.CRAFTER_CONFIG || 'config/server.json';
  let values = {};
  try { values = JSON.parse(await readFile(resolve(PROJECT_ROOT, filename), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || process.env.CRAFTER_CONFIG) throw error; }
  if (process.env.PORT) values.port = Number(process.env.PORT);
  if (process.env.CRAFTER_DATA_DIR) values.dataDir = process.env.CRAFTER_DATA_DIR;
  return normalizeConfig({ ...values, ...overrides });
}

export function publicConfig(config) {
  const ready = Boolean(config.preprocess && config.crafter) && (!config.ptc || config.integrationStatus?.ready === true);
  const message = config.ptc
    ? config.integrationStatus?.ready
      ? 'Crafter repository is connected and real MinerU preprocessing is configured. Parser model files and an actual parser run have not yet been verified. Independent figure analysis is disabled in this single-model profile.'
      : config.integrationStatus?.message || 'Checking the Crafter repository and Python environment.'
    : config.demo ? 'Demo adapter: tests the workflow without calling a model or implementing a research paper.' : ready ? 'Crafter commands are configured. Live model and generation acceptance still need to be verified.' : 'Configure paper preprocessing and the real Crafter command in the server settings before submitting.';
  return {
    localModels: config.localModels.map(({ id, label, model }) => ({ id, label: label || model, model })),
    limits: Object.fromEntries(['maxUploadBytes', 'taskTimeoutMs', 'maxTaskBytes', 'maxTotalBytes', 'minFreeBytes', 'logMaxBytes', 'pollIntervalMs'].map(key => [key, config[key]])),
    integration: { ready, demo: Boolean(config.demo), message, ...(config.ptc ? { adapter: 'ptc', parser: config.ptc.parser } : {}) },
  };
}
