import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironmentCreationCleanupError } from '@paperclipai/plugin-sdk';
import { commandFailure } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { identity } from '../src/identity.js';
import { SandboxClient } from '../src/sandbox-client.js';
import { createPlugin } from '../src/plugin.js';
import { cleanupConnection } from '../src/recovery.js';
import { fake, ok, release } from './helpers.js';

const interrupted = { ...ok(), exitCode: null, timedOut: true };
const unavailable = {
  ...ok(),
  exitCode: 1,
  stderr: 'status: Unavailable private-token',
};
const controls = (f: ReturnType<typeof fake>) =>
  f.calls.filter((call) =>
    ['start', 'resume', 'stop', 'delete', 'create'].includes(call.args[5]),
  );

for (const operation of ['start', 'resume', 'stop', 'delete']) {
  test(`${operation} confirms remote completion after a failed CLI response`, async () => {
    const f = fake({ reuseLease: true });
    const l = await f.provider.acquire(f.params);
    f.record!.phase =
      operation === 'start'
        ? 'Stopped'
        : operation === 'resume'
          ? 'Suspended'
          : 'Ready';
    let attempts = 0;
    f.fail((args) => {
      if (args[5] !== operation) return;
      attempts++;
      if (operation === 'delete') f.record = undefined;
      else f.record!.phase = operation === 'stop' ? 'Stopped' : 'Ready';
      return interrupted;
    });
    const p = release(f, l);
    const result =
      operation === 'delete'
        ? await f.provider.destroy(p)
        : operation === 'stop'
          ? await f.provider.stop(p)
          : await f.provider.resume({
              ...p,
              providerLeaseId: l.providerLeaseId!,
            });
    assert.equal(attempts, 1);
    assert.equal(result.providerLeaseId, l.providerLeaseId);
  });
}

for (const operation of ['start', 'resume', 'stop', 'delete']) {
  test(`${operation} retries only after a fresh ownership check`, async () => {
    const f = fake({ reuseLease: true });
    const l = await f.provider.acquire(f.params);
    f.record!.phase =
      operation === 'start'
        ? 'Stopped'
        : operation === 'resume'
          ? 'Suspended'
          : 'Ready';
    let attempts = 0;
    let first = -1;
    f.fail((args) => {
      if (args[5] !== operation) return;
      if (++attempts === 1) {
        first = f.calls.length - 1;
        return unavailable;
      }
      assert.ok(
        f.calls.slice(first + 1, -1).some((call) => call.args[5] === 'list'),
      );
    });
    const p = release(f, l);
    if (operation === 'delete') await f.provider.destroy(p);
    else if (operation === 'stop') await f.provider.stop(p);
    else await f.provider.resume({ ...p, providerLeaseId: l.providerLeaseId! });
    assert.equal(attempts, 2);
  });
}

test('transient command retries stop at three and still confirm the last outcome', async () => {
  for (const completes of [false, true]) {
    const f = fake();
    const l = await f.provider.acquire(f.params);
    let attempts = 0;
    f.fail((args) => {
      if (args[5] !== 'delete') return;
      if (++attempts === 3 && completes) f.record = undefined;
      return unavailable;
    });
    const pending = f.provider.destroy(release(f, l));
    if (completes) assert.equal((await pending).state, 'destroyed');
    else await assert.rejects(pending, /temporarily unavailable/);
    assert.equal(attempts, 3);
  }
});

for (const stderr of [
  "Unknown gateway 'private-token'",
  'authentication failed private-token',
  'certificate invalid private-token',
  'TLS handshake transport error private-token',
  'permission denied private-token',
  'unexpected argument private-token',
  'unknown failure private-token',
]) {
  test(`permanent lifecycle failure is not retried: ${stderr.split(' ')[0]}`, async () => {
    const f = fake();
    const l = await f.provider.acquire(f.params);
    f.fail((args) =>
      args[5] === 'delete' ? { ...ok(), exitCode: 1, stderr } : undefined,
    );
    await assert.rejects(f.provider.destroy(release(f, l)), (error: Error) => {
      assert.ok(!error.message.includes('private-token'));
      return true;
    });
    assert.equal(f.calls.filter((call) => call.args[5] === 'delete').length, 1);
    assert.ok(f.record);
  });
}

test('failure classification preserves constructor semantics and keeps timeouts ambiguous', () => {
  const c = parseConfig(fake().params.config);
  for (const stderr of [
    'connection refused',
    'code: Unavailable',
    'status: ResourceExhausted',
    'code: DeadlineExceeded',
  ]) {
    assert.equal(
      commandFailure(c, 'list', { ...ok(), exitCode: 1, stderr }).retryable,
      true,
    );
  }
  assert.equal(commandFailure(c, 'delete', interrupted).retryable, true);
  const rejected = commandFailure(c, 'create', {
    ...ok(),
    exitCode: 1,
    stderr: 'Unknown gateway private-token',
  });
  assert.equal(rejected.allocationImpossible, true);
  assert.equal(rejected.retryable, false);
  assert.equal(
    commandFailure(c, 'create', {
      ...interrupted,
      stderr: 'Unknown gateway private-token',
    }).allocationImpossible,
    false,
  );
});

