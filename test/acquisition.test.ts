import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import {
  readEnvironmentCreationCleanupError,
  PluginEnvironmentCreationCleanupError,
} from '@paperclipai/plugin-sdk';
import { config, ok, fake, release } from './helpers.js';
test('cleared config home and policy use defaults during acquisition', async () => {
  const f = fake({ configHome: '', policyFile: '' });
  const l = await f.provider.acquire(f.params);
  const args = f.calls.find((call) => call.args.includes('create'))!.args;
  assert.equal(args.includes('--policy'), false);
  for (const call of f.calls) assert.deepEqual(call.env, {});
  await f.provider.destroy(release(f, l));
});
test('explicit config home reaches create, inspect, exec and delete subprocesses', async () => {
  const f = fake({ configHome: '/paperclip/.config' });
  const l = await f.provider.acquire(f.params);
  await f.provider.execute({ ...f.params, lease: l, command: 'true' });
  await f.provider.destroy(release(f, l));
  for (const call of f.calls)
    assert.deepEqual(call.env, { XDG_CONFIG_HOME: '/paperclip/.config' });
});
test('acquisition uses pinned scope, ownership and noninteractive create flags', async () => {
  const f = fake(
    {
      providers: ['existing'],
      policyPreset: 'test',
      cpu: '500m',
      memory: '1Gi',
    },
    { policies: { test: 'version: 1' } },
  );
  const l = await f.provider.acquire(f.params);
  const args = f.calls.find((call) => call.args.includes('create'))!.args;
  for (const flag of [
    '--detach',
    '--no-tty',
    '--no-auto-providers',
    '--approval-mode',
    'manual',
    '--output',
    'json',
    '--provider',
    'existing',
    '--policy',
    '--cpu',
    '500m',
    '--memory',
    '1Gi',
  ])
    assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(0, 4), [
    '--gateway',
    'test',
    '--workspace',
    'default',
  ]);
  assert.ok((l.metadata?.openshell as any).labels['paperclip-attempt']);
  assert.equal(l.providerLeaseId, 'sandbox-id');
  const name = args[args.indexOf('--name') + 1];
  assert.match(name, /^pc-[0-9a-f]{16}$/);
  assert.ok(name.length <= 19);
  assert.deepEqual(args.slice(-4), [
    '--',
    '/bin/sh',
    '-c',
    'while :; do sleep 3600; done',
  ]);
});
test('preflight failure never creates a pending cleanup record', async () => {
  const f = fake();
  f.fail((a) =>
    a.includes('list')
      ? { ...ok(), exitCode: 1, stderr: 'connection refused' }
      : undefined,
  );
  await assert.rejects(f.provider.acquire(f.params), (error: any) => {
    assert.match(
      error.message,
      /preflight.*no allocation created.*gateway connection failed/,
    );
    assert.equal(readEnvironmentCreationCleanupError(error), null);
    return true;
  });
  assert.ok(!f.calls.some((call) => call.args.includes('create')));
});
test('definite name rejection never becomes uncertain cleanup', async () => {
  const f = fake();
  f.fail((a) =>
    a.includes('create')
      ? {
          ...ok(),
          exitCode: 1,
          stderr: 'name exceeds maximum length (46 > 19)',
        }
      : undefined,
  );
  await assert.rejects(f.provider.acquire(f.params), (error: any) => {
    assert.match(error.message, /no allocation created.*19-character/);
    assert.equal(readEnvironmentCreationCleanupError(error), null);
    return true;
  });
});
test('curl image is rejected at validation, draft probe and admission before allocation', async () => {
  const f = fake({ image: 'curlimages/curl:8.21.0', cpu: 1, memory: '512Mi' });
  const plugin = createPlugin(f.provider);
  const validation = await plugin.definition.onEnvironmentValidateConfig!(
    f.params,
  );
  assert.equal(validation.ok, false);
  assert.match(validation.errors![0], /Paperclip runtime.*bash, node, git/);
  assert.equal(
    (await plugin.definition.onEnvironmentProbe!(f.params)).ok,
    false,
  );
  await assert.rejects(f.provider.acquire(f.params), /Paperclip runtime/);
  assert.equal(f.calls.length, 0);
  assert.equal(parseConfig({ ...config, cpu: 1 }).cpu, '1');
});
test('runtime failure identifies the missing tool and cleanup failure separately', async () => {
  const f = fake();
  const logs: any[] = [];
  f.provider.setLogger({
    info() {},
    debug() {},
    warn() {},
    error: (message, meta) => logs.push({ message, meta }),
  });
  f.fail((a) =>
    a.includes('exec')
      ? { ...ok(), exitCode: 1, stderr: 'paperclip: missing tool node\n' }
      : a.includes('delete')
        ? { ...ok(), exitCode: 1, stderr: 'connection refused secret-token' }
        : undefined,
  );
  await assert.rejects(f.provider.acquire(f.params), (error: any) => {
    assert.ok(error instanceof PluginEnvironmentCreationCleanupError);
    assert.match(
      error.message,
      /missing node.*cleanup requires reconciliation.*sandbox delete.*gateway connection failed/,
    );
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
  assert.equal(logs.length, 2);
  assert.ok(!JSON.stringify(logs).includes('secret-token'));
});
test('requested provider expiry rejects before CLI allocation', async () => {
  const f = fake();
  await assert.rejects(
    f.provider.acquire({
      ...f.params,
      requestedExpiresAt: '2030-01-01T00:00:00Z',
    }),
    /expiry/,
  );
  assert.equal(f.calls.length, 0);
});
test('failed runtime check cleans up allocation', async () => {
  const f = fake();
  f.fail((a) => (a.includes('exec') ? { ...ok(), exitCode: 1 } : undefined));
  await assert.rejects(f.provider.acquire(f.params), /cleaned up/);
  assert.equal(f.record, undefined);
});
test('unconfirmed deletion and acquisition timeout stay structured or fail loudly', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.fail((a) => (a.includes('delete') ? ok() : undefined));
  await assert.rejects(
    f.provider.destroy(release(f, l)),
    /confirmation timed out/,
  );
  assert.ok(f.record);
  const timeout = fake();
  timeout.fail((a) =>
    a.includes('create')
      ? { ...ok(), exitCode: null, timedOut: true }
      : undefined,
  );
  await assert.rejects(
    timeout.provider.acquire(timeout.params),
    PluginEnvironmentCreationCleanupError,
  );
});
