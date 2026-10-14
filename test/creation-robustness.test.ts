import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironmentCreationCleanupError } from '@paperclipai/plugin-sdk';
import { parseConfig } from '../src/config.js';
import { acquire } from '../src/acquisition.js';
import { identity } from '../src/identity.js';
import { SandboxClient } from '../src/sandbox-client.js';
import { fake, ok, config } from './helpers.js';

const hostFields = {
  driver: 'openshell',
  pluginId: 'installed-plugin-id',
  pluginKey: 'paperclip.openshell-sandbox-provider',
  sandboxProviderPlugin: 'installed-plugin-id',
  pendingCleanupAttemptId: 'private-bookkeeping',
  failedCreateCleanup: { privateValue: 'private-bookkeeping' },
};

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
