import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, MAX_STDIN, MAX_OUTPUT, json } from '../src/cli.js';
import { ok, fake, release } from './helpers.js';
test('real subprocess receives explicit config home', async () => {
  const result = await run(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.XDG_CONFIG_HOME)'],
    2000,
    undefined,
    { XDG_CONFIG_HOME: '/paperclip/.config' },
  );
  assert.equal(result.stdout, '/paperclip/.config');
  assert.equal(result.exitCode, 0);
});
test('execution preserves argument boundaries, cwd, env, stdin and outcomes', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.fail((args) =>
    args.includes('exec')
      ? { ...ok('output'), stderr: 'error', exitCode: 7 }
      : undefined,
  );
  const result = await f.provider.execute({
    ...f.params,
    lease: l,
    command: 'echo',
    args: ['; $(test)', 'two words'],
    env: { NAME: 'private-value' },
    cwd: '/custom',
    stdin: 'input',
    timeoutMs: 321,
  });
  assert.deepEqual(result, { ...ok('output'), stderr: 'error', exitCode: 7 });
  const call = f.calls.at(-1)!;
  assert.deepEqual(call.args.slice(-4), [
    '--',
    'echo',
    '; $(test)',
    'two words',
  ]);
  assert.equal(call.stdin, 'input');
  assert.equal(call.timeout, 321);
  assert.ok(call.args.includes('--no-login-shell'));
  assert.ok(call.args.includes('NAME=private-value'));
  assert.ok(call.args.includes('/custom'));
  assert.ok(!JSON.stringify(l).includes('private-value'));
});
test('execution reports local and remote timeout', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  for (const outcome of [
    { ...ok(), timedOut: true, exitCode: null },
    { ...ok(), exitCode: 124 },
  ]) {
    f.fail((a) => (a.includes('exec') ? outcome : undefined));
    assert.equal(
      (await f.provider.execute({ ...f.params, lease: l, command: 'sleep' }))
        .timedOut,
      true,
    );
  }
});
test('multiline environment bypasses OpenShell env validation without changing command I/O', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const env = {
    OPENCODE_CONFIG_CONTENT: '{\n  "provider": {}\n}\n\n',
    CR: 'first\rsecond\r',
    CRLF: 'first\r\nsecond\r\n',
    QUOTED: '\n\'" $(exit 99); `exit 98` \\ café 🐈\n',
    ONLY_NEWLINES: '\n\n',
    SINGLE_LINE: 'unchanged',
    EMPTY: '',
  };
  const args = ['two words', '; $(exit 97)', '', 'line\nbreak'];
  f.fail(async (cliArgs) => {
    if (!cliArgs.includes('exec')) return;
    const delimiter = cliArgs.indexOf('--');
    const overrides = cliArgs.slice(0, delimiter).flatMap((arg, index) => {
      if (arg !== '--env') return [];
      const value = cliArgs[index + 1];
      assert.doesNotMatch(value, /[\r\n]/);
      return [value];
    });
    assert.deepEqual(overrides, ['SINGLE_LINE=unchanged', 'EMPTY=']);
    // Execute the actual transported argv, not a reimplementation of decoding.
    return run(
      'env',
      [...overrides, ...cliArgs.slice(delimiter + 1)],
      2000,
      'input\n',
    );
  });
  const result = await f.provider.execute({
    ...f.params,
    lease: l,
    command: process.execPath,
    args: [
      '-e',
      `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({env:Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(k=>[k,process.env[k]])),args:process.argv.slice(1),input}));process.stderr.write('diagnostic');process.exitCode=7})`,
      '--',
      ...args,
    ],
    env,
    stdin: 'input\n',
  });
  assert.deepEqual(JSON.parse(result.stdout), { env, args, input: 'input\n' });
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(f.calls.at(-1)!.stdin, 'input\n');
});
test('oversized stdin is rejected before invoking CLI', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const n = f.calls.length;
  await assert.rejects(
    f.provider.execute({
      ...f.params,
      lease: l,
      command: 'cat',
      stdin: 'x'.repeat(MAX_STDIN + 1),
    }),
    /4 MiB/,
  );
  assert.equal(f.calls.length, n);
});
test('ownership and scope mismatch blocks resume, execution, stop and destroy', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  f.record.id = 'replacement';
  for (const action of [
    () =>
      f.provider.resume({ ...release(f, l), providerLeaseId: 'sandbox-id' }),
    () => f.provider.stop(release(f, l)),
    () => f.provider.destroy(release(f, l)),
    () => f.provider.execute({ ...f.params, lease: l, command: 'true' }),
  ])
    await assert.rejects(action, /ownership/);
  await assert.rejects(
    f.provider.destroy({
      ...release(f, l),
      config: { ...f.params.config, gateway: 'other' },
    }),
    /ownership/,
  );
  assert.ok(!f.calls.some((c) => c.args.includes('delete')));
});
test('JSON and response validation fail closed', () => {
  assert.throws(() => json('not json'), /Malformed/);
});
test('real subprocess closes stdin and preserves output and exit status', async () => {
  const result = await run(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end',()=>{console.log('done');console.error('err');process.exitCode=7})",
    ],
    2000,
  );
  assert.equal(result.stdout, 'done\n');
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.exitCode, 7);
});
test('real subprocess timeout and output limits are bounded', async () => {
  assert.equal(
    (await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50))
      .timedOut,
    true,
  );
  await assert.rejects(
    run(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${MAX_OUTPUT + 1}))`],
      2000,
    ),
    /16 MiB/,
  );
  await assert.rejects(run('/missing/openshell', [], 1000), /Unable to start/);
});
