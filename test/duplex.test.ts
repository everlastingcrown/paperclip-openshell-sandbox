import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { encodeChannelBytes } from '@paperclipai/plugin-sdk';
import {
  DuplexChannels,
  duplexLimits,
  sshArgs,
  quote,
  type DuplexLauncher,
} from '../src/duplex.js';
import { OpenShellProvider } from '../src/provider.js';
import { parseConfig } from '../src/config.js';
import { identity } from '../src/identity.js';
import { fake, release, ok } from './helpers.js';
const request = {
  hostRouteId: 'route',
  driverKey: 'openshell',
  companyId: 'company',
  environmentId: 'environment',
  providerLeaseId: 'sandbox-id',
  command: ['cat'],
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  options: { blocked?: boolean; early?: boolean; spawnError?: boolean } = {},
) {
  const child: any = new EventEmitter();
  const input: Buffer[] = [];
  child.stdin = options.blocked
    ? new Writable({ write(_data, _encoding, _done) {} })
    : new Writable({
        write(data, _encoding, done) {
          input.push(Buffer.from(data));
          done();
        },
      });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  child.kill = () => {
    kills++;
    child.emit('close', null, 'SIGTERM');
  };
  child.stdin.on('finish', () => {
    child.emit('close', 0, null);
  });
  const launched: any[] = [];
  const launcher: DuplexLauncher = (executable, args, env) => {
    launched.push({ executable, args, env });
    queueMicrotask(() => {
      if (options.spawnError)
        child.emit('error', new Error('secret credentials'));
      else {
        child.emit('spawn');
        if (options.early) child.emit('close', 255, null);
      }
    });
    return child;
  };
  const f = fake({
    enableDuplex: true,
    reuseLease: true,
    configHome: '/worker/config',
  });
  const provider = new OpenShellProvider(f.runner, 1, launcher);
  const events: any[] = [];
  provider.duplex.notifications = {
    data: (route, session, data) =>
      events.push({ route, session, data: Buffer.from(data) }),
    exit: (route, session, code, lost) =>
      events.push({ route, session, code, lost }),
  };
  return {
    f,
    provider,
    child,
    input,
    launched,
    events,
    get kills() {
      return kills;
    },
  };
}
test('SSH quoting and isolation match pinned tunnel contract', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const c = parseConfig({
    ...f.params.config,
    executable: "/path/a 'b%/openshell",
  });
  const i = identity(f.params, l.providerLeaseId, l.metadata, c);
  const args = sshArgs(c, i, ['node', '-e', "a 'b; $(echo unsafe)\n"]);
  assert.deepEqual(args.slice(0, 3), ['-F', '/dev/null', '-T']);
  assert.ok(args.includes('SetEnv=OPENSHELL_NO_LOGIN_SHELL=1'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(
    args
      .find((s) => s.startsWith('ProxyCommand='))!
      .includes("'\\''b%%/openshell'"),
  );
  assert.equal(
    args.at(-1),
    ['node', '-e', "a 'b; $(echo unsafe)\n"].map(quote).join(' '),
  );
});
test('binary output and delayed writes keep stdin open; exact pair, strict bytes and route-only close', async () => {
  const t = fixture();
  await t.provider.acquire(t.f.params);
  const savedOverride = process.env.OPENSHELL_GATEWAY_ENDPOINT;
  process.env.OPENSHELL_GATEWAY_ENDPOINT = 'unscoped';
  try {
    const pair = await t.provider.duplex.open(request);
    assert.equal(t.launched[0].env.OPENSHELL_GATEWAY_ENDPOINT, undefined);
    assert.equal(t.launched[0].env.XDG_CONFIG_HOME, '/worker/config');
    assert.equal(t.child.stdin.writableEnded, false);
    const binary = Buffer.from([0, 255, 128, 10]);
    t.child.stdout.write(binary);
    t.child.stderr.write('secret diagnostic');
    await tick();
    await t.provider.duplex.write({
      ...pair,
      data: encodeChannelBytes(binary),
    });
    await t.provider.duplex.write({
      ...pair,
      data: encodeChannelBytes(Buffer.from('later')),
    });
    assert.deepEqual(t.input, [binary, Buffer.from('later')]);
    assert.deepEqual(t.events[0].data, binary);
    await assert.rejects(
      t.provider.duplex.write({ ...pair, workerSessionId: 'wrong', data: '' }),
      /unavailable/,
    );
    await assert.rejects(
      t.provider.duplex.stop({ ...pair, hostRouteId: 'wrong' }),
      /unavailable/,
    );
    await assert.rejects(
      t.provider.duplex.write({ ...pair, data: '###' }),
      /Invalid/,
    );
    await assert.rejects(t.provider.duplex.open(request), /registered/);
    assert.deepEqual(
      await t.provider.duplex.close({
        hostRouteId: request.hostRouteId,
        workerSessionId: 'wrong',
      }),
      pair,
    );
    assert.deepEqual(
      await t.provider.duplex.close({ hostRouteId: request.hostRouteId }),
      pair,
    );
    assert.equal(t.events.filter((e) => 'code' in e).length, 1);
    assert.equal(t.events.at(-1).lost, true);
  } finally {
    if (savedOverride === undefined)
      delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
    else process.env.OPENSHELL_GATEWAY_ENDPOINT = savedOverride;
    await t.provider.shutdown();
  }
});
test('unknown, disabled and cross-scope leases never spawn', async () => {
  const t = fixture();
  await assert.rejects(t.provider.duplex.open(request), /unavailable/);
  await t.provider.acquire({
    ...t.f.params,
    config: { ...t.f.params.config, enableDuplex: false },
  });
  await assert.rejects(
    t.provider.duplex.open({ ...request, hostRouteId: 'disabled' }),
    /unavailable/,
  );
  await t.provider.resume(release(t.f, await t.provider.acquire(t.f.params)));
  for (const changes of [
    { companyId: 'other' },
    { environmentId: 'other' },
    { providerLeaseId: 'other' },
    { driverKey: 'other' },
  ])
    await assert.rejects(
      t.provider.duplex.open({
        ...request,
        ...changes,
        hostRouteId: JSON.stringify(changes),
      }),
      /unavailable/,
    );
  assert.equal(t.launched.length, 0);
  await t.provider.shutdown();
});
test('fresh lookup rejects replacement, ownership mismatch, malformed later pages and stopped sandbox', async () => {
  for (const mode of ['replacement', 'labels', 'pagination', 'stopped']) {
    const t = fixture();
    await t.provider.acquire(t.f.params);
    if (mode === 'replacement') t.f.record!.id = 'replacement';
    if (mode === 'labels') t.f.record!.labels = {};
    if (mode === 'stopped') t.f.record!.phase = 'Stopped';
    if (mode === 'pagination')
      t.f.fail((args) =>
        args[5] === 'list'
          ? ok(
              JSON.stringify(
                args.includes('--page-token')
                  ? { invalid: true }
                  : { sandboxes: [t.f.record], next_page_token: 'next' },
              ),
            )
          : undefined,
      );
    await assert.rejects(t.provider.duplex.open(request), /unavailable/);
    assert.equal(t.launched.length, 0);
    await t.provider.shutdown();
  }
});
test('close, stop, destroy, release and shutdown cancel a lookup in progress', async () => {
  for (const operation of ['close', 'stop', 'destroy', 'release', 'shutdown']) {
    const t = fixture();
    const l = await t.provider.acquire(t.f.params);
    let entered!: () => void;
    let finish!: () => void;
    const inspecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let first = true;
    t.f.fail(async (args) => {
      if (args[5] === 'list' && first) {
        first = false;
        entered();
        await hold;
      }
      return undefined;
    });
    const opening = t.provider.duplex.open(request);
    const failed = assert.rejects(opening, /unavailable/);
    await inspecting;
    if (operation === 'close')
      await t.provider.duplex.close({ hostRouteId: 'route' });
    else if (operation === 'shutdown') await t.provider.shutdown();
    else
      await t.provider[operation as 'stop' | 'destroy' | 'release'](
        release(t.f, l),
      );
    finish();
    await failed;
    await tick();
    assert.equal(t.launched.length, 0);
    await t.provider.shutdown();
  }
});
test('failed resume invalidates registry; opt-in refresh leaves established channels alive', async () => {
  const t = fixture();
  const l = await t.provider.acquire(t.f.params);
  const pair = await t.provider.duplex.open(request);
  await t.provider.execute({
    ...t.f.params,
    config: { ...t.f.params.config, enableDuplex: false },
    lease: l,
    command: 'true',
  });
  await assert.rejects(
    t.provider.duplex.open({ ...request, hostRouteId: 'off' }),
    /unavailable/,
  );
  await t.provider.duplex.write({
    ...pair,
    data: encodeChannelBytes(Buffer.from('still live')),
  });
  t.f.record!.id = 'replacement';
  await assert.rejects(t.provider.resume(release(t.f, l)), /mismatch/);
  assert.equal(t.events.at(-1).lost, true);
  await assert.rejects(
    t.provider.duplex.open({ ...request, hostRouteId: 'invalid' }),
    /unavailable/,
  );
  await t.provider.shutdown();
});
test('early exit, spawn failures and remote exit emit one ordered termination', async () => {
  for (const options of [{ early: true }, { spawnError: true }, {}]) {
    const t = fixture(options);
    await t.provider.acquire(t.f.params);
    if (options.early || options.spawnError)
      await assert.rejects(t.provider.duplex.open(request), /unavailable/);
    else {
      await t.provider.duplex.open(request);
      t.child.stdout.write(Buffer.from('last'));
      t.child.emit('close', 7, null);
      assert.equal(t.events.at(-1).code, 7);
      assert.equal(t.events.at(-1).lost, false);
    }
    t.child.emit('close', 0, null);
    await t.provider.shutdown();
    assert.equal(t.events.filter((e) => 'code' in e).length, 1);
  }
});
test('serialized input bounds pending bytes and frames under a slow consumer', async () => {
  const t = fixture({ blocked: true });
  await t.provider.acquire(t.f.params);
  const pair = await t.provider.duplex.open(request);
  const pending: Promise<unknown>[] = [];
  const payload = encodeChannelBytes(Buffer.alloc(duplexLimits.frameBytes));
  for (let index = 0; index < 24; index++)
    pending.push(
      t.provider.duplex.write({ ...pair, data: payload }).catch((e) => e),
    );
  const results = await Promise.all(pending);
  assert.ok(
    results.some((e) => e instanceof Error && /queue exceeded/.test(e.message)),
  );
  assert.equal(t.events.filter((e) => 'code' in e).length, 1);
  await t.provider.shutdown();
});
test('real streaming subprocess receives binary delayed stdin without EOF and exits cleanly', async () => {
  const launcher: DuplexLauncher = () =>
    spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  const channels = new DuplexChannels(
    async () => ({
      c: parseConfig({ gateway: 'g', image: 'i', enableDuplex: true }),
      i: {
        name: 'sandbox',
        labels: {},
        gateway: 'g',
        workspace: 'default',
        remotePath: '/',
        reuseLease: true,
      },
      valid: () => true,
    }),
    launcher,
  );
  const chunks: Buffer[] = [];
  let notify!: () => void;
  const output = new Promise<void>((resolve) => {
    notify = resolve;
  });
  channels.notifications = {
    data: (_r, _s, data) => {
      chunks.push(Buffer.from(data));
      if (Buffer.concat(chunks).length >= 5) notify();
    },
    exit: () => {},
  };
  try {
    const pair = await channels.open(request);
    await channels.write({
      ...pair,
      data: encodeChannelBytes(Buffer.from([0, 255])),
    });
    await tick();
    await channels.write({
      ...pair,
      data: encodeChannelBytes(Buffer.from([128, 1, 2])),
    });
    const timer = setTimeout(notify, 3000);
    await output;
    clearTimeout(timer);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 128, 1, 2]));
  } finally {
    await channels.shutdown();
  }
});

