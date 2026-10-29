import { setTimeout as pause } from 'node:timers/promises';

export function samplePdf(label = 'Crafter web acceptance fixture') {
  const escaped = label.replace(/[()\\]/g, char => `\\${char}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

export async function eventually(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(25); }
  throw new Error('Timed out waiting for the expected task state.');
}

export function upload(bytes = samplePdf(), fields = { mode: 'local', localModelId: 'fixture' }) {
  const form = new FormData();
  form.set('paper', new Blob([bytes], { type: 'application/pdf' }), 'fixture.pdf');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}
