import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, publicConfig } from '../src/config.js';
import { expandArguments } from '../src/runner.js';

test('PTC profile builds shell-free task-local commands and requires preflight readiness', () => {
  const config = normalizeConfig({ ptc: { repo: '/tmp/crafter repo', condaEnv: 'ptc', parser: 'pypdf' } });
  assert.equal(config.demo, false);
  assert.equal(config.preprocess.command, 'conda');
  assert.ok(config.preprocess.args.includes('/tmp/crafter repo'));
  assert.ok(config.preprocess.args.includes('preprocess'));
  assert.ok(config.crafter.args.includes('run'));
  assert.equal(config.crafter.args.includes('--skip-debug'), false);
  assert.deepEqual(config.expectedOutputs, ['crafter-manifest.json', 'codebase/requirements.txt']);
  assert.equal(publicConfig(config).integration.ready, false);
  config.integrationStatus = { ready: true };
  assert.equal(publicConfig(config).integration.ready, true);
  assert.equal(publicConfig(config).integration.parser, 'pypdf');
  assert.match(publicConfig(config).integration.message, /scanned pages/);
});

test('task-directory cwd placeholders remain intact until process-context expansion', () => {
  const config = normalizeConfig({ preprocess: { command: 'python', args: [], cwd: '{work}' } });
  assert.equal(config.preprocess.cwd, '{work}');
  assert.deepEqual(expandArguments([config.preprocess.cwd], { work: '/tmp/task work' }), ['/tmp/task work']);
});

test('PTC profile validates environment/parser and only skips debug when explicitly configured', () => {
  assert.throws(() => normalizeConfig({ ptc: { repo: '/tmp/repo', condaEnv: 'ptc --other' } }), /environment/);
  assert.throws(() => normalizeConfig({ ptc: { repo: '/tmp/repo', parser: 'invented' } }), /pypdf or mineru/);
  const config = normalizeConfig({ ptc: { repo: '/tmp/repo', skipDebug: true } });
  assert.ok(config.crafter.args.includes('--skip-debug'));
});
