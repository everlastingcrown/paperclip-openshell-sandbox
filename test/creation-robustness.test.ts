import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvironmentCreationCleanupError } from '@paperclipai/plugin-sdk';
import { createPlugin } from '../src/plugin.js';
import { parseConfig } from '../src/config.js';
import { parsePluginConfig } from '../src/presets.js';
import { acquire } from '../src/acquisition.js';
import { identity } from '../src/identity.js';
import { SandboxClient } from '../src/sandbox-client.js';
import { fake, ok, release, config } from './helpers.js';

const defaults = {
  ...config,
  configHome: '/paperclip/.config',
  providers: ['existing'],
};
const hostFields = {
  driver: 'openshell',
  pluginId: 'installed-plugin-id',
  pluginKey: 'paperclip.openshell-sandbox-provider',
  sandboxProviderPlugin: 'installed-plugin-id',
  pendingCleanupAttemptId: 'private-bookkeeping',
  failedCreateCleanup: { privateValue: 'private-bookkeeping' },
};

test('empty environment uses company defaults through validation, probe and lifecycle', async () => {
  const f = fake({}, { defaults });
  f.params.config = {} as typeof f.params.config;
  const plugin = createPlugin(f.provider);
  const result = await plugin.definition.onEnvironmentValidateConfig!({
    driverKey: 'openshell',
    config: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalizedConfig, {});
  assert.equal((await f.provider.probe(f.params)).ok, true);
  const l = await f.provider.acquire(f.params);
  assert.equal((l.metadata?.openshell as any).configHome, defaults.configHome);
  await f.provider.destroy(release(f, l));
  assert.ok(
    f.calls.every((c) => c.env?.XDG_CONFIG_HOME === defaults.configHome),
  );
});

test('defaults, profile and environment overrides compose without copying host metadata', async () => {
  const settings = {
    defaults,
    profiles: { small: { memory: '2Gi', reuseLease: true } },
  };
  const raw = {
    ...hostFields,
    profile: 'small',
    providers: [],
    reuseLease: false,
  };
  const resolved = parseConfig(raw, settings);
  assert.equal(resolved.gateway, 'test');
  assert.equal(resolved.memory, '2Gi');
  assert.deepEqual(resolved.providers, []);
  assert.equal(resolved.reuseLease, false);
  const normalized = await createPlugin().definition
    .onEnvironmentValidateConfig!({
    driverKey: 'openshell',
    config: raw,
  });
  assert.deepEqual(normalized.normalizedConfig, {
    profile: 'small',
    providers: [],
    reuseLease: false,
  });
  assert.equal(
    JSON.stringify(normalized).includes('private-bookkeeping'),
    false,
  );
  assert.equal(JSON.stringify(raw).includes('private-bookkeeping'), true);
});

test('Paperclip saved routing fields do not block failed-create reconciliation', async () => {
  const f = fake();
  f.fail((a) => (a[5] === 'create' ? ok('malformed') : undefined));
  let evidence;
  try {
    await f.provider.acquire(f.params);
  } catch (error) {
    evidence = readEnvironmentCreationCleanupError(error);
  }
  assert.ok(evidence);
  f.fail(undefined);
  f.provider.setPluginConfig(async () => ({
    cleanupRecovery: [
      {
        environmentId: f.params.environmentId,
        gateway: 'test',
        rejectedAttemptIds: [evidence.attemptId],
      },
    ],
  }));
  const result = await f.provider.destroy({
    ...f.params,
    config: { ...config, ...hostFields },
    providerLeaseId: evidence.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: evidence },
  });
  assert.equal(result.state, 'destroyed');
  assert.ok(!f.calls.some((c) => c.args[5] === 'delete'));
});

test('OpenShell template replaces inherited image/resources and is checked before allocation', async () => {
  const f = fake({}, { defaults: { ...defaults, cpu: '2', memory: '4Gi' } });
  f.params.config = { template: 'paperclip' } as typeof f.params.config;
  assert.equal((await f.provider.probe(f.params)).ok, true);
  const l = await f.provider.acquire(f.params);
  const args = f.calls.find((c) => c.args[5] === 'create')!.args;
  assert.ok(args.includes('--template'));
  assert.ok(args.includes('paperclip'));
  for (const flag of ['--from', '--cpu', '--memory'])
    assert.ok(!args.includes(flag));
  await f.provider.destroy(release(f, l));
});

