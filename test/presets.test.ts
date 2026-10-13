import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlugin } from '../src/plugin.js';
import { parseConfig, configSchema } from '../src/config.js';
import { parsePluginConfig } from '../src/presets.js';
import manifest from '../src/manifest.js';
import { config, fake, release } from './helpers.js';

const policy = 'version: 1\n# private-preset-value\n';
const settings = {
  policies: { development: policy, other: 'version: 1\n# other\n' },
  profiles: {
    standard: {
      ...config,
      policyPreset: 'development',
      providers: ['github'],
      memory: '4Gi',
      reuseLease: true,
    },
    partial: { memory: '2Gi' },
  },
};

test('Paperclip provider routing works with profiles through probe and lifecycle', async () => {
  const raw = { provider: 'openshell', profile: 'standard' };
  assert.deepEqual(
    parseConfig(raw, settings),
    parseConfig({ profile: 'standard' }, settings),
  );
  const f = fake(raw, settings);
  const plugin = createPlugin(f.provider);
  const validated = await plugin.definition.onEnvironmentValidateConfig!({
    driverKey: 'openshell',
    config: raw,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.normalizedConfig, raw);
  assert.equal((await f.provider.probe(f.params)).ok, true);
  const lease = await f.provider.acquire(f.params);
  await f.provider.destroy(release(f, lease));
  assert.equal(f.record, undefined);
});

test('environment validation names unknown fields without including values', async () => {
  const f = fake(
    { profile: 'standard', typo: 'private-value', extra: 'private-value' },
    settings,
  );
  const result = await f.provider.probe(f.params);
  assert.equal(result.ok, false);
  assert.equal(
    result.summary,
    'Unknown environment configuration fields: "typo", "extra"',
  );
  assert.equal(JSON.stringify(result).includes('private-value'), false);
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => parseConfig({ ...config, provider: 'other' }),
    /Invalid environment provider/,
  );
});

test('profiles merge explicit overrides before applying defaults', () => {
  const resolved = parseConfig(
    {
      profile: 'standard',
      providers: [],
      memory: '8Gi',
      reuseLease: false,
      policyPreset: 'other',
    },
    settings,
  );
  assert.equal(resolved.gateway, 'test');
  assert.equal(resolved.image, 'runtime:test');
  assert.equal(resolved.workspace, 'default');
  assert.deepEqual(resolved.providers, []);
  assert.equal(resolved.memory, '8Gi');
  assert.equal(resolved.reuseLease, false);
  assert.equal(resolved.policy, settings.policies.other);
  assert.equal(
    parseConfig({ profile: 'standard', memory: '', policyPreset: '' }, settings)
      .memory,
    '4Gi',
  );
  assert.equal(
    parseConfig({ profile: 'standard', memory: '', policyPreset: '' }, settings)
      .policy,
    policy,
  );
  assert.equal(
    parseConfig({ ...config, profile: 'partial' }, settings).memory,
    '2Gi',
  );
  assert.throws(
    () => parseConfig({ profile: 'partial' }, settings),
    /Invalid gateway/,
  );
  assert.equal(parseConfig(config, settings).policy, undefined);
  assert.equal(
    parseConfig({ ...config, policyPreset: 'development' }, settings).policy,
    policy,
  );
});

