import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxClient } from '../src/sandbox-client.js';
import { parseConfig } from '../src/config.js';
import { identity } from '../src/identity.js';
import { fake, ok } from './helpers.js';

test('100 concurrent execution inspections share pagination without caching ownership', async () => {
  const f = fake();
  const lease = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, lease.providerLeaseId, lease.metadata, c);
  const client = new SandboxClient(f.runner);
  let pages = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.fail(async (args) => {
    if (!args.includes('list')) return;
    pages++;
    await gate;
    assert.equal(
      args[args.indexOf('--selector') + 1],
      `paperclip-attempt=${i.labels['paperclip-attempt']}`,
    );
    return ok(JSON.stringify({ sandboxes: [f.record], next_page_token: '' }));
  });
  const results = Array.from({ length: 100 }, () =>
    client.inspectExecution(c, i, Date.now() + 1000),
  );
  finish();
  await Promise.all(results);
  assert.equal(pages, 1);
  f.record!.id = 'replacement';
  assert.equal(
    (await client.inspectExecution(c, i, Date.now() + 1000))!.id,
    'replacement',
  );
  assert.equal(pages, 2);
});

test('failed execution inspections are evicted and shorter deadlines get independent work', async () => {
  const f = fake();
  const lease = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, lease.providerLeaseId, lease.metadata, c);
  const client = new SandboxClient(f.runner);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let pages = 0;
  f.fail(async (args) => {
    if (!args.includes('list')) return;
    pages++;
    await gate;
    return ok('invalid JSON');
  });
  const deadline = Date.now() + 10000;
  const first = client.inspectExecution(c, i, deadline);
  const shorter = client.inspectExecution(c, i, deadline - 1000);
  finish();
  assert.equal(
    (await Promise.allSettled([first, shorter])).filter(
      (r) => r.status === 'rejected',
    ).length,
    2,
  );
  assert.equal(pages, 2);
  f.fail(undefined);
  assert.equal(
    (await client.inspectExecution(c, i, deadline))!.id,
    lease.providerLeaseId,
  );
});

test('inspection and exec consume one deadline and never launch an expired command', async () => {
  const f = fake();
  const lease = await f.provider.acquire(f.params);
  const client = (f.provider as unknown as { client: SandboxClient }).client;
  let now = 1000;
  Object.defineProperty(client, 'clock', {
    value: { now: () => now, sleep: async () => {} },
  });
  f.fail((args) => {
    if (args.includes('list')) now += 40;
  });
  await f.provider.execute({
    ...f.params,
    lease,
    command: 'true',
    timeoutMs: 100,
  });
  assert.equal(f.calls.at(-1)!.timeout, 60);
  f.fail((args) => {
    if (args.includes('list')) now += 101;
  });
  const before = f.calls.filter((c) => c.args.includes('exec')).length;
  await assert.rejects(
    f.provider.execute({ ...f.params, lease, command: 'true', timeoutMs: 100 }),
    /deadline exceeded/,
  );
  assert.equal(f.calls.filter((c) => c.args.includes('exec')).length, before);
});
