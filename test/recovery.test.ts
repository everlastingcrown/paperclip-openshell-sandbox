import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../src/plugin.js';
import {
  readEnvironmentCreationCleanupError,
  PluginEnvironmentCreationCleanupError,
} from '@paperclipai/plugin-sdk';
import { ok, fake, release } from './helpers.js';
test('failed cleanup returns SDK structured nonsecret ownership evidence', async () => {
  const f = fake();
  f.fail((a) =>
    a.includes('exec') || a.includes('delete')
      ? { ...ok(), stderr: 'secret-token', exitCode: 1 }
      : undefined,
  );
  try {
    await f.provider.acquire(f.params);
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof PluginEnvironmentCreationCleanupError);
    const cleanup = readEnvironmentCreationCleanupError(e)!;
    assert.ok(cleanup);
    assert.equal(cleanup.observedProviderLeaseId, 'sandbox-id');
    assert.ok(!JSON.stringify(e).includes('secret-token'));
    f.fail(undefined);
    await f.provider.destroy({
      ...f.params,
      providerLeaseId: cleanup.providerLeaseId,
      leaseMetadata: { failedCreateCleanup: cleanup },
    });
    assert.equal(f.record, undefined);
  }
});
test('uncertain creation preserves pending cleanup; observation must be durable before destroy', async () => {
  const f = fake();
  f.fail((a) => (a.includes('create') ? ok('malformed') : undefined));
  let cleanup: any;
  try {
    await f.provider.acquire(f.params);
  } catch (e) {
    cleanup = readEnvironmentCreationCleanupError(e);
  }
  assert.ok(cleanup);
  assert.equal(cleanup.observedProviderLeaseId, undefined);
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  await assert.rejects(
    f.provider.destroy(p),
    PluginEnvironmentCreationCleanupError,
  );
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: cleanup.labels,
  };
  try {
    await f.provider.destroy(p);
  } catch (e) {
    cleanup = readEnvironmentCreationCleanupError(e);
  }
  assert.equal(cleanup.observedProviderLeaseId, 'late-id');
  assert.ok(f.record);
  await f.provider.destroy({
    ...p,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  assert.equal(f.record, undefined);
});
test('plugin recovery repairs saved cleanup config without changing environment settings', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const plugin = createPlugin(f.provider);
  let settings: Record<string, unknown> = {};
  const companies: string[] = [];
  await plugin.definition.setup({
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    config: {
      async get(companyId: string) {
        companies.push(companyId);
        return settings;
      },
    },
  } as any);
  const before = JSON.stringify(f.params.config);
  f.fail((args) =>
    args.includes('list') &&
    f.calls.at(-1)?.env?.XDG_CONFIG_HOME !== '/paperclip/.config'
      ? { ...ok(), exitCode: 1, stderr: "Unknown gateway 'test'" }
      : undefined,
  );
  await assert.rejects(
    plugin.definition.onEnvironmentDestroyLease!(release(f, l)),
    /not registered/,
  );
  settings = {
    cleanupRecovery: [
      {
        environmentId: 'environment',
        gateway: 'test',
        configHome: '/paperclip/.config',
      },
    ],
  };
  assert.equal((await plugin.definition.onValidateConfig!(settings)).ok, true);
  const start = f.calls.length;
  await plugin.definition.onEnvironmentDestroyLease!(release(f, l));
  assert.equal(f.record, undefined);
  assert.ok(
    f.calls
      .slice(start)
      .every((call) => call.env?.XDG_CONFIG_HOME === '/paperclip/.config'),
  );
  assert.deepEqual(companies, ['company', 'company']);
  assert.equal(JSON.stringify(f.params.config), before);
});
test('explicit rejected-attempt recovery requires successful absence and preserves observed identity', async () => {
  const f = fake();
  f.fail((args) =>
    args.includes('create')
      ? { ...ok(), exitCode: 1, stderr: 'secret-token' }
      : undefined,
  );
  let cleanup: any;
  await assert.rejects(f.provider.acquire(f.params), (error: any) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    assert.ok(cleanup);
    assert.ok(!JSON.stringify(error).includes('secret-token'));
    return true;
  });
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  const entry = {
    environmentId: 'environment',
    gateway: 'test',
    workspace: 'default',
    rejectedAttemptIds: [cleanup.attemptId],
  };
  for (const mismatch of [
    { environmentId: 'other' },
    { gateway: 'other' },
    { workspace: 'other' },
    { rejectedAttemptIds: [] },
  ]) {
    f.provider.setCleanupRecovery(async () => [{ ...entry, ...mismatch }]);
    await assert.rejects(
      f.provider.destroy(p),
      /ownership mismatch|requires durable identity/,
    );
  }
  f.provider.setCleanupRecovery(async () => [entry]);
  f.fail((args) =>
    args.includes('list')
      ? { ...ok(), exitCode: 1, stderr: 'connection refused' }
      : undefined,
  );
  await assert.rejects(f.provider.destroy(p), /gateway connection failed/);
  f.fail((args) => (args.includes('list') ? ok('malformed') : undefined));
  await assert.rejects(f.provider.destroy(p), /Malformed/);
  f.fail(undefined);
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: { ...cleanup.labels, 'paperclip-company': 'foreign' },
  };
  await assert.rejects(f.provider.destroy(p), /ownership/);
  f.record.labels = cleanup.labels;
  await assert.rejects(f.provider.destroy(p), (error: any) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    assert.equal(cleanup.observedProviderLeaseId, 'late-id');
    return true;
  });
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
  await f.provider.destroy({
    ...p,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  assert.equal(f.record, undefined);
  assert.equal((await f.provider.destroy(p)).state, 'destroyed');
});
test('stop-only recovery confirms stop and retains files', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.provider.setCleanupRecovery(async () => [
    {
      environmentId: 'environment',
      gateway: 'test',
      workspace: 'default',
      configHome: '/paperclip/.config',
      rejectedAttemptIds: [],
    },
  ]);
  const start = f.calls.length;
  assert.equal(
    (
      await f.provider.destroy({
        ...release(f, l),
        resourceDisposition: 'stop_and_retain',
      })
    ).state,
    'stopped',
  );
  assert.equal(f.record.phase, 'Stopped');
  assert.ok(
    f.calls
      .slice(start)
      .every((call) => call.env?.XDG_CONFIG_HOME === '/paperclip/.config'),
  );
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
});
test('legacy oversized attempts reconcile only after a successful scoped absence check', async () => {
  const f = fake({ image: 'curlimages/curl:8.21.0' });
  const seed = fake();
  seed.fail((a) => (a.includes('create') ? ok('malformed') : undefined));
  let cleanup: any;
  try {
    await seed.provider.acquire(seed.params);
  } catch (error) {
    cleanup = readEnvironmentCreationCleanupError(error);
  }
  assert.ok(cleanup);
  cleanup.providerLeaseId = `paperclip-${cleanup.attemptId}`;
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  f.fail((a) => (a.includes('list') ? ok('malformed') : undefined));
  await assert.rejects(f.provider.destroy(p), /Malformed/);
  f.fail(undefined);
  assert.deepEqual(await f.provider.destroy(p), {
    providerLeaseId: cleanup.providerLeaseId,
    state: 'destroyed',
  });
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
  f.record = {
    id: 'observed-legacy',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: cleanup.labels,
  };
  await assert.rejects(f.provider.destroy(p), (error: any) => {
    assert.equal(
      readEnvironmentCreationCleanupError(error)?.observedProviderLeaseId,
      'observed-legacy',
    );
    return true;
  });
  f.record.labels['paperclip-company'] = 'foreign';
  await assert.rejects(f.provider.destroy(p), /ownership/);
});
test('ownership label mismatch and malformed sandbox shapes fail closed', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  f.record.labels['paperclip-company'] = 'foreign';
  await assert.rejects(f.provider.destroy(release(f, l)), /ownership/);
  assert.ok(f.record);
  f.record.labels = null;
  await assert.rejects(
    f.provider.resume({ ...release(f, l), providerLeaseId: 'sandbox-id' }),
    /shape/,
  );
});
