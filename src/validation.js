import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './errors.js';

const text = (value, name, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, `${name} is missing or invalid.`);
  return value.trim();
};

function privateAddress(address) {
  const ip = address.toLowerCase();
  if (ip.includes(':')) {
    if (ip.startsWith('::ffff:')) return privateAddress(ip.slice(7));
    return ip === '::' || ip === '::1' || /^(?:fc|fd|fe[89ab]|ff)/.test(ip) || ip.startsWith('2001:db8:');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

export async function validateEndpoint(value, config) {
  const raw = text(value, 'Base URL', 2048);
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'Base URL must be a valid HTTPS URL.'); }
  const explicit = config.remoteAllowedHosts.includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(config.allowInsecureRemote && explicit && url.protocol === 'http:'))) throw new HttpError(400, 'Remote endpoints require HTTPS without embedded credentials, query strings, or fragments.');
  if (config.remoteAllowedHosts.length && !explicit) throw new HttpError(400, 'Remote endpoint is outside the administrator allowlist.');
  // An explicit administrator allowlist also supports encrypted local tunnels.
  if (!explicit) {
    let addresses;
    try { addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }); }
    catch { throw new HttpError(400, 'Remote endpoint hostname could not be resolved.'); }
    if (!addresses.length || addresses.some(x => privateAddress(x.address))) throw new HttpError(400, 'Private endpoints must be configured by the administrator. Use a configured local model.');
  }
  return url.href.replace(/\/$/, '');
}

export async function validateModel(values, config) {
  if (values.mode === 'local') {
    const selected = config.localModels.find(x => x.id === values.localModelId);
    if (!selected) throw new HttpError(400, 'Select an available server-configured vLLM model.');
    if (values.apiKey || values.baseUrl) throw new HttpError(400, 'Local model endpoints and credentials are managed by the server.');
    const key = selected.apiKeyEnv ? process.env[selected.apiKeyEnv] : '';
    if (selected.apiKeyEnv && !key) throw new HttpError(503, 'The local model credential is not configured on the server.');
    return { mode: 'local', localModelId: selected.id, baseUrl: selected.baseUrl, model: selected.model, key: key || '' };
  }
  if (values.mode !== 'remote') throw new HttpError(400, 'Choose remote or local model mode.');
  return { mode: 'remote', localModelId: null, baseUrl: await validateEndpoint(values.baseUrl, config), model: text(values.model, 'Model', 256), key: text(values.apiKey, 'API key', 4096) };
}

export function validatePdf(bytes, name, maxBytes) {
  if (!bytes.length) throw new HttpError(400, 'The PDF is empty.');
  if (bytes.length > maxBytes) throw new HttpError(413, 'PDF exceeds the 75 MB upload limit.');
  if (!/\.pdf$/i.test(name) || !/^%PDF-\d\.\d/.test(bytes.subarray(0, 12).toString('latin1'))) throw new HttpError(400, 'Upload a PDF file with a valid PDF header.');
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString('latin1');
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!match) throw new HttpError(400, 'The PDF trailer is missing or corrupt.');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset >= bytes.length) throw new HttpError(400, 'The PDF cross-reference offset is invalid.');
  const xref = bytes.subarray(offset, offset + 4096).toString('latin1');
  if (!xref.startsWith('xref') && !/^\d+\s+\d+\s+obj[\s\S]*\/Type\s*\/XRef\b/.test(xref)) throw new HttpError(400, 'The PDF cross-reference table is invalid.');
  return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 240);
}

export async function readBody(req, limit) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) { req.resume(); throw new HttpError(413, 'Request exceeds the allowed upload size.'); }
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new HttpError(413, 'Request exceeds the allowed upload size.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function readJson(req, limit = 16384) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Use application/json.');
  try { const value = JSON.parse((await readBody(req, limit)).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON request.'); }
}

export async function readSubmission(req, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  if (!/^multipart\/form-data;.*boundary=/i.test(contentType)) throw new HttpError(415, 'Submit the PDF using multipart/form-data.');
  const body = await readBody(req, maxBytes + 65536);
  let form;
  try { form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData(); }
  catch { throw new HttpError(400, 'The multipart upload is invalid.'); }
  const allowed = new Set(['paper', 'mode', 'baseUrl', 'model', 'apiKey', 'localModelId']);
  for (const field of form.keys()) if (!allowed.has(field) || form.getAll(field).length !== 1) throw new HttpError(400, 'Unexpected or duplicate upload field.');
  const file = form.get('paper');
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'Select one PDF file.');
  const bytes = Buffer.from(await file.arrayBuffer());
  const name = validatePdf(bytes, file.name || '', maxBytes);
  const fields = Object.fromEntries([...allowed].filter(x => x !== 'paper').map(x => [x, form.get(x) || '']));
  if (Object.values(fields).some(x => typeof x !== 'string')) throw new HttpError(400, 'Configuration fields must be text.');
  body.fill(0); // The multipart body can contain the submitted API key.
  return { bytes, name, fields };
}
