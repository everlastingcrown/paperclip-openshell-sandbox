import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, parseConfig } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import { parseCleanupRecovery } from '../src/recovery.js';
import { config } from './helpers.js';
test('configuration defaults and required fields', () => {
  assert.deepEqual(parseConfig({ gateway: 'g', image: 'i' }), {
    executable: 'openshell',
    sshExecutable: 'ssh',
    enableDuplex: false,
    configHome: undefined,
    gateway: 'g',
    workspace: 'default',
    image: 'i',
    policyFile: undefined,
    providers: [],
    timeoutMs: 300000,
    reuseLease: false,
  });
  for (const c of [
    { image: 'i' },
    { gateway: 'g' },
    { ...config, timeoutMs: 0 },
    { ...config, reuseLease: 'yes' },
    { ...config, enableDuplex: 'true' },
    { ...config, enableDuplex: null },
    { ...config, sshExecutable: '\0' },
    { ...config, providers: [4] },
    { ...config, gateway: '-g' },
    { ...config, configHome: 'relative/config' },
  ])
    assert.throws(() => parseConfig(c));
});
test('cleared optional text fields are treated as unspecified', () => {
  const defaults = parseConfig(config);
  for (const field of ['configHome', 'policyFile']) {
    for (const value of ['', ' \t\n'])
      assert.deepEqual(parseConfig({ ...config, [field]: value }), defaults);
    for (const value of [null, false, {}, '\0'])
      assert.throws(() => parseConfig({ ...config, [field]: value }));
  }
  assert.equal('minLength' in configSchema.properties.configHome, false);
  for (const field of ['gateway', 'image'])
    assert.throws(() => parseConfig({ ...config, [field]: '' }));
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

test('clearing defaulted fields restores defaults without accepting invalid values', () => {
  const base = { gateway: 'g', image: 'i' };
  for (const field of [
    'executable',
    'sshExecutable',
    'workspace',
    'timeoutMs',
  ]) {
    for (const value of ['', ' \t\n', undefined])
      assert.deepEqual(
        parseConfig({ ...base, [field]: value }),
        parseConfig(base),
      );
    for (const value of [false, {}, [], '\0'])
      assert.throws(() => parseConfig({ ...base, [field]: value }));
  }
  for (const timeoutMs of [0, 999, 86400001, 1.5, '300000'])
    assert.throws(() => parseConfig({ ...base, timeoutMs }));
});

test('workload choice accepts a cleared alternative and requires exactly one source', async () => {
  const validate = (config: Record<string, unknown>) =>
    createPlugin().definition.onEnvironmentValidateConfig!({
      driverKey: 'openshell',
      config,
    });
  for (const blank of ['', ' \t\n', undefined]) {
    const template = { gateway: 'g', template: 'runtime', image: blank };
    assert.equal(parseConfig(template).template, 'runtime');
    assert.equal(parseConfig(template).image, '');
    assert.equal((await validate(template)).ok, true);
    const image = { gateway: 'g', image: 'runtime:tag', template: blank };
    assert.equal(parseConfig(image).image, 'runtime:tag');
    assert.equal(parseConfig(image).template, undefined);
    assert.equal((await validate(image)).ok, true);
    const empty = { gateway: 'g', template: blank, image: blank };
    assert.throws(() => parseConfig(empty));
    assert.equal((await validate(empty)).ok, false);
  }
  for (const config of [
    { gateway: 'g', template: 'runtime', image: 'runtime:tag' },
    { gateway: 'g', template: 'runtime', image: null },
    { gateway: 'g', template: 'runtime', image: false },
  ]) {
    assert.throws(() => parseConfig(config));
    assert.equal((await validate(config)).ok, false);
  }
});

test('cleanup recovery accepts cleared default and optional fields', () => {
  const entry = { environmentId: 'environment', gateway: 'test' };
  for (const blank of ['', ' \t\n', undefined])
    assert.deepEqual(
      parseCleanupRecovery({
        cleanupRecovery: [{ ...entry, workspace: blank, configHome: blank }],
      }),
      parseCleanupRecovery({ cleanupRecovery: [entry] }),
    );
});