test('preset configuration rejects malformed settings without leaking YAML', async () => {
  const invalid = [
    { policies: null },
    { policies: [] },
    { policies: { 'bad name': policy } },
    { policies: { test: '' } },
    { policies: { test: '  ' } },
    { policies: { test: 42 } },
    { policies: { test: '\0' } },
    { profiles: null },
    { profiles: [] },
    { profiles: { test: null } },
    { profiles: { 'bad/name': {} } },
    { profiles: { test: { profile: 'other' } } },
    { profiles: { test: { policy } } },
    { profiles: { test: { policyFile: '/file' } } },
    { profiles: { test: { policyPreset: 'missing' } } },
    { profiles: { test: { memory: 'bad' } } },
    { profiles: { test: { providers: [42] } } },
    { profiles: { test: { gateway: 'bad gateway' } } },
    { profiles: { test: { unknown: true } } },
    { unexpected: true },
  ];
  for (const value of invalid) {
    assert.throws(() => parsePluginConfig(value));
    const result = await createPlugin().definition.onValidateConfig!(value);
    assert.equal(result.ok, false);
    assert.equal(
      JSON.stringify(result).includes('private-preset-value'),
      false,
    );
  }
  assert.equal(
    (await createPlugin().definition.onValidateConfig!(settings)).ok,
    true,
  );
  assert.equal(
    (await createPlugin().definition.onValidateConfig!({})).ok,
    true,
  );
});

test('unknown references and legacy policies fail before CLI calls', async () => {
  for (const extra of [
    { profile: 'missing' },
    { policyPreset: 'missing' },
    { profile: 'constructor' },
    { policyPreset: 'toString' },
    { profile: '../invalid' },
    { policyPreset: 42 },
    { policy },
    { policyFile: '/private/path' },
  ]) {
    const f = fake(extra, settings);
    await assert.rejects(f.provider.acquire(f.params));
    assert.equal((await f.provider.probe(f.params)).ok, false);
    assert.equal(f.calls.length, 0);
  }
  const inherited = Object.create({ development: policy });
  assert.throws(
    () =>
      parseConfig(
        { ...config, policyPreset: 'development' },
        { policies: inherited },
      ),
    /Unknown policyPreset/,
  );
  assert.throws(
    () =>
      parseConfig(
        { profile: 'standard' },
        { profiles: Object.create(settings.profiles) },
      ),
    /Unknown profile/,
  );
});

test('save validation needs no company settings and persists only explicit references', async () => {
  const f = fake();
  const plugin = createPlugin(f.provider);
  const companies: (string | undefined)[] = [];
  await plugin.definition.setup({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      async get(companyId?: string) {
        companies.push(companyId);
        if (!companyId) throw new Error('company context is required');
        return settings;
      },
    },
  } as any);
  const raw = { profile: 'standard', memory: '8Gi' };
  const result = await plugin.definition.onEnvironmentValidateConfig!({
    driverKey: 'openshell',
    config: raw,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalizedConfig, raw);
  assert.deepEqual(companies, []);
  assert.equal(JSON.stringify(result).includes(policy), false);
  assert.equal(
    (await plugin.definition.onEnvironmentProbe!({ ...f.params, config: raw }))
      .ok,
    true,
  );
  assert.deepEqual(companies, ['company']);
  assert.equal(configSchema.required.length, 0);
  assert.equal('default' in configSchema.properties.reuseLease, false);
  assert.ok(manifest.instanceConfigSchema?.properties);
});

test('save validation checks fields and defers reference lookup to scoped operations', async () => {
  const f = fake();
  const plugin = createPlugin(f.provider);
  const companies: string[] = [];
  await plugin.definition.setup({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      async get(companyId?: string) {
        assert.ok(companyId, 'company context is required');
        companies.push(companyId);
        return {};
      },
    },
  } as any);
  for (const raw of [
    config,
    { profile: 'missing' },
    { ...config, policyPreset: 'missing' },
    { profile: 'missing', policyPreset: 'missing', reuseLease: false },
  ]) {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: 'openshell',
      config: raw,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.normalizedConfig, raw);
  }
  for (const raw of [
    {},
    { policyPreset: 'development' },
    { profile: '../invalid' },
    { ...config, policyPreset: 42 },
    { profile: 'standard', memory: 'bad' },
    { profile: 'standard', timeoutMs: 0 },
    { profile: 'standard', gateway: 'bad gateway' },
    { profile: 'standard', image: 'curlimages/curl' },
    { profile: 'standard', providers: [42] },
    { profile: 'standard', unknown: true },
    { ...config, policy },
    { ...config, policyFile: '/private/policy.yaml' },
  ]) {
    assert.equal(
      (
        await plugin.definition.onEnvironmentValidateConfig!({
          driverKey: 'openshell',
          config: raw,
        })
      ).ok,
      false,
      JSON.stringify(raw),
    );
  }
  assert.deepEqual(companies, []);
  for (const raw of [
    { profile: 'missing' },
    { ...config, policyPreset: 'missing' },
  ]) {
    const params = { ...f.params, config: raw };
    assert.equal(
      (await plugin.definition.onEnvironmentProbe!(params)).ok,
      false,
    );
    await assert.rejects(
      plugin.definition.onEnvironmentAcquireLease!(params),
      /Unknown (profile|policyPreset)/,
    );
  }
  assert.deepEqual(companies, ['company', 'company', 'company', 'company']);
  assert.equal(f.calls.length, 0);
});

