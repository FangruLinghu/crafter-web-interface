// Explicitly enabled demonstration adapter; never used by production defaults.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const delay = Number(process.argv.find((arg) => arg.startsWith('--delay-ms='))?.split('=')[1] ?? 1000);
console.log('[DEMO ONLY] Synthetic Crafter fixture; no model API is called and no paper is implemented.');
await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delay) ? Math.max(delay, 0) : 1000));
await writeFile(path.join(process.env.CRAFTER_OUTPUT, 'README.md'), '# Demonstration output\n\nThis synthetic fixture verifies the web workflow only. Replace both configured adapters with the real paper preprocessor and Crafter script. No model was called; the scientific paper has not been implemented.\n');
await writeFile(path.join(process.env.CRAFTER_OUTPUT, 'generated_code.py'), '"""DEMO ONLY: placeholder output, not a paper implementation."""\n\nif __name__ == "__main__":\n    print("Crafter web workflow demonstration")\n');
await writeFile(path.join(process.env.CRAFTER_OUTPUT, 'run_metadata.json'), JSON.stringify({ demo: true,
  taskId: process.env.CRAFTER_TASK_ID, model: process.env.CRAFTER_MODEL, baseUrl: process.env.CRAFTER_BASE_URL }, null, 2));
if (process.argv.includes('--fail')) {
  console.error('[DEMO ONLY] Requested fixture failure; retained files are partial.');
  process.exitCode = 1;
} else console.log('[DEMO ONLY] Synthetic output files written.');