test('template lookup failures and malformed identities leave no allocation', async () => {
  for (const response of [
    { ...ok(), exitCode: 1, stderr: 'template not found private-value' },
    ok(JSON.stringify({ id: 'id', name: 'other', workspace: 'default' })),
    ok('malformed'),
  ]) {
    const f = fake(
      {},
      { defaults: { gateway: 'test', template: 'paperclip' } },
    );
    f.params.config = {} as typeof f.params.config;
    f.fail((a) => (a[5] === 'template' ? response : undefined));
    assert.equal((await f.provider.probe(f.params)).ok, false);
    await assert.rejects(f.provider.acquire(f.params), (error: Error) => {
      assert.match(error.message, /preflight.*no allocation created/);
      assert.equal(error.message.includes('private-value'), false);
      assert.equal(readEnvironmentCreationCleanupError(error), null);
      return true;
    });
    assert.ok(!f.calls.some((c) => c.args[5] === 'create'));
  }
});

test('template conflicts and malformed defaults fail before CLI calls', () => {
  for (const raw of [
    { defaults: null },
    { defaults: { unknown: true } },
    { defaults: { template: 'bad name' } },
    { defaults: { template: 'paperclip', image: 'runtime' } },
    { defaults: { template: 'paperclip', cpu: '1' } },
    { defaults: { policyFile: 'relative' } },
    {
      defaults: { policyFile: '/policy.yaml', policyPreset: 'p' },
      policies: { p: 'version: 1' },
    },
  ])
    assert.throws(() => parsePluginConfig(raw));
  assert.throws(
    () => parseConfig({ ...config, template: 'paperclip' }),
    /template or image/,
  );
  assert.equal(
    parseConfig(
      { image: 'override' },
      { defaults: { gateway: 'test', template: 'paperclip' } },
    ).template,
    undefined,
  );
});

test('worker-local policy is used directly and its removal cannot block cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openshell-policy-test-'));
  const path = join(directory, 'policy.yaml');
  try {
    await writeFile(path, 'version: 1\n');
    const settings = { defaults: { ...defaults, policyFile: path } };
    const f = fake({}, settings);
    f.params.config = {} as typeof f.params.config;
    assert.equal((await f.provider.probe(f.params)).ok, true);
    const l = await f.provider.acquire(f.params);
    const args = f.calls.find((c) => c.args[5] === 'create')!.args;
    assert.equal(args[args.indexOf('--policy') + 1], path);
    await rm(path);
    await f.provider.destroy(release(f, l));
    assert.equal(f.record, undefined);
    assert.equal((await f.provider.probe(f.params)).ok, false);
    const before = f.calls.length;
    await assert.rejects(
      f.provider.acquire(f.params),
      /preflight.*no allocation created.*Policy file cannot be read/,
    );
    assert.equal(f.calls.length, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a policy preset can replace an inherited worker-local policy', () => {
  const c = parseConfig(
    { policyPreset: 'p' },
    {
      defaults: { ...defaults, policyFile: '/policy.yaml' },
      policies: { p: 'version: 1' },
    },
  );
  assert.equal(c.policyFile, undefined);
  assert.equal(c.policy, 'version: 1');
});

for (const stderr of [
  'failed to parse sandbox policy YAML: private-policy-value',
  'failed to decode sandbox policy fields: private-policy-value',
  "unknown field 'private-policy-value' in authored policy",
  'unsupported policy version 2; expected version 1',
  'failed to inspect sandbox policy /private/path',
  "missing required provider 'private-provider'",
  "provider 'private-provider' not found and no provider profile named 'private-profile' is available",
]) {
  test(`recognized pre-allocation rejection stays retryable: ${stderr.split(' ').slice(0, 4).join(' ')}`, async () => {
    const f = fake();
    f.fail((a) =>
      a[5] === 'create' ? { ...ok(), exitCode: 1, stderr } : undefined,
    );
    await assert.rejects(f.provider.acquire(f.params), (error: Error) => {
      assert.match(error.message, /no allocation created/);
      assert.equal(readEnvironmentCreationCleanupError(error), null);
      assert.equal(error.message.includes('private-'), false);
      return true;
    });
    assert.equal(f.calls.filter((c) => c.args[5] === 'list').length, 1);
  });
}

