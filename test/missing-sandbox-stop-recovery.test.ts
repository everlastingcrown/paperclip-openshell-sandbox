import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../src/plugin.js';
import { parseMissingSandboxStopRecovery } from '../src/missing-sandbox-stop-recovery.js';
import { fake, ok, release } from './helpers.js';
import type { SandboxClient } from '../src/sandbox-client.js';

const entry = {
  environmentId: 'environment',
  providerLeaseId: 'sandbox-id',
  attemptId: '00000000-0000-0000-0000-000000000000',
};

test('missing stop recovery configuration rejects malformed and duplicate authorizations', async () => {
  for (const config of [{}, { missingSandboxStopRecovery: [] }]) {
    assert.deepEqual(parseMissingSandboxStopRecovery(config), []);
    assert.equal(
      (await createPlugin().definition.onValidateConfig!(config)).ok,
      true,
    );
  }
  assert.deepEqual(
    parseMissingSandboxStopRecovery({ missingSandboxStopRecovery: [entry] }),
    [entry],
  );
  for (const value of [
    null,
    false,
    {},
    [null],
    [[]],
    [{}],
    [entry, entry],
    [{ ...entry, environmentId: ' ' }],
    [{ ...entry, providerLeaseId: '\0' }],
    [{ ...entry, attemptId: entry.attemptId.toUpperCase().replace('0', 'A') }],
    [{ ...entry, extra: true }],
  ]) {
    const config = { missingSandboxStopRecovery: value };
    assert.throws(
      () => parseMissingSandboxStopRecovery(config),
      /Invalid missingSandboxStopRecovery/,
    );
    assert.equal(
      (await createPlugin().definition.onValidateConfig!(config)).ok,
      false,
    );
  }
});

async function prepared(reuseLease = false) {
  const settings: Record<string, unknown> = {};
  const f = fake({ reuseLease }, settings);
  const lease = await f.provider.acquire(f.params);
  const authorization = {
    ...entry,
    attemptId: f.record!.labels['paperclip-attempt']!,
  };
  settings.missingSandboxStopRecovery = [authorization];
  return { f, settings, authorization, p: release(f, lease) };
}

test('exact missing lease override applies to every stop entry point regardless of reuse', async () => {
  for (const reuse of [false, true]) {
    for (const operation of ['stop', 'release', 'destroy'] as const) {
      const { f, p } = await prepared(reuse);
      f.record = undefined;
      assert.deepEqual(
        await f.provider[operation]({
          ...p,
          resourceDisposition: 'stop_and_retain',
        }),
        {
          providerLeaseId: 'sandbox-id',
          state: 'stopped',
        },
      );
      assert.ok(
        !f.calls.some((c) =>
          ['delete', 'stop', 'start', 'resume'].includes(c.args[5]!),
        ),
      );
    }
  }
});

test('override accepts disappearance after a stop command and emits a bounded warning', async () => {
  const { f, p, authorization } = await prepared();
  const logs: unknown[] = [];
  f.provider.setLogger({
    warn: (message, fields) => logs.push({ message, fields }),
  } as Parameters<typeof f.provider.setLogger>[0]);
  f.fail((args) => {
    if (args[5] === 'stop') {
      f.record = undefined;
      return { ...ok(), stderr: 'secret-provider-token' };
    }
    return undefined;
  });
  assert.equal((await f.provider.stop(p)).state, 'stopped');
  assert.ok(
    JSON.stringify(logs).includes('missing sandbox accepted as stopped'),
  );
  assert.ok(JSON.stringify(logs).includes(authorization.attemptId));
  assert.ok(!JSON.stringify(logs).includes('secret-provider-token'));
  assert.ok(!f.calls.some((c) => c.args[5] === 'delete'));
});

test('removing authorization disables subsequent overrides and settings are company scoped', async () => {
  const { f, p, settings, authorization } = await prepared();
  const companies: string[] = [];
  f.provider.setPluginConfig(async (companyId) => {
    companies.push(companyId);
    return companyId === p.companyId ? settings : {};
  });
  f.record = undefined;
  assert.equal((await f.provider.stop(p)).state, 'stopped');
  delete settings.missingSandboxStopRecovery;
  await assert.rejects(f.provider.stop(p), /Sandbox missing/);
  assert.ok(companies.every((companyId) => companyId === p.companyId));
  // A foreign company's authorization is never returned by this resolver.
  settings.missingSandboxStopRecovery = [authorization];
  f.provider.setPluginConfig(async (companyId) =>
    companyId === 'foreign' ? settings : {},
  );
  await assert.rejects(f.provider.stop(p), /Sandbox missing/);
});