test('open timeout and close during subprocess startup cannot resurrect routes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, l.providerLeaseId, l.metadata, c);
  for (const mode of ['lookup-timeout', 'spawn-close', 'stale']) {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.resume();
    child.stdin.on('finish', () => child.emit('close', 0, null));
    child.kill = () => child.emit('close', null, 'SIGTERM');
    let valid = true;
    let spawned = false;
    const channels = new DuplexChannels(
      async () => {
        if (mode === 'lookup-timeout') await new Promise(() => {});
        return { c, i, valid: () => valid };
      },
      () => {
        spawned = true;
        return child;
      },
      () => 100,
    );
    const opening = channels.open(request);
    const failed = assert.rejects(opening, /unavailable/);
    await tick();
    if (mode === 'lookup-timeout') t.mock.timers.tick(duplexLimits.openMs);
    else if (mode === 'spawn-close')
      await channels.close({ hostRouteId: request.hostRouteId });
    else {
      valid = false;
      child.emit('spawn');
    }
    await failed;
    assert.equal(spawned, mode !== 'lookup-timeout');
    child.emit('spawn');
    await assert.rejects(
      channels.write({
        hostRouteId: request.hostRouteId,
        workerSessionId: 'late',
        data: '',
      }),
      /unavailable/,
    );
    await channels.shutdown();
  }
});

