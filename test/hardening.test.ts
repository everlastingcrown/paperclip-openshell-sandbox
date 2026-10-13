import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginEnvironmentCreationCleanupError,
  readEnvironmentCreationCleanupError,
} from '@paperclipai/plugin-sdk';
import { acquire } from '../src/acquisition.js';
import { parseConfig } from '../src/config.js';
import { OpenShellCommandError } from '../src/cli.js';
import { identity, nameFor } from '../src/identity.js';
import { SandboxClient } from '../src/sandbox-client.js';
import { base, fake, ok, release } from './helpers.js';

for (const operation of ['list', 'exec']) {
  test(`allocation-impossible error during ${operation} after create still cleans up`, async () => {
    const f = fake();
    let failed = false;
    f.fail((args) => {
      if (f.record && args[5] === operation && !failed) {
        failed = true;
        throw new OpenShellCommandError('CLI unavailable', true);
      }
    });
    await assert.rejects(
      f.provider.acquire(f.params),
      /owned allocation cleaned up/,
    );
    assert.equal(f.record, undefined);
    assert.ok(f.calls.some((c) => c.args[5] === 'delete'));
  });
}

test('persistent readiness failure returns observed identity for reconciliation', async () => {
  const f = fake();
  f.fail((args) =>
    f.record && args[5] === 'list'
      ? { ...ok(), exitCode: 1, stderr: 'Unknown gateway private-token' }
      : undefined,
  );
  await assert.rejects(f.provider.acquire(f.params), (error: unknown) => {
    const cleanup = readEnvironmentCreationCleanupError(error);
    assert.equal(cleanup?.observedProviderLeaseId, 'sandbox-id');
    assert.ok(error instanceof PluginEnvironmentCreationCleanupError);
    assert.ok(!error.message.includes('private-token'));
    assert.ok(!error.message.includes('no allocation created'));
    return true;
  });
});

test('lease identity rejects malformed attempt UUIDs even with matching names', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  for (const attempt of ['a'.repeat(36), '-'.repeat(36)]) {
    const openshell = l.metadata!.openshell as Record<string, unknown>;
    const labels = {
      ...(openshell.labels as Record<string, string>),
      'paperclip-attempt': attempt,
    };
    const before = f.calls.length;
    await assert.rejects(
      f.provider.destroy({
        ...release(f, l),
        leaseMetadata: {
          openshell: { ...openshell, name: nameFor(attempt), labels },
        },
      }),
      /ownership/,
    );
    assert.equal(f.calls.length, before);
  }
});

test('failed-create metadata rejects empty observed IDs before any CLI command', async () => {
  const f = fake();
  f.fail((args) => (args[5] === 'create' ? ok('malformed') : undefined));
  let cleanup;
  try {
    await f.provider.acquire(f.params);
  } catch (error) {
    cleanup = readEnvironmentCreationCleanupError(error);
  }
  assert.ok(cleanup);
  for (const id of ['', ' ', '\0']) {
    const before = f.calls.length;
    await assert.rejects(
      f.provider.destroy({
        ...f.params,
        providerLeaseId: cleanup.providerLeaseId,
        leaseMetadata: {
          failedCreateCleanup: { ...cleanup, observedProviderLeaseId: id },
        },
      }),
      /ownership/,
    );
    assert.equal(f.calls.length, before);
  }
});

for (const second of ['duplicate', 'malformed', 'loop']) {
  test(`lookup validates pages after a match: ${second}`, async () => {
    const f = fake();
    const l = await f.provider.acquire(f.params);
    let page = 0;
    f.fail((args) =>
      args[5] === 'list'
        ? ok(
            JSON.stringify(
              page++ === 0
                ? { sandboxes: [f.record], next_page_token: 'next' }
                : second === 'malformed'
                  ? { sandboxes: [null], next_page_token: '' }
                  : {
                      sandboxes: second === 'duplicate' ? [f.record] : [],
                      next_page_token: second === 'loop' ? 'next' : '',
                    },
            ),
          )
        : undefined,
    );
    await assert.rejects(
      f.provider.destroy(release(f, l)),
      /Ambiguous|shape|pagination token/,
    );
    assert.ok(!f.calls.some((c) => c.args[5] === 'delete'));
  });
}

test('pagination limit fails closed', async () => {
  const f = fake();
  let page = 0;
  f.fail((args) =>
    args[5] === 'list'
      ? ok(JSON.stringify({ sandboxes: [], next_page_token: String(++page) }))
      : undefined,
  );
  const clock = { now: () => 0, async sleep() {} };
  await assert.rejects(
    new SandboxClient(f.runner, 1, clock).inspect(
      parseConfig(f.params.config, f.settings),
      'name',
      1000,
    ),
    /pagination limit/,
  );
  assert.equal(page, 1000);
});

