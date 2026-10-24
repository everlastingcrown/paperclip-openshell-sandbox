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
    { ...config, sshExecutable: '' },
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