test('resume preserves the recorded lease during a gateway outage', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  const before = controls(f).length;
  f.fail((args) => (args[5] === 'list' ? unavailable : undefined));
  const start = f.calls.length;
  await assert.rejects(
    f.provider.resume({
      ...release(f, l),
      providerLeaseId: l.providerLeaseId!,
    }),
  );
  assert.equal(f.calls.length - start, 3);
  assert.equal(controls(f).length, before);
  assert.ok(f.record);
});

test('retrying a later list page discards earlier matches and starts from page one', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const tokens: string[] = [];
  f.fail((args) => {
    if (args[5] !== 'list') return;
    const token = args[args.indexOf('--page-token') + 1];
    tokens.push(token);
    if (tokens.length === 1)
      return ok(
        JSON.stringify({ sandboxes: [f.record], next_page_token: 'second' }),
      );
    if (tokens.length === 2) return unavailable;
    return ok(JSON.stringify({ sandboxes: [], next_page_token: '' }));
  });
  assert.equal(
    (
      await f.provider.inspect({
        ...release(f, l),
        providerLeaseId: l.providerLeaseId!,
      })
    ).state,
    'destroyed',
  );
  assert.deepEqual(tokens, ['', 'second', '']);
});

test('recovery rejects exhausted deadlines without invoking the runner and reserves confirmation time', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, l.providerLeaseId, l.metadata, c);
  let now = 0;
  const client = new SandboxClient(f.runner, 1, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const start = f.calls.length;
  await assert.rejects(client.inspectRecovery(c, i.name, 0), /deadline/);
  await assert.rejects(
    client.transition(c, i, 'Stopped', 0),
    /confirmation timed out/,
  );
  assert.equal(f.calls.length, start);
  await client.transition(c, i, 'Stopped', 30_000);
  assert.ok(
    f.calls
      .slice(start)
      .every((call) => call.timeout > 0 && call.timeout <= 10_000),
  );
  assert.ok(f.calls.slice(start).some((call) => call.args[5] === 'stop'));
});

test('resume waits for suspension to finish before issuing resume', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  f.record!.phase = 'Suspending';
  let reads = 0;
  f.fail((args) => {
    if (args[5] === 'list' && ++reads === 3) f.record!.phase = 'Suspended';
  });
  await f.provider.resume({
    ...release(f, l),
    providerLeaseId: l.providerLeaseId!,
  });
  assert.equal(f.calls.filter((call) => call.args[5] === 'resume').length, 1);
  assert.ok(!f.calls.some((call) => call.args[5] === 'start'));
});

test('a timed-out control invocation leaves budget for confirmation', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, l.providerLeaseId, l.metadata, c);
  let now = 0;
  const budgets: number[] = [];
  const client = new SandboxClient(
    async (...args) => {
      budgets.push(args[2]);
      assert.ok(args[2] <= Math.max(1, Math.floor((1000 - now) / 2)));
      if (args[1][5] === 'stop') {
        now += args[2];
        f.record!.phase = 'Stopped';
        return interrupted;
      }
      return f.runner(...args);
    },
    1,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  await client.transition(c, i, 'Stopped', 1000);
  assert.equal(budgets.length, 3);
  assert.ok(now < 1000);
});

test('malformed later pages do not authorize a control command or a retry', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const start = f.calls.length;
  let reads = 0;
  f.fail((args) => {
    if (args[5] !== 'list') return;
    return ++reads === 1
      ? ok(JSON.stringify({ sandboxes: [f.record], next_page_token: 'second' }))
      : ok('malformed');
  });
  await assert.rejects(f.provider.destroy(release(f, l)), /Malformed/);
  assert.equal(f.calls.length - start, 2);
  assert.ok(f.record);
});

test('ownership changes between control retries prevent replay', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  let attempts = 0;
  f.fail((args) => {
    if (args[5] !== 'delete') return;
    attempts++;
    f.record!.id = 'replacement';
    return unavailable;
  });
  await assert.rejects(f.provider.destroy(release(f, l)), /ownership/);
  assert.equal(attempts, 1);
});

test('invalid persisted connection fields fail before any runner call', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  for (const saved of [
    null,
    {},
    { gateway: '' },
    { gateway: 'test', workspace: 42 },
  ]) {
    const before = f.calls.length;
    const p = {
      ...release(f, l),
      leaseMetadata: { ...l.metadata, openshell: saved },
    };
    await assert.rejects(f.provider.destroy(p), /Invalid/);
    assert.equal(f.calls.length, before);
  }
});

test('deletion already underway is polled without sending delete again', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.record!.phase = 'Deleting';
  let reads = 0;
  f.fail((args) => {
    if (args[5] === 'list' && ++reads === 2) f.record = undefined;
  });
  assert.equal((await f.provider.destroy(release(f, l))).state, 'destroyed');
  assert.ok(!f.calls.some((call) => call.args[5] === 'delete'));
});

