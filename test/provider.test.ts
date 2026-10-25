import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../src/plugin.js';
import { ok, fake, release } from './helpers.js';
import { systemClock } from '../src/deadline.js';

test('fake lifecycle budgets are independent of wall-clock jumps', async (t) => {
  let wallTime = 0;
  t.mock.method(systemClock, 'now', () => (wallTime += 2000));
  const f = fake();
  const lease = await f.provider.acquire(f.params);
  assert.deepEqual(await f.provider.release(release(f, lease)), {
    providerLeaseId: 'sandbox-id',
    state: 'destroyed',
  });
  assert.equal(f.record, undefined);
});

test('draft probes return diagnostics and never allocate', async () => {
  const f = fake();
  const plugin = createPlugin(f.provider);
  assert.equal(
    (await plugin.definition.onEnvironmentProbe!(f.params)).ok,
    true,
  );
  assert.ok(f.calls.every((call) => call.args.includes('list')));
  f.fail((a) =>
    a.includes('list')
      ? { ...ok(), exitCode: 1, stderr: "Unknown gateway 'test'. secret-token" }
      : undefined,
  );
  const result = await plugin.definition.onEnvironmentProbe!(f.params);
  assert.equal(result.ok, false);
  assert.match(result.summary!, /gateway is not registered.*configHome/);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('ephemeral release deletes and confirms absence', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  assert.deepEqual(await f.provider.release(release(f, l)), {
    providerLeaseId: 'sandbox-id',
    state: 'destroyed',
  });
  assert.equal(f.record, undefined);
  assert.equal(f.calls.at(-1)?.args[5], 'list');
});
test('reuse retains, resumes, stops without deletion, and restarts', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  const p = release(f, l);
  await f.provider.release(p);
  assert.ok(f.record);
  assert.deepEqual(
    await f.provider.resume({ ...p, providerLeaseId: 'sandbox-id' }),
    l,
  );
  assert.deepEqual(await f.provider.stop(p), {
    providerLeaseId: 'sandbox-id',
    state: 'stopped',
  });
  assert.ok(!f.calls.some((c) => c.args.includes('delete')));
  await f.provider.resume({ ...p, providerLeaseId: 'sandbox-id' });
  assert.equal(f.record.phase, 'Ready');
  await f.provider.destroy(p);
  assert.equal(f.record, undefined);
});
test('release stop_and_retain preserves an ephemeral lease', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  assert.equal(
    (
      await f.provider.release({
        ...release(f, l),
        resourceDisposition: 'stop_and_retain',
      })
    )?.state,
    'stopped',
  );
  assert.ok(f.record);
});
test('failed or unconfirmed stop never substitutes deletion', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.fail((a) => (a.includes('stop') ? { ...ok(), exitCode: 1 } : undefined));
  await assert.rejects(f.provider.stop(release(f, l)));
  assert.ok(f.record);
  assert.ok(!f.calls.some((c) => c.args.includes('delete')));
  f.fail((a) => (a.includes('stop') ? ok() : undefined));
  await assert.rejects(
    f.provider.stop(release(f, l)),
    /confirmation timed out/,
  );
  assert.ok(f.record);
});
test('missing lease expires; transport or malformed list remains an error', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  f.record = undefined;
  assert.deepEqual(
    await f.provider.resume({
      ...release(f, l),
      providerLeaseId: 'sandbox-id',
    }),
    { providerLeaseId: null, metadata: { expired: true } },
  );
  for (const result of [{ ...ok(), exitCode: 1 }, ok('bad json'), ok('{}')]) {
    f.fail((a) => (a.includes('list') ? result : undefined));
    await assert.rejects(
      f.provider.resume({ ...release(f, l), providerLeaseId: 'sandbox-id' }),
    );
  }
});
test('paginated JSON inspection follows tokens and rejects repeated tokens', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  let page = 0;
  f.fail((a) =>
    a.includes('list')
      ? ok(
          JSON.stringify(
            page++ === 0
              ? { sandboxes: [], next_page_token: 'second' }
              : { sandboxes: [f.record], next_page_token: '' },
          ),
        )
      : undefined,
  );
  assert.equal(
    (
      await f.provider.resume({
        ...release(f, l),
        providerLeaseId: 'sandbox-id',
      })
    ).providerLeaseId,
    l.providerLeaseId,
  );
  assert.ok(f.calls.some((c) => c.args.includes('second')));
  f.fail((a) =>
    a.includes('list')
      ? ok(JSON.stringify({ sandboxes: [], next_page_token: 'loop' }))
      : undefined,
  );
  await assert.rejects(
    f.provider.resume({ ...release(f, l), providerLeaseId: 'sandbox-id' }),
    /pagination token/,
  );
});
test('turning reuse off expires or destroys retained leases and cancellation terminates', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  const p = {
    ...release(f, l),
    config: { ...f.params.config, reuseLease: false },
    providerLeaseId: 'sandbox-id',
  };
  assert.equal((await f.provider.resume(p)).providerLeaseId, null);
  assert.equal((await f.provider.release(p))?.state, 'destroyed');
  const g = fake({ reuseLease: true });
  const kept = await g.provider.acquire(g.params);
  assert.equal(
    (await g.provider.release({ ...release(g, kept), cancelActiveWork: true }))
      ?.state,
    'stopped',
  );
});
test('realization uses a remote directory and exposes fallback runtime metadata', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  assert.equal(l.metadata?.remoteCwd, '/sandbox/paperclip-workspace');
  assert.equal(l.metadata?.shellCommand, 'bash');
  assert.deepEqual(
    await f.provider.realize({
      ...f.params,
      lease: l,
      workspace: { remotePath: '/sandbox/custom workspace' },
    }),
    { cwd: '/sandbox/custom workspace' },
  );
  await assert.rejects(
    f.provider.execute({
      ...f.params,
      lease: l,
      command: 'true',
      env: { 'INVALID=KEY': 'x' },
    }),
    /environment/,
  );
});
test('destroy also honors explicit stop-and-retain disposition', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  assert.equal(
    (
      await f.provider.destroy({
        ...release(f, l),
        resourceDisposition: 'stop_and_retain',
      })
    ).state,
    'stopped',
  );
  assert.ok(f.record);
  assert.ok(!f.calls.some((c) => c.args.includes('delete')));
});