test('expired deadline never invokes an injected runner', async () => {
  const f = fake();
  const client = new SandboxClient(f.runner, 1, {
    now: () => 1000,
    async sleep() {},
  });
  await assert.rejects(
    client.inspect(parseConfig(f.params.config, f.settings), 'name', 1000),
    /deadline exceeded/,
  );
  assert.equal(f.calls.length, 0);
});

test('setup deadline exhaustion preserves observed creation identity', async () => {
  const f = fake();
  let now = 0;
  const client = new SandboxClient(
    async (...args) => {
      const result = await f.runner(...args);
      if (args[1][5] === 'create') now = 950;
      return result;
    },
    1,
    {
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
    },
  );
  await assert.rejects(
    acquire(f.params, parseConfig(f.params.config, f.settings), client),
    /owned allocation cleaned up/,
  );
  assert.equal(f.record, undefined);
  assert.ok(f.calls.every((c) => c.timeout > 0));
});

test('invalid execution input rejects before gateway inspection', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  for (const input of [
    { command: '\0' },
    { args: ['\0'] },
    { cwd: 'relative' },
    { env: { 'invalid-key': 'value' } },
    { timeoutMs: 0 },
    { stdin: 42 },
    { args: {} },
    { command: 42 },
    { cwd: 42 },
  ]) {
    const before = f.calls.length;
    await assert.rejects(
      f.provider.execute({
        ...f.params,
        lease: l,
        command: 'node',
        ...input,
      } as any),
      /Invalid/,
    );
    assert.equal(f.calls.length, before);
  }
});

test('ownership replacement during stop polling never returns a receipt', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const owned = identity(
    base,
    l.providerLeaseId,
    l.metadata,
    parseConfig(f.params.config, f.settings),
  );
  const client = new SandboxClient(f.runner, 1, {
    now: () => 0,
    async sleep() {
      assert.ok(f.record);
      f.record.id = 'replacement';
      f.record.phase = 'Stopped';
    },
  });
  assert.ok(f.record);
  f.record.phase = 'Stopping';
  await assert.rejects(
    client.wait(
      parseConfig(f.params.config, f.settings),
      owned,
      'Stopped',
      1000,
    ),
    /ownership/,
  );
  assert.ok(!f.calls.some((c) => c.args[5] === 'delete'));
});

test('arbitrary runner errors are excluded from lifecycle logs and RPC errors', async () => {
  const f = fake();
  const messages: unknown[] = [];
  f.provider.setLogger({
    info() {},
    debug() {},
    warn() {},
    error(_message, fields) {
      messages.push(fields);
    },
  });
  f.fail(() => {
    throw new Error('private-runner-secret');
  });
  await assert.rejects(f.provider.acquire(f.params), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('private-runner-secret'));
    assert.ok(!JSON.stringify(messages).includes('private-runner-secret'));
    return true;
  });
});

for (const interruption of [
  { timedOut: true, signal: null },
  { timedOut: false, signal: 'SIGKILL' },
]) {
  test(`interrupted create cannot prove rejection (timeout=${interruption.timedOut})`, async () => {
    const f = fake();
    f.fail((args) =>
      args[5] === 'create'
        ? {
            ...ok(),
            exitCode: null,
            stderr: 'Unknown gateway private-token',
            ...interruption,
          }
        : undefined,
    );
    await assert.rejects(
      f.provider.acquire(f.params),
      PluginEnvironmentCreationCleanupError,
    );
  });
}

test('updated cleanup evidence excludes unknown metadata fields', async () => {
  const f = fake();
  f.fail((args) => (args[5] === 'create' ? ok('malformed') : undefined));
  let cleanup;
  try {
    await f.provider.acquire(f.params);
  } catch (error) {
    cleanup = readEnvironmentCreationCleanupError(error);
  }
  assert.ok(cleanup);
  f.fail(undefined);
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: cleanup.labels,
  };
  await assert.rejects(
    f.provider.destroy({
      ...f.params,
      providerLeaseId: cleanup.providerLeaseId,
      leaseMetadata: {
        failedCreateCleanup: { ...cleanup, privateField: 'private-token' },
      },
    }),
    (error: unknown) => {
      const updated = readEnvironmentCreationCleanupError(error);
      assert.equal(updated?.observedProviderLeaseId, 'late-id');
      assert.ok(!JSON.stringify(updated).includes('private-token'));
      return true;
    },
  );
  assert.ok(!f.calls.some((c) => c.args[5] === 'delete'));
});
