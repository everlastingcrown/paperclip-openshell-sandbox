import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, type spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createRunner, MAX_OUTPUT, OpenShellCommandError } from '../src/cli.js';

// Exercise stream failures and racing process events without platform-specific
// ways to force a real pipe to fail.
function processFixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => child.emit('close', 0, null));
    return true;
  };
  const runner = createRunner((() => child) as typeof spawn);
  return { child, signals, runner };
}
for (const stream of ['stdin', 'stdout', 'stderr'] as const) {
  test(`${stream} I/O failure rejects even when child closes successfully`, async () => {
    const f = processFixture();
    const result = f.runner('openshell', [], 1000);
    f.child[stream].emit(
      'error',
      Object.assign(new Error('private-io-secret'), { code: 'ECANCELED' }),
    );
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof OpenShellCommandError);
      assert.equal(error.allocationImpossible, false);
      assert.equal(error.message, 'OpenShell CLI input/output failed');
      return true;
    });
    assert.deepEqual(f.signals, ['SIGTERM']);
  });
}

test('EPIPE preserves child exit status and output', async () => {
  const f = processFixture();
  const result = f.runner('openshell', [], 1000);
  f.child.stdin.emit(
    'error',
    Object.assign(new Error('private-io-secret'), { code: 'EPIPE' }),
  );
  f.child.stdout.write('output');
  f.child.emit('close', 7, null);
  assert.equal((await result).exitCode, 7);
  assert.deepEqual(f.signals, []);
});

test('spawn error wins over a subsequent close and late stream error', async () => {
  const f = processFixture();
  const result = f.runner('openshell', [], 1000);
  f.child.emit(
    'error',
    Object.assign(new Error('private-spawn-secret'), { code: 'ENOENT' }),
  );
  f.child.emit('close', 0, null);
  f.child.stderr.emit('error', new Error('private-late-secret'));
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof OpenShellCommandError);
    assert.equal(error.allocationImpossible, true);
    assert.match(error.message, /Unable to start.*ENOENT/);
    assert.ok(!error.message.includes('private-'));
    return true;
  });
  assert.deepEqual(f.signals, []);
});

test('combined stdout and stderr overflow rejects rather than returning success', async () => {
  const f = processFixture();
  const result = f.runner('openshell', [], 1000);
  f.child.stdout.write(Buffer.alloc(MAX_OUTPUT / 2));
  f.child.stderr.write(Buffer.alloc(MAX_OUTPUT / 2));
  f.child.stderr.write('x');
  await assert.rejects(result, /16 MiB/);
  assert.deepEqual(f.signals, ['SIGTERM']);
});

test('streaming arrives before close, preserves split UTF-8 and isolates stderr', async () => {
  const f = processFixture();
  const chunks: { stream: string; text: string }[] = [];
  const result = f.runner(
    'openshell',
    [],
    1000,
    undefined,
    {},
    (stream, text) => chunks.push({ stream, text }),
  );
  const bytes = Buffer.from('A😀Z');
  f.child.stdout.write(bytes.subarray(0, 3));
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'A' }]);
  f.child.stderr.write('diagnostic');
  f.child.stdout.write(bytes.subarray(3));
  assert.equal(
    chunks
      .filter((c) => c.stream === 'stdout')
      .map((c) => c.text)
      .join(''),
    'A😀Z',
  );
  f.child.emit('close', 0, null);
  assert.deepEqual(await result, {
    stdout: 'A😀Z',
    stderr: 'diagnostic',
    exitCode: 0,
    signal: null,
    timedOut: false,
  });
});

test('streaming limits notifications and tolerates a broken log sink', async () => {
  const f = processFixture();
  let delivered = 0;
  const result = f.runner(
    'openshell',
    [],
    1000,
    undefined,
    {},
    (_stream, text) => {
      assert.ok(Buffer.byteLength(text) <= 16384);
      delivered += Buffer.byteLength(text);
      throw new Error('broken sink');
    },
  );
  f.child.stdout.write(Buffer.alloc(65536, 'a'));
  f.child.stdout.write(Buffer.alloc(MAX_OUTPUT));
  await assert.rejects(result, /16 MiB/);
  assert.equal(delivered, 65536);
});
