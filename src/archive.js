import { createReadStream } from 'node:fs';
import { HttpError } from './errors.js';

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (crc, bytes) => { for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return crc >>> 0; };
const u16 = (buffer, offset, value) => buffer.writeUInt16LE(value, offset);
const u32 = (buffer, offset, value) => buffer.writeUInt32LE(value >>> 0, offset);

// ZIP method 0 and data descriptors permit streaming without archive temp files.
export async function streamArchive(res, files, taskId, entries) {
  if (entries.length > 65535 || entries.reduce((n, x) => n + x.size + Buffer.byteLength(x.path) * 2 + 128, 22) >= 0xffffffff) throw new HttpError(413, 'This result exceeds the supported streaming ZIP size. Download individual files.');
  const central = []; let offset = 0;
  const write = async bytes => {
    if (res.destroyed) throw new Error('Download disconnected.');
    offset += bytes.length;
    if (!res.write(bytes)) await new Promise((resolve, reject) => {
      const cleanup = () => { res.off('drain', drained); res.off('close', disconnected); res.off('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const disconnected = () => { cleanup(); reject(new Error('Download disconnected.')); };
      const failed = error => { cleanup(); reject(error); };
      res.once('drain', drained); res.once('close', disconnected); res.once('error', failed);
      if (res.destroyed) disconnected();
    });
  };
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="crafter-${taskId}.zip"` });
  for (const entry of entries) {
    const path = await files.outputPath(taskId, entry.path);
    const name = Buffer.from(entry.path); const start = offset;
    const header = Buffer.alloc(30);
    u32(header, 0, 0x04034b50); u16(header, 4, 20); u16(header, 6, 0x0808); u16(header, 26, name.length);
    await write(header); await write(name);
    let crc = 0xffffffff; let size = 0;
    const stream = createReadStream(path);
    const cancel = () => stream.destroy(new Error('Download disconnected.'));
    res.once('close', cancel);
    try { for await (const bytes of stream) { crc = crc32(crc, bytes); size += bytes.length; await write(bytes); } }
    finally { res.off('close', cancel); stream.destroy(); }
    if (size !== entry.size) throw new Error('Published output changed during ZIP generation.');
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    u32(descriptor, 0, 0x08074b50); u32(descriptor, 4, crc); u32(descriptor, 8, size); u32(descriptor, 12, size);
    await write(descriptor);
    const record = Buffer.alloc(46);
    u32(record, 0, 0x02014b50); u16(record, 4, 20); u16(record, 6, 20); u16(record, 8, 0x0808);
    u32(record, 16, crc); u32(record, 20, size); u32(record, 24, size); u16(record, 28, name.length); u32(record, 42, start);
    central.push(record, name);
  }
  const start = offset;
  for (const bytes of central) await write(bytes);
  const end = Buffer.alloc(22);
  u32(end, 0, 0x06054b50); u16(end, 8, entries.length); u16(end, 10, entries.length);
  u32(end, 12, offset - start); u32(end, 16, start);
  await write(end); res.end();
}
