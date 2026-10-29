import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const REDACTED = '[REDACTED]';
const TRUNCATED = '[Earlier log entries removed to enforce the configured log limit.]\n';
const SENSITIVE_MARKERS = ['authorization', 'bearer', 'openai_api_key', 'crafter_api_key', 'deepseek_api_key', 'anthropic_api_key', 'minimax_api_key', 'dashscope_api_key', 'api_key', 'api-key', 'apikey', 'access_token', 'access-token'];
const SENSITIVE_MARKER = /\b(?:authorization|bearer|(?:openai|crafter|deepseek|anthropic|minimax|dashscope)_api_key|api[_-]?key|access[_-]?token)\b/i;

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length))].sort((a, b) => b.length - a.length)) text = text.split(secret).join(REDACTED);
  text = text.replace(/\b(Bearer)\s+[^\s"'<>;,]+/gi, '$1 [REDACTED]');
  text = text.replace(/((?:["']?(?:OPENAI_API_KEY|CRAFTER_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|MINIMAX_API_KEY|DASHSCOPE_API_KEY|api[_-]?key|access[_-]?token|authorization)["']?)\s*[:=]\s*)(["']?)([^\r\n"',;}]+)/gi, '$1$2[REDACTED]');
  return text;
}

function utf8Tail(buffer, maximum) {
  if (buffer.length <= maximum) return buffer;
  let start = Math.max(0, buffer.length - maximum);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

export class TaskLogger {
  constructor(path, { maxBytes = 2_000_000, secrets = [] } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError('Log limit must be at least 128 bytes.');
    this.path = path;
    this.maxBytes = maxBytes;
    this.secrets = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length))];
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.tail = Buffer.alloc(0);
    this.truncated = false;
    this.queue = Promise.resolve();
    this.writing = false;
    this.dirty = false;
    this.error = null;
    this.suppressSensitiveLine = false;
    this.closed = false;
    try {
      const existing = Buffer.from(redact(readFileSync(path, 'utf8'), this.secrets));
      if (existing.length > maxBytes) {
        this.truncated = true;
        this.tail = utf8Tail(existing, maxBytes - Buffer.byteLength(TRUNCATED));
      } else this.tail = existing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.timer = setInterval(() => { this.flush().catch(error => { this.error = error; }); }, 1000);
    this.timer.unref();
  }

  write(chunk) {
    if (this.closed) return;
    let text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    if (this.suppressSensitiveLine) {
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      text = text.slice(newline);
      this.suppressSensitiveLine = false;
    }
    this.pending += text;
    this.#drain(false, false);
    if (this.pending.length > Math.max(this.maxBytes, 1_048_576)) this.#drain(false, true);
  }

  #drain(final, partial) {
    let cut = final || partial ? this.pending.length : this.pending.lastIndexOf('\n') + 1;
    if (!final && partial && !this.pending.endsWith('\n')) {
      const lineStart = this.pending.lastIndexOf('\n') + 1;
      const trailingLine = this.pending.slice(lineStart);
      const marker = SENSITIVE_MARKER.exec(trailingLine);
      if (marker) {
        cut = lineStart + marker.index;
        if (this.pending.length - cut > Math.max(this.maxBytes, 1_048_576)) {
          this.pending = this.pending.slice(0, cut) + '[Sensitive log field omitted: oversized entry]\n';
          this.suppressSensitiveLine = true;
          cut = this.pending.length;
        }
      } else {
        const lowercase = trailingLine.toLowerCase();
        for (const token of SENSITIVE_MARKERS) {
          for (let length = Math.min(token.length - 1, lowercase.length); length > 0; length--) {
            if (lowercase.endsWith(token.slice(0, length))) { cut = Math.min(cut, this.pending.length - length); break; }
          }
        }
      }
    }
    if (!final && cut) {
      // Retain a suffix that might become a credential when the next chunk arrives.
      for (const secret of this.secrets) {
        for (let length = Math.min(secret.length - 1, cut); length > 0; length--) {
          if (this.pending.slice(cut - length, cut) === secret.slice(0, length)) { cut -= length; break; }
        }
      }
      // Do not split an already complete credential when the boundary moved.
      let moved;
      do {
        moved = false;
        for (const secret of this.secrets) {
          let index = this.pending.indexOf(secret);
          while (index >= 0 && index < cut) {
            if (index + secret.length > cut) { cut = index; moved = true; break; }
            index = this.pending.indexOf(secret, index + secret.length);
          }
        }
      } while (moved);
    }
    if (!cut) return;
    let ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    if (final) {
      for (const secret of this.secrets) {
        for (let length = Math.min(secret.length - 1, ready.length); length >= Math.min(4, secret.length); length--) {
          if (ready.endsWith(secret.slice(0, length))) { ready = ready.slice(0, -length) + REDACTED; break; }
        }
      }
    }
    const clean = Buffer.from(redact(ready, this.secrets));
    this.tail = Buffer.concat([this.tail, clean]);
    const noticeBytes = Buffer.byteLength(TRUNCATED);
    const available = this.truncated ? this.maxBytes - noticeBytes : this.maxBytes;
    if (this.tail.length > available) {
      this.truncated = true;
      this.tail = utf8Tail(this.tail, this.maxBytes - noticeBytes);
    }
    this.#save();
  }

  #save() {
    this.dirty = true;
    if (this.writing || this.error) return;
    this.writing = true;
    this.queue = (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      while (this.dirty) {
        this.dirty = false;
        const snapshot = this.truncated ? Buffer.concat([Buffer.from(TRUNCATED), this.tail]) : Buffer.from(this.tail);
        const temporary = `${this.path}.next-${randomUUID()}`;
        try {
          await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }); }
      }
    })().catch(error => { this.error = error; throw error; }).finally(() => {
      this.writing = false;
      if (this.dirty && !this.error) this.#save();
    });
    this.queue.catch(() => {});
  }

  async flush() {
    this.#drain(false, true);
    if (this.error) throw this.error;
    while (this.writing || this.dirty) await this.queue;
  }

  async close() {
    if (this.closed) return this.queue;
    this.pending += this.decoder.end();
    this.#drain(true, true);
    this.closed = true;
    clearInterval(this.timer);
    try {
      if (this.error) throw this.error;
      while (this.writing || this.dirty) await this.queue;
    } finally { this.secrets.length = 0; }
  }
}