test('mismatched authorizations and unavailable settings preserve the missing failure', async () => {
  for (const field of [
    'environmentId',
    'providerLeaseId',
    'attemptId',
  ] as const) {
    const { f, p, settings, authorization } = await prepared();
    settings.missingSandboxStopRecovery = [
      {
        ...authorization,
        [field]: field === 'attemptId' ? entry.attemptId : 'other',
      },
    ];
    f.record = undefined;
    await assert.rejects(f.provider.stop(p), /Sandbox missing/);
  }
  for (const config of [undefined, { missingSandboxStopRecovery: null }]) {
    const { f, p } = await prepared();
    f.record = undefined;
    f.provider.setPluginConfig(async () => {
      if (!config) throw new Error('settings unavailable secret');
      return config;
    });
    await assert.rejects(f.provider.stop(p), /Sandbox missing/);
  }
});

test('override never converts lookup failures or incomplete pagination into success', async () => {
  for (const result of [
    { ...ok(), exitCode: 1, stderr: 'permission denied secret' },
    { ...ok(), exitCode: 1, stderr: 'connection refused secret' },
    ok('bad json'),
    ok('{}'),
    ok(JSON.stringify({ sandboxes: [], next_page_token: 'repeat' })),
  ]) {
    const { f, p } = await prepared();
    f.record = undefined;
    f.fail((args) => (args[5] === 'list' ? result : undefined));
    await assert.rejects(f.provider.stop(p));
  }
  const { f, p } = await prepared();
  f.fail((args) =>
    args[5] === 'list'
      ? ok(
          args.at(-1) === ''
            ? JSON.stringify({ sandboxes: [], next_page_token: 'next' })
            : '{}',
        )
      : undefined,
  );
  await assert.rejects(f.provider.stop(p), /Invalid sandbox list/);
});

test('identity mismatches, uncertain creation metadata and exhausted deadlines cannot use override', async () => {
  const { f, p } = await prepared();
  f.record!.id = 'replacement';
  await assert.rejects(f.provider.stop(p), /mismatch/);
  f.record = undefined;
  await assert.rejects(
    f.provider.stop({ ...p, companyId: 'foreign' }),
    /mismatch/,
  );
  await assert.rejects(
    f.provider.stop({ ...p, leaseMetadata: { failedCreateCleanup: {} } }),
  );
  await assert.rejects(
    f.provider.stop({
      ...p,
      leaseMetadata: { ...p.leaseMetadata, failedCreateCleanup: {} },
    }),
    /Sandbox missing/,
  );
  const client = (f.provider as unknown as { client: SandboxClient }).client;
  let now = 0;
  Object.assign(client, { clock: { now: () => (now += 40_000) } });
  const before = f.calls.length;
  await assert.rejects(f.provider.stop(p), /timed out/);
  assert.equal(f.calls.length, before);
});

test('authorization lookup cannot extend an exhausted stop deadline', async () => {
  const { f, p, settings } = await prepared();
  f.record = undefined;
  let now = 0;
  const client = (f.provider as unknown as { client: SandboxClient }).client;
  Object.assign(client, { clock: { now: () => now } });
  let reads = 0;
  f.provider.setPluginConfig(async () => {
    if (++reads === 2) now = 40_000;
    return settings;
  });
  await assert.rejects(f.provider.stop(p), /deadline exceeded/);
});

test('normal stop and ordinary destroy keep their semantics with override configured', async () => {
  const { f, p } = await prepared();
  assert.equal((await f.provider.stop(p)).state, 'stopped');
  assert.equal(f.record!.phase, 'Stopped');
  f.record = undefined;
  assert.equal((await f.provider.destroy(p)).state, 'destroyed');
  await assert.rejects(
    f.provider.execute({
      ...f.params,
      lease: { providerLeaseId: p.providerLeaseId, metadata: p.leaseMetadata },
      command: 'true',
    }),
    /Sandbox missing/,
  );
});
