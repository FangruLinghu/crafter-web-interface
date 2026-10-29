// Explicitly enabled demonstration adapter; this is not the team's paper parser.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const bytes = await readFile(process.env.CRAFTER_INPUT);
if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Demo preprocessing expected a PDF input.');
console.log('[DEMO ONLY] Reading the uploaded PDF; no scientific content is extracted.');
await writeFile(path.join(process.env.CRAFTER_WORK, 'paper.json'), JSON.stringify({
  demo: true, inputBytes: bytes.length, note: 'Synthetic adapter fixture; replace with real paper preprocessing.'
}, null, 2));
