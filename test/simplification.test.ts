import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironmentCreationCleanupError } from '@paperclipai/plugin-sdk';
import { acquire } from '../src/acquisition.js';
import { parseConfig, configSchema } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import { SandboxClient } from '../src/sandbox-client.js';
import { fake, ok, release, config } from './helpers.js';

test('validation preserves unknown Paperclip fields without inspecting their schema', async () => {
  const raw = {
    ...config,
    provider: 'openshell',
    archiveOnRelease: true,
    futureHostField: { arbitrary: ['shape'] },
    pluginId: 'host-owned',
  };
  const result = await createPlugin().definition.onEnvironmentValidateConfig!({
    driverKey: 'openshell',
    config: raw,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalizedConfig, raw);
  assert.deepEqual(parseConfig(raw), parseConfig(config));
  assert.equal(configSchema.additionalProperties, true);
});

test('template and authored policy are passed directly to OpenShell without guessed preflight schemas', async () => {
  const f = fake({
    image: undefined,
    template: 'runtime',
    policyFile: '/worker/policy.yaml',
    providers: ['existing'],
  });
  const l = await f.provider.acquire(f.params);
  const args = f.calls.find((c) => c.args[5] === 'create')!.args;
  assert.ok(args.includes('--template'));
  assert.ok(args.includes('/worker/policy.yaml'));
  assert.ok(args.includes('existing'));
  assert.ok(!f.calls.some((c) => c.args[5] === 'template'));
  assert.ok(!args.includes('--from'));
  assert.ok(!args.includes('--cpu'));
  assert.ok(!args.includes('--memory'));
  await f.provider.destroy(release(f, l));
});

test('failed Test Provider checks delete fresh sandboxes and permit a clean retry', async () => {
  const f = fake({
    provider: 'openshell',
    archiveOnRelease: true,
    reuseLease: false,
  });
  f.fail((a) =>
    a[5] === 'exec'
      ? { ...ok(), exitCode: 1, stderr: 'paperclip: workspace is not writable' }
      : undefined,
  );
  await assert.rejects(
    f.provider.acquire(f.params),
    /owned allocation cleaned up/,
  );
  assert.equal(f.record, undefined);
  f.fail(undefined);
  const l = await f.provider.acquire(f.params);
  await f.provider.release(release(f, l));
  assert.equal(f.record, undefined);
});

test('timed-out create gets a fresh cleanup budget and removes the late allocation', async () => {
  const f = fake();
  let now = 0;
  const client = new SandboxClient(f.runner, 1, {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  });
  f.fail((a) => {
    if (a[5] !== 'create') return;
    const labels = Object.fromEntries(
      a.flatMap((flag, index) =>
        flag === '--label' ? [a[index + 1].split('=')] : [],
      ),
    );
    f.record = {
      id: 'late-id',
      name: a[a.indexOf('--name') + 1],
      workspace: 'default',
      phase: 'Ready',
      labels,
    };
    now = 1000; // Entire acquisition budget consumed by the CLI.
    return { ...ok(), exitCode: null, timedOut: true };
  });
  await assert.rejects(
    acquire(f.params, parseConfig(config), client),
    /owned allocation cleaned up/,
  );
  assert.equal(f.record, undefined);
  const deletion = f.calls.find((c) => c.args[5] === 'delete');
  assert.ok(deletion && deletion.timeout > 0);
});

for (const operation of ['list', 'delete']) {
  test(`ordinary destruction retries a transient ${operation} failure and stays idempotent`, async () => {
    const f = fake();
    const l = await f.provider.acquire(f.params);
    let failed = false;
    f.fail((a) => {
      if (a[5] === operation && !failed) {
        failed = true;
        return { ...ok(), exitCode: 1, stderr: 'connection refused' };
      }
    });
    assert.equal((await f.provider.destroy(release(f, l))).state, 'destroyed');
    assert.equal(failed, true);
    assert.equal(f.record, undefined);
    assert.equal((await f.provider.destroy(release(f, l))).state, 'destroyed');
  });
}

test('teardown uses saved connection even with invalid runtime edits and broken plugin settings', async () => {
  const f = fake({
    configHome: '/worker/.config',
    executable: '/worker/openshell',
  });
  const l = await f.provider.acquire(f.params);
  f.provider.setPluginConfig(async () => {
    throw new Error('settings unavailable');
  });
  const p = {
    ...release(f, l),
    config: {
      gateway: 'different',
      workspace: null,
      executable: null,
      configHome: null,
      image: null,
      template: 'deleted',
      providers: [42],
      timeoutMs: 1.5,
    },
  };
  const start = f.calls.length;
  await f.provider.stop(p);
  await f.provider.destroy(p);
  assert.equal(f.record, undefined);
  assert.ok(
    f.calls
      .slice(start)
      .every(
        (c) =>
          c.args[1] === 'test' && c.env?.XDG_CONFIG_HOME === '/worker/.config',
      ),
  );
});

test('logger failures cannot prevent acquisition or cleanup or mask the original error', async () => {
  const f = fake();
  const broken = () => {
    throw new Error('logger disconnected');
  };
  const plugin = createPlugin(f.provider);
  await plugin.definition.setup({
    logger: { debug: broken, info: broken, warn: broken, error: broken },
    config: {
      async get() {
        return {};
      },
    },
  } as any);
  f.fail((a) => (a[5] === 'exec' ? { ...ok(), exitCode: 1 } : undefined));
  await assert.rejects(
    plugin.definition.onEnvironmentAcquireLease!(f.params),
    /owned allocation cleaned up/,
  );
  assert.equal(f.record, undefined);
  f.fail(undefined);
  const l = await plugin.definition.onEnvironmentAcquireLease!(f.params);
  await plugin.definition.onEnvironmentDestroyLease!(release(f, l));
  assert.equal(f.record, undefined);
});

test('logs correlate lifecycle and cleanup without recording execution secrets', async () => {
  const f = fake();
  const entries: any[] = [];
  const capture = (message: string, fields: any) =>
    entries.push({ message, fields });
  f.provider.setLogger({
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
  });
  const l = await f.provider.acquire(f.params);
  await f.provider.execute({
    ...f.params,
    lease: l,
    command: 'echo',
    args: ['private-argument'],
    env: { TOKEN: 'private-env' },
    stdin: 'private-stdin',
  });
  await f.provider.destroy(release(f, l));
  const text = JSON.stringify(entries);
  for (const secret of ['private-argument', 'private-env', 'private-stdin'])
    assert.ok(!text.includes(secret));
  for (const message of [
    'OpenShell acquisition started',
    'OpenShell acquisition ready',
    'OpenShell command completed',
    'OpenShell sandbox state',
    'OpenShell execution completed',
    'OpenShell cleanup confirmed',
  ])
    assert.ok(
      entries.some((e) => e.message === message),
      message,
    );
  assert.ok(
    entries.find((e) => e.message === 'OpenShell acquisition started').fields
      .attemptId,
  );
});

test('permanent gateway failure preserves recovery evidence instead of reporting destruction', async () => {
  const f = fake();
  f.fail((a) =>
    a[5] === 'exec' || a[5] === 'delete'
      ? { ...ok(), exitCode: 1, stderr: 'connection refused private-token' }
      : undefined,
  );
  let cleanup;
  await assert.rejects(f.provider.acquire(f.params), (error) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    assert.ok(cleanup?.observedProviderLeaseId);
    assert.ok(!(error as Error).message.includes('private-token'));
    return true;
  });
  assert.ok(f.record);
  f.fail(undefined);
  await f.provider.destroy({
    ...f.params,
    providerLeaseId: cleanup!.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  assert.equal(f.record, undefined);
});