test('teardown of one company leaves another company route running', async () => {
  const t = fixture();
  const lease = await t.provider.acquire(t.f.params);
  const pair = await t.provider.duplex.open(request);
  await assert.rejects(
    t.provider.stop({ ...release(t.f, lease), companyId: 'other-company' }),
    /mismatch/,
  );
  await t.provider.duplex.write({ ...pair, data: 'AA==' });
  assert.equal(t.events.length, 0);
  await t.provider.shutdown();
});

test('validation completing after teardown cannot reinsert a stale lease', async () => {
  const t = fixture();
  const l = await t.provider.acquire(t.f.params);
  let entered!: () => void;
  let finish!: () => void;
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.f.fail(async (args) => {
    if (args[5] === 'exec') {
      entered();
      await hold;
    }
    return undefined;
  });
  const execution = t.provider.execute({
    ...t.f.params,
    lease: l,
    command: 'true',
  });
  await start;
  await t.provider.release(release(t.f, l));
  finish();
  await execution;
  await assert.rejects(t.provider.duplex.open(request), /unavailable/);
  assert.equal(t.launched.length, 0);
  await t.provider.shutdown();
});

test('cancellable lookup runner terminates its local process and rejects pre-aborted calls', async () => {
  const { createRunner } = await import('../src/cli.js');
  let child: ReturnType<typeof spawn> | undefined;
  const runner = createRunner(((...args: Parameters<typeof spawn>) => {
    child = spawn(...args);
    return child;
  }) as typeof spawn);
  const cancel = new AbortController();
  const running = runner(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    5000,
    undefined,
    undefined,
    undefined,
    cancel.signal,
  );
  const rejected = assert.rejects(running, /cancelled/);
  await new Promise<void>((resolve) => child!.once('spawn', resolve));
  cancel.abort();
  await rejected;
  assert.ok(child!.exitCode !== null || child!.signalCode !== null);
  child = undefined;
  await assert.rejects(
    runner(
      process.execPath,
      [],
      1000,
      undefined,
      undefined,
      undefined,
      cancel.signal,
    ),
    /cancelled/,
  );
  assert.equal(child, undefined);
});

