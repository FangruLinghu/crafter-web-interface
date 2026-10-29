import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, publicConfig } from '../src/config.js';
import { expandArguments } from '../src/runner.js';
import { checkIntegration } from '../src/integration.js';

test('PTC profile builds shell-free task-local commands and requires preflight readiness', () => {
  const config = normalizeConfig({ ptc: { repo: '/tmp/crafter repo', condaEnv: 'ptc' } });
  assert.equal(config.demo, false);
  assert.equal(config.preprocess.command, 'conda');
  assert.ok(config.preprocess.args.includes('/tmp/crafter repo'));
  assert.ok(config.preprocess.args.includes('preprocess'));
  assert.equal(config.ptc.parser, 'mineru');
  assert.equal(config.preprocess.args[config.preprocess.args.indexOf('--parser') + 1], 'mineru');
  assert.ok(config.crafter.args.includes('run'));
  assert.equal(config.crafter.args.includes('--skip-debug'), false);
  assert.deepEqual(config.expectedOutputs, ['crafter-manifest.json', 'codebase/requirements.txt']);
  assert.equal(publicConfig(config).integration.ready, false);
  config.integrationStatus = { ready: true };
  assert.equal(publicConfig(config).integration.ready, true);
  assert.equal(publicConfig(config).integration.parser, 'mineru');
  assert.match(publicConfig(config).integration.message, /real MinerU preprocessing/);
  assert.match(publicConfig(config).integration.message, /have not yet been verified/);
  assert.match(publicConfig(config).integration.message, /Independent figure analysis is disabled/);
});

test('task-directory cwd placeholders remain intact until process-context expansion', () => {
  const config = normalizeConfig({ preprocess: { command: 'python', args: [], cwd: '{work}' } });
  assert.equal(config.preprocess.cwd, '{work}');
  assert.deepEqual(expandArguments([config.preprocess.cwd], { work: '/tmp/task work' }), ['/tmp/task work']);
});

test('PTC profile validates environment/parser and only skips debug when explicitly configured', () => {
  assert.throws(() => normalizeConfig({ ptc: { repo: '/tmp/repo', condaEnv: 'ptc --other' } }), /environment/);
  for (const parser of ['invented', '', null]) assert.throws(() => normalizeConfig({ ptc: { repo: '/tmp/repo', parser } }), /MinerU is the only supported/);
  const config = normalizeConfig({ ptc: { repo: '/tmp/repo', skipDebug: true } });
  assert.ok(config.crafter.args.includes('--skip-debug'));
});

async function checkedProfile(result) {
  const config = normalizeConfig({ ptc: { repo: '/tmp/repo' } });
  config.integrationCheck = {
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(result))})`],
    cwd: process.cwd(),
  };
  await checkIntegration(config);
  return config;
}

test('MinerU readiness requires its dependency, capability and parser identity', async () => {
  const result = { ready: true, dependencies: { mineru: true }, capabilities: { mineru: true }, parser: 'mineru', parser_models_verified: false };
  const config = await checkedProfile(result);
  assert.equal(config.integrationStatus.ready, true);
  assert.equal(config.integrationStatus.details.parser_models_verified, false);
  assert.equal(publicConfig(config).integration.ready, true);
  assert.match(publicConfig(config).integration.message, /have not yet been verified/);
  for (const invalid of [
    { ...result, dependencies: { mineru: false } },
    { ...result, capabilities: {} },
    { ...result, parser: 'text-only' },
  ]) {
    const unavailable = await checkedProfile(invalid);
    assert.equal(unavailable.integrationStatus.ready, false);
    assert.equal(unavailable.ptc.parser, 'mineru');
    assert.equal(unavailable.preprocess.args[unavailable.preprocess.args.indexOf('--parser') + 1], 'mineru');
  }
});