test('company settings and policy edits are resolved on each allocation', async () => {
  const f = fake({ policyPreset: 'development' });
  let current = policy;
  const companies: string[] = [];
  f.provider.setPluginConfig(async (company) => {
    companies.push(company);
    return {
      policies: {
        development:
          company === 'company' ? current : 'version: 1\n# second company\n',
      },
    };
  });
  const observed: string[] = [];
  f.fail(async (args) => {
    if (args[5] === 'create')
      observed.push(await readFile(args[args.indexOf('--policy') + 1], 'utf8'));
    return undefined;
  });
  for (const companyId of ['company', 'other-company', 'company']) {
    const params = { ...f.params, companyId };
    const lease = await f.provider.acquire(params);
    assert.equal(JSON.stringify(lease).includes('private-preset-value'), false);
    await f.provider.destroy({ ...release(f, lease), companyId });
    current = 'version: 1\n# edited\n';
  }
  assert.deepEqual(observed, [
    policy,
    'version: 1\n# second company\n',
    current,
  ]);
  assert.deepEqual(companies, [
    'company',
    'company',
    'other-company',
    'other-company',
    'company',
    'company',
  ]);
});

test('removed policies do not prevent stop or destroy of profile leases', async () => {
  const f = fake({ profile: 'standard' }, settings);
  let current: Record<string, unknown> = settings;
  f.provider.setPluginConfig(async () => current);
  const lease = await f.provider.acquire(f.params);
  current = { policies: {}, profiles: settings.profiles };
  await assert.rejects(f.provider.acquire(f.params), /Unknown policyPreset/);
  await f.provider.stop(release(f, lease));
  assert.equal(f.record?.phase, 'Stopped');
  await f.provider.destroy(release(f, lease));
  assert.equal(f.record, undefined);
});

test('legacy direct policy inputs remain usable only for lease cleanup', async () => {
  const f = fake();
  const lease = await f.provider.acquire(f.params);
  const params = {
    ...release(f, lease),
    config: { ...config, policy, policyFile: '/old-policy.yaml' },
  };
  await f.provider.stop(params);
  assert.equal(f.record?.phase, 'Stopped');
  await f.provider.destroy(params);
  assert.equal(f.record, undefined);
});

test('profile scope changes and deletion fail closed for existing leases', async () => {
  const f = fake({ profile: 'standard' }, settings);
  let current: Record<string, unknown> = settings;
  f.provider.setPluginConfig(async () => current);
  const params = { ...f.params, config: { profile: 'standard' } };
  const lease = await f.provider.acquire(params);
  const before = f.calls.length;
  current = { profiles: { standard: { ...config, gateway: 'replacement' } } };
  await assert.rejects(
    f.provider.destroy({ ...release(f, lease), config: params.config }),
    /scope mismatch/,
  );
  current = {};
  await assert.rejects(
    f.provider.destroy({ ...release(f, lease), config: params.config }),
    /Unknown profile/,
  );
  assert.equal(f.calls.length, before);
  assert.ok(f.record);
});
