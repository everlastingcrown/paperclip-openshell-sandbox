import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configSchema, parseConfig } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import { parseCleanupRecovery } from '../src/recovery.js';
import { config, ok, fake, release } from './helpers.js';
test('configuration defaults and required fields', () => {
  assert.deepEqual(parseConfig({ gateway: 'g', image: 'i' }), {
    executable: 'openshell',
    configHome: undefined,
    gateway: 'g',
    workspace: 'default',
    image: 'i',
    policy: undefined,
    policyFile: undefined,
    providers: [],
    cpu: undefined,
    memory: undefined,
    timeoutMs: 300000,
    reuseLease: false,
  });
  for (const c of [
    { image: 'i' },
    { gateway: 'g' },
    { ...config, timeoutMs: 0 },
    { ...config, reuseLease: 'yes' },
    { ...config, providers: [4] },
    { ...config, cpu: 'bad' },
    { ...config, memory: 'bad' },
    { ...config, gateway: '-g' },
    { ...config, configHome: 'relative/config' },
    { ...config, policy: 'version: 1', policyFile: '/policy.yaml' },
  ])
    assert.throws(() => parseConfig(c));
});
test('cleared optional text fields are treated as unspecified', () => {
  const defaults = parseConfig(config);
  for (const field of ['configHome', 'policy', 'policyFile', 'cpu', 'memory']) {
    for (const value of ['', ' \t\n'])
      assert.deepEqual(parseConfig({ ...config, [field]: value }), defaults);
    for (const value of [null, false, {}, '\0'])
      assert.throws(() => parseConfig({ ...config, [field]: value }));
  }
  assert.equal('minLength' in configSchema.properties.configHome, false);
  for (const field of ['gateway', 'image'])
    assert.throws(() => parseConfig({ ...config, [field]: '' }));
});
test('policy presets preserve text and direct inputs require migration', () => {
  const policy = '\nversion: 1\n# Unicode: café\n';
  assert.equal(
    parseConfig(
      { ...config, policyPreset: 'test' },
      {
        policies: { test: policy },
      },
    ).policy,
    policy,
  );
  for (const raw of [{ policy }, { policyFile: '/policy.yaml' }])
    assert.throws(() => parseConfig({ ...config, ...raw }), /Move policy/);
  assert.equal('policy' in configSchema.properties, false);
  assert.equal('policyFile' in configSchema.properties, false);
});
test('inline policies use private, distinct files removed after creation', async () => {
  const policy = '\nversion: 1\n# Unicode: café\n';
  const fixtures = [
    fake({ policyPreset: 'test' }, { policies: { test: policy } }),
    fake({ policyPreset: 'test' }, { policies: { test: policy } }),
  ];
  const paths: string[] = [];
  for (const f of fixtures)
    f.fail(async (args) => {
      if (!args.includes('create')) return;
      const path = args[args.indexOf('--policy') + 1];
      paths.push(path);
      assert.equal(await readFile(path, 'utf8'), policy);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      return undefined;
    });
  const leases = await Promise.all(
    fixtures.map((f) => f.provider.acquire(f.params)),
  );
  assert.equal(new Set(paths).size, 2);
  for (const path of paths)
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
  for (const [index, f] of fixtures.entries()) {
    assert.equal(JSON.stringify(leases[index]).includes(policy), false);
    await f.provider.destroy(release(f, leases[index]));
  }
});
test('inline policy files are removed when creation fails', async () => {
  for (const throws of [false, true]) {
    const f = fake(
      { policyPreset: 'test' },
      { policies: { test: 'version: 1\n# private-policy-value\n' } },
    );
    let path = '';
    f.fail((args) => {
      if (!args.includes('create')) return;
      path = args[args.indexOf('--policy') + 1];
      if (throws) throw new Error('CLI failed');
      return { ...ok(), exitCode: 1, stderr: 'private-policy-value' };
    });
    await assert.rejects(f.provider.acquire(f.params), (error: Error) => {
      assert.equal(error.message.includes('private-policy-value'), false);
      return true;
    });
    assert.ok(path);
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
  }
});
test('cleanup recovery validates operator inputs', async () => {
  assert.deepEqual(parseCleanupRecovery({}), []);
  const entry = { environmentId: 'environment', gateway: 'test' };
  for (const cleanupRecovery of [
    'invalid',
    [null],
    [{ ...entry, configHome: 'relative' }],
    [{ ...entry, rejectedAttemptIds: ['pc-name'] }],
    [entry, entry],
    [{ ...entry, gateway: 'bad gateway' }],
    [{ ...entry, unexpected: true }],
  ]) {
    assert.throws(() => parseCleanupRecovery({ cleanupRecovery }), /Invalid/);
    assert.equal(
      (await createPlugin().definition.onValidateConfig!({ cleanupRecovery }))
        .ok,
      false,
    );
  }
});