test('inspection is read-only, maps verified phases, and does not admit duplex execution', async () => {
  const f = fake({ enableDuplex: true });
  const l = await f.provider.acquire(f.params);
  await f.provider.shutdown();
  // A fresh worker has no executable lease in memory.
  const fresh = fake({ enableDuplex: true });
  fresh.record = f.record;
  const p = { ...release(f, l), providerLeaseId: l.providerLeaseId! };
  const plugin = createPlugin(fresh.provider);
  for (const [phase, state] of [
    ['Ready', 'active'],
    ['Stopped', 'stopped'],
    ['Suspended', 'unknown'],
    ['Error', 'unknown'],
    ['Deleting', 'unknown'],
  ]) {
    fresh.record!.phase = phase;
    assert.deepEqual(await plugin.definition.onEnvironmentInspectLease!(p), {
      providerLeaseId: l.providerLeaseId,
      state,
    });
  }
  assert.ok(fresh.calls.every((call) => call.args[5] === 'list'));
  await assert.rejects(
    fresh.provider.duplex.open({
      ...p,
      hostRouteId: 'inspection-only',
      command: ['cat'],
    }),
    /unknown/,
  );
  fresh.record = undefined;
  assert.equal((await fresh.provider.inspect(p)).state, 'destroyed');
});

test('inspection never converts ownership or transport failures to absence', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const p = { ...release(f, l), providerLeaseId: l.providerLeaseId! };
  f.record!.id = 'replacement';
  await assert.rejects(f.provider.inspect(p), /ownership/);
  f.fail((args) => (args[5] === 'list' ? unavailable : undefined));
  await assert.rejects(f.provider.inspect(p), /temporarily unavailable/);
});

test('failed-create inspection keeps unobserved absence uncertain and never journals or deletes', async () => {
  const f = fake();
  f.fail((args) => (args[5] === 'create' ? ok('malformed') : undefined));
  let cleanup: any;
  await assert.rejects(f.provider.acquire(f.params), (error) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    return !!cleanup;
  });
  f.fail(undefined);
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  assert.equal((await f.provider.inspect(p)).state, 'unknown');
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    labels: cleanup.labels,
    workspace: 'default',
    phase: 'Ready',
  };
  assert.equal((await f.provider.inspect(p)).state, 'active');
  assert.equal(cleanup.observedProviderLeaseId, undefined);
  assert.ok(!f.calls.some((call) => call.args[5] === 'delete'));
});

test('failed-create recovery uses the host-saved connection after environment edits and worker restart', async () => {
  const f = fake();
  f.fail((args) =>
    args[5] === 'exec' || args[5] === 'delete'
      ? { ...ok(), exitCode: 1 }
      : undefined,
  );
  let cleanup: any;
  await assert.rejects(f.provider.acquire(f.params), (error) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    return !!cleanup;
  });
  const fresh = fake();
  fresh.record = f.record;
  const p = {
    ...f.params,
    config: { gateway: 'edited', workspace: 'edited' },
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: {
      gateway: 'test',
      workspace: 'default',
      configHome: '/original/config',
      failedCreateCleanup: cleanup,
    },
  };
  assert.equal((await fresh.provider.destroy(p)).state, 'destroyed');
  assert.ok(
    fresh.calls.every(
      (call) =>
        call.args[1] === 'test' &&
        call.args[3] === 'default' &&
        call.env?.XDG_CONFIG_HOME === '/original/config',
    ),
  );
});

test('recovery entry precedes current config, but cannot redirect persisted scope', () => {
  const current = { gateway: 'edited', workspace: 'edited' };
  const recovery = {
    environmentId: 'environment',
    gateway: 'test',
    workspace: 'default',
    configHome: '/moved/config',
    rejectedAttemptIds: [],
  };
  assert.equal(cleanupConnection({}, current, recovery).c.gateway, 'test');
  assert.equal(
    cleanupConnection({ gateway: 'original' }, current, recovery).c.gateway,
    'original',
  );
  assert.equal(
    cleanupConnection({ gateway: 'original' }, current, recovery).c.configHome,
    undefined,
  );
  for (const metadata of [
    { openshell: null },
    { openshell: {} },
    { gateway: '' },
    { gateway: 42 },
    { gateway: 'test', configHome: 'relative' },
  ]) {
    assert.throws(
      () => cleanupConnection(metadata, current, recovery),
      /Invalid/,
    );
  }
});

test('local invalidation failure does not prevent provider stop or deletion', async () => {
  for (const operation of ['stop', 'destroy'] as const) {
    const f = fake();
    const l = await f.provider.acquire(f.params);
    f.provider.duplex.invalidate = async () => {
      throw new Error('private-token');
    };
    assert.equal(
      (await f.provider[operation](release(f, l))).state,
      operation === 'stop' ? 'stopped' : 'destroyed',
    );
  }
});