for (const interruption of [
  { timedOut: false, signal: null, exitCode: 1, marker: true },
  { timedOut: true, signal: null, exitCode: null, marker: false },
  { timedOut: false, signal: 'SIGKILL', exitCode: null, marker: false },
]) {
  test(`policy-looking diagnostics cannot clear a possible allocation: ${JSON.stringify(interruption)}`, async () => {
    const f = fake();
    let now = 0;
    const client = new SandboxClient(f.runner, 1, {
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
    });
    f.fail((a) =>
      a[5] === 'create'
        ? {
            ...ok(),
            ...interruption,
            stderr: `${interruption.marker ? 'Provisioning sandbox (structured output on stdout)...\n' : ''}failed to parse sandbox policy YAML: private-value`,
          }
        : undefined,
    );
    await assert.rejects(
      acquire(f.params, parseConfig(config), client),
      (error) => {
        assert.ok(readEnvironmentCreationCleanupError(error));
        assert.equal((error as Error).message.includes('private-value'), false);
        return true;
      },
    );
  });
}

for (const operation of ['list', 'delete']) {
  test(`temporary cleanup ${operation} failure is retried with ownership verification`, async () => {
    const f = fake();
    let now = 0;
    let failed = false;
    const client = new SandboxClient(f.runner, 1, {
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
    });
    f.fail((a) => {
      if (a[5] === 'exec') return { ...ok(), exitCode: 1 };
      if (
        f.record &&
        a[5] === operation &&
        !failed &&
        (operation === 'delete' || f.calls.some((c) => c.args[5] === 'exec'))
      ) {
        failed = true;
        return { ...ok(), exitCode: 1, stderr: 'connection refused' };
      }
    });
    await assert.rejects(
      acquire(f.params, parseConfig(config), client),
      /owned allocation cleaned up/,
    );
    assert.equal(failed, true);
    assert.equal(f.record, undefined);
    assert.ok(f.calls.every((c) => c.timeout > 0));
  });
}

test('readiness tolerates a temporary list visibility gap', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  let now = 0;
  let hidden = true;
  f.fail((a) => {
    if (a[5] === 'list' && hidden) {
      hidden = false;
      return ok(JSON.stringify({ sandboxes: [], next_page_token: '' }));
    }
  });
  const client = new SandboxClient(f.runner, 1, {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  });
  await client.wait(
    parseConfig(config),
    identity(f.params, l.providerLeaseId, l.metadata, parseConfig(config)),
    'Ready',
    1000,
  );
  assert.equal(now, 1);
});

test('runtime edits and deleted defaults cannot block teardown of a saved lease', async () => {
  const f = fake({}, { defaults });
  f.params.config = {} as typeof f.params.config;
  const l = await f.provider.acquire(f.params);
  f.provider.setPluginConfig(async () => ({}));
  const p = {
    ...release(f, l),
    config: {
      image: null,
      template: 'removed-template',
      cpu: 'bad',
      providers: [42],
    },
  };
  await f.provider.stop(p);
  assert.equal(f.record?.phase, 'Stopped');
  await f.provider.destroy(p);
  assert.equal(f.record, undefined);
});

test('preflight refuses an existing name without controlling that allocation', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const name = (l.metadata!.openshell as any).name;
  const before = f.calls.length;
  await assert.rejects(
    new SandboxClient(f.runner).preflight(
      parseConfig(config),
      name,
      Date.now() + 1000,
    ),
    /already exists before allocation/,
  );
  assert.ok(f.calls.slice(before).every((c) => c.args[5] === 'list'));
  assert.equal(f.record?.id, l.providerLeaseId);
});

test('uncertain create can recover an allocation that appears during cleanup retries', async () => {
  const f = fake();
  let name = '';
  let labels: Record<string, string> = {};
  let inspections = 0;
  let now = 0;
  f.fail((a) => {
    if (a[5] === 'create') {
      name = a[a.indexOf('--name') + 1];
      labels = Object.fromEntries(
        a.flatMap((flag, index) =>
          flag === '--label' ? [a[index + 1].split('=')] : [],
        ),
      );
      return { ...ok(), exitCode: 1, stderr: 'transport error private-value' };
    }
    if (name && a[5] === 'list' && ++inspections === 2) {
      f.record = {
        id: 'late-id',
        name,
        labels,
        workspace: 'default',
        phase: 'Ready',
      };
    }
  });
  const client = new SandboxClient(f.runner, 1, {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  });
  await assert.rejects(
    acquire(f.params, parseConfig(config), client),
    (error: Error) => {
      assert.match(error.message, /owned allocation cleaned up/);
      assert.equal(error.message.includes('private-value'), false);
      assert.equal(readEnvironmentCreationCleanupError(error), null);
      return true;
    },
  );
  assert.equal(f.record, undefined);
  assert.equal(f.calls.filter((c) => c.args[5] === 'delete').length, 1);
});