test('forced close reaps SSH replacement and its proxy process group', async () => {
  let parent: ReturnType<typeof spawn> | undefined;
  let helperPid = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const channels = new DuplexChannels(
    async () => ({
      c: parseConfig({ gateway: 'g', image: 'i', enableDuplex: true }),
      i: {
        name: 'sandbox',
        labels: {},
        gateway: 'g',
        workspace: 'default',
        remotePath: '/',
        reuseLease: true,
      },
      valid: () => true,
    }),
    () => {
      parent = spawn(
        process.execPath,
        [
          '-e',
          `
      const {spawn} = require('node:child_process');
      process.on('SIGTERM', () => {});
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      process.stdout.write(String(helper.pid));
      setInterval(() => {}, 1000);
    `,
        ],
        { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return parent as any;
    },
  );
  channels.notifications = {
    data: (_r, _s, bytes) => {
      helperPid = Number(Buffer.from(bytes).toString());
      ready();
    },
    exit: () => {},
  };
  try {
    const pair = await channels.open(request);
    const timer = setTimeout(ready, 3000);
    await started;
    clearTimeout(timer);
    assert.ok(helperPid > 0);
    await channels.close(pair);
    assert.ok(parent!.signalCode);
    for (const pid of [parent!.pid!, helperPid])
      assert.throws(
        () => process.kill(pid, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
  } finally {
    await channels.shutdown();
  }
});

test('late I/O from an evicted closed route cannot close a replacement route', async () => {
  const children: any[] = [];
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const c = parseConfig(f.params.config);
  const i = identity(f.params, l.providerLeaseId, l.metadata, c);
  const channels = new DuplexChannels(
    async () => ({ c, i, valid: () => true }),
    () => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.resume();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      child.stdin.on('finish', () => child.emit('close', 0, null));
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  );
  try {
    await channels.open(request);
    await channels.close({ hostRouteId: request.hostRouteId });
    for (let index = 0; index < duplexLimits.tombstones; index++)
      await channels.close({ hostRouteId: `evict-${index}` });
    const replacement = await channels.open({
      ...request,
      companyId: 'other-company',
    });
    children[0].stdin.emit('error', new Error('late I/O'));
    await tick();
    await channels.write({ ...replacement, data: 'AA==' });
    assert.equal(children[1].stdin.writableEnded, false);
  } finally {
    await channels.shutdown();
  }
});
