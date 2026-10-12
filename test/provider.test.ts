import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpenShellProvider } from '../src/provider.js';
import { configSchema, parseConfig } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import { parseCleanupRecovery } from '../src/recovery.js';
import {
  run,
  MAX_STDIN,
  MAX_OUTPUT,
  json,
  type Runner,
  type CommandResult,
} from '../src/cli.js';
import {
  readEnvironmentCreationCleanupError,
  PluginEnvironmentCreationCleanupError,
} from '@paperclipai/plugin-sdk';
const config = { gateway: 'test', image: 'runtime:test', timeoutMs: 1000 };
const base = {
  driverKey: 'openshell',
  companyId: 'company',
  environmentId: 'environment',
  runId: 'run',
  config,
};
const ok = (stdout = ''): CommandResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
});
function fake(extra: Record<string, unknown> = {}) {
  const calls: {
    args: string[];
    stdin?: string;
    timeout: number;
    env?: { XDG_CONFIG_HOME?: string };
  }[] = [];
  let record: any;
  let fail:
    | ((
        args: string[],
      ) => CommandResult | undefined | Promise<CommandResult | undefined>)
    | undefined;
  const runner: Runner = async (_executable, args, timeout, stdin, env) => {
    calls.push({ args, stdin, timeout, env });
    const result = await fail?.(args);
    if (result) return result;
    const flag = (key: string) => args[args.indexOf(key) + 1];
    if (args.includes('create')) {
      const labels = Object.fromEntries(
        args.flatMap((a, index) =>
          a === '--label' ? [args[index + 1].split('=')] : [],
        ),
      );
      record = {
        id: 'sandbox-id',
        name: flag('--name'),
        workspace: 'default',
        phase: 'Ready',
        labels,
      };
      return ok(JSON.stringify(record));
    }
    if (args.includes('list'))
      return ok(
        JSON.stringify({
          sandboxes: record ? [record] : [],
          next_page_token: '',
        }),
      );
    if (args.includes('delete')) record = undefined;
    if (args.includes('stop')) record.phase = 'Stopped';
    if (args.includes('start')) record.phase = 'Ready';
    return ok();
  };
  const provider = new OpenShellProvider(runner, 1);
  return {
    provider,
    calls,
    params: { ...base, config: { ...config, ...extra } },
    get record() {
      return record;
    },
    set record(v) {
      record = v;
    },
    fail(f: typeof fail) {
      fail = f;
    },
  };
}
const release = (f: ReturnType<typeof fake>, l: any) => ({
  ...f.params,
  providerLeaseId: l.providerLeaseId,
  leaseMetadata: l.metadata,
});
test('configuration defaults and required fields', () => {
  assert.deepEqual(parseConfig({ gateway: 'g', image: 'i' }), {
    executable: 'openshell',
    configHome: undefined,
    gateway: 'g',
    workspace: 'default',
    image: 'i',
    policy: undefined,
    policyFile: undefined,
    providers: [],
    cpu: undefined,
    memory: undefined,
    timeoutMs: 300000,
    reuseLease: false,
  });
  for (const c of [
    { image: 'i' },
    { gateway: 'g' },
    { ...config, timeoutMs: 0 },
    { ...config, reuseLease: 'yes' },
    { ...config, providers: [4] },
    { ...config, cpu: 'bad' },
    { ...config, memory: 'bad' },
    { ...config, gateway: '-g' },
    { ...config, configHome: 'relative/config' },
    { ...config, policy: 'version: 1', policyFile: '/policy.yaml' },
  ])
    assert.throws(() => parseConfig(c));
});
test('cleared optional text fields are treated as unspecified', () => {
  const defaults = parseConfig(config);
  for (const field of ['configHome', 'policy', 'policyFile', 'cpu', 'memory']) {
    for (const value of ['', ' \t\n'])
      assert.deepEqual(parseConfig({ ...config, [field]: value }), defaults);
    for (const value of [null, false, {}, '\0'])
      assert.throws(() => parseConfig({ ...config, [field]: value }));
  }
  assert.equal('minLength' in configSchema.properties.configHome, false);
  for (const field of ['gateway', 'image'])
    assert.throws(() => parseConfig({ ...config, [field]: '' }));
});
test('inline policy preserves text and rejects ambiguous sources', () => {
  const policy = '\nversion: 1\n# Unicode: café\n';
  assert.equal(
    parseConfig({ ...config, policy, policyFile: '' }).policy,
    policy,
  );
  assert.equal(
    parseConfig({ ...config, policy: '', policyFile: '/policy.yaml' })
      .policyFile,
    '/policy.yaml',
  );
  assert.equal(configSchema.properties.policy.type, 'string');
});
test('inline policies use private, distinct files removed after creation', async () => {
  const policy = '\nversion: 1\n# Unicode: café\n';
  const fixtures = [fake({ policy }), fake({ policy })];
  const paths: string[] = [];
  for (const f of fixtures)
    f.fail(async (args) => {
      if (!args.includes('create')) return;
      const path = args[args.indexOf('--policy') + 1];
      paths.push(path);
      assert.equal(await readFile(path, 'utf8'), policy);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      return undefined;
    });
  const leases = await Promise.all(
    fixtures.map((f) => f.provider.acquire(f.params)),
  );
  assert.equal(new Set(paths).size, 2);
  for (const path of paths)
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
  for (const [index, f] of fixtures.entries()) {
    assert.equal(JSON.stringify(leases[index]).includes(policy), false);
    await f.provider.destroy(release(f, leases[index]));
  }
});
test('inline policy files are removed when creation fails', async () => {
  for (const throws of [false, true]) {
    const f = fake({ policy: 'version: 1\n# private-policy-value\n' });
    let path = '';
    f.fail((args) => {
      if (!args.includes('create')) return;
      path = args[args.indexOf('--policy') + 1];
      if (throws) throw new Error('CLI failed');
      return { ...ok(), exitCode: 1, stderr: 'private-policy-value' };
    });
    await assert.rejects(f.provider.acquire(f.params), (error: Error) => {
      assert.equal(error.message.includes('private-policy-value'), false);
      return true;
    });
    assert.ok(path);
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
  }
});
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
test('acquisition uses pinned scope, ownership and noninteractive create flags', async () => {
  const f = fake({
    providers: ['existing'],
    policyFile: '/policy.yaml',
    cpu: '500m',
    memory: '1Gi',
  });
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
    '/policy.yaml',
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
    /scope/,
  );
  assert.ok(!f.calls.some((c) => c.args.includes('delete')));
});
test('failed runtime check cleans up allocation', async () => {
  const f = fake();
  f.fail((a) => (a.includes('exec') ? { ...ok(), exitCode: 1 } : undefined));
  await assert.rejects(f.provider.acquire(f.params), /cleaned up/);
  assert.equal(f.record, undefined);
});
test('failed cleanup returns SDK structured nonsecret ownership evidence', async () => {
  const f = fake();
  f.fail((a) =>
    a.includes('exec') || a.includes('delete')
      ? { ...ok(), stderr: 'secret-token', exitCode: 1 }
      : undefined,
  );
  try {
    await f.provider.acquire(f.params);
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof PluginEnvironmentCreationCleanupError);
    const cleanup = readEnvironmentCreationCleanupError(e)!;
    assert.ok(cleanup);
    assert.equal(cleanup.observedProviderLeaseId, 'sandbox-id');
    assert.ok(!JSON.stringify(e).includes('secret-token'));
    f.fail(undefined);
    await f.provider.destroy({
      ...f.params,
      providerLeaseId: cleanup.providerLeaseId,
      leaseMetadata: { failedCreateCleanup: cleanup },
    });
    assert.equal(f.record, undefined);
  }
});
test('uncertain creation preserves pending cleanup; observation must be durable before destroy', async () => {
  const f = fake();
  f.fail((a) => (a.includes('create') ? ok('malformed') : undefined));
  let cleanup: any;
  try {
    await f.provider.acquire(f.params);
  } catch (e) {
    cleanup = readEnvironmentCreationCleanupError(e);
  }
  assert.ok(cleanup);
  assert.equal(cleanup.observedProviderLeaseId, undefined);
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  await assert.rejects(
    f.provider.destroy(p),
    PluginEnvironmentCreationCleanupError,
  );
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: cleanup.labels,
  };
  try {
    await f.provider.destroy(p);
  } catch (e) {
    cleanup = readEnvironmentCreationCleanupError(e);
  }
  assert.equal(cleanup.observedProviderLeaseId, 'late-id');
  assert.ok(f.record);
  await f.provider.destroy({
    ...p,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  assert.equal(f.record, undefined);
});
test('plugin recovery repairs saved cleanup config without changing environment settings', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  const plugin = createPlugin(f.provider);
  let settings: Record<string, unknown> = {};
  const companies: string[] = [];
  await plugin.definition.setup({
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    config: {
      async get(companyId: string) {
        companies.push(companyId);
        return settings;
      },
    },
  } as any);
  const before = JSON.stringify(f.params.config);
  f.fail((args) =>
    args.includes('list') &&
    f.calls.at(-1)?.env?.XDG_CONFIG_HOME !== '/paperclip/.config'
      ? { ...ok(), exitCode: 1, stderr: "Unknown gateway 'test'" }
      : undefined,
  );
  await assert.rejects(
    plugin.definition.onEnvironmentDestroyLease!(release(f, l)),
    /not registered/,
  );
  settings = {
    cleanupRecovery: [
      {
        environmentId: 'environment',
        gateway: 'test',
        configHome: '/paperclip/.config',
      },
    ],
  };
  assert.equal((await plugin.definition.onValidateConfig!(settings)).ok, true);
  const start = f.calls.length;
  await plugin.definition.onEnvironmentDestroyLease!(release(f, l));
  assert.equal(f.record, undefined);
  assert.ok(
    f.calls
      .slice(start)
      .every((call) => call.env?.XDG_CONFIG_HOME === '/paperclip/.config'),
  );
  assert.deepEqual(companies, ['company', 'company']);
  assert.equal(JSON.stringify(f.params.config), before);
});
test('explicit rejected-attempt recovery requires successful absence and preserves observed identity', async () => {
  const f = fake();
  f.fail((args) =>
    args.includes('create')
      ? { ...ok(), exitCode: 1, stderr: 'secret-token' }
      : undefined,
  );
  let cleanup: any;
  await assert.rejects(f.provider.acquire(f.params), (error: any) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    assert.ok(cleanup);
    assert.ok(!JSON.stringify(error).includes('secret-token'));
    return true;
  });
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  const entry = {
    environmentId: 'environment',
    gateway: 'test',
    workspace: 'default',
    rejectedAttemptIds: [cleanup.attemptId],
  };
  for (const mismatch of [
    { environmentId: 'other' },
    { gateway: 'other' },
    { workspace: 'other' },
    { rejectedAttemptIds: [] },
  ]) {
    f.provider.setCleanupRecovery(async () => [{ ...entry, ...mismatch }]);
    await assert.rejects(
      f.provider.destroy(p),
      PluginEnvironmentCreationCleanupError,
    );
  }
  f.provider.setCleanupRecovery(async () => [entry]);
  f.fail((args) =>
    args.includes('list')
      ? { ...ok(), exitCode: 1, stderr: 'connection refused' }
      : undefined,
  );
  await assert.rejects(f.provider.destroy(p), /gateway connection failed/);
  f.fail((args) => (args.includes('list') ? ok('malformed') : undefined));
  await assert.rejects(f.provider.destroy(p), /Malformed/);
  f.fail(undefined);
  f.record = {
    id: 'late-id',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: { ...cleanup.labels, 'paperclip-company': 'foreign' },
  };
  await assert.rejects(f.provider.destroy(p), /ownership/);
  f.record.labels = cleanup.labels;
  await assert.rejects(f.provider.destroy(p), (error: any) => {
    cleanup = readEnvironmentCreationCleanupError(error);
    assert.equal(cleanup.observedProviderLeaseId, 'late-id');
    return true;
  });
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
  await f.provider.destroy({
    ...p,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  assert.equal(f.record, undefined);
  assert.equal((await f.provider.destroy(p)).state, 'destroyed');
});
test('cleanup recovery validates operator inputs', async () => {
  assert.deepEqual(parseCleanupRecovery({}), []);
  const entry = { environmentId: 'environment', gateway: 'test' };
  for (const cleanupRecovery of [
    'invalid',
    [null],
    [{ ...entry, configHome: 'relative' }],
    [{ ...entry, rejectedAttemptIds: ['pc-name'] }],
    [entry, entry],
    [{ ...entry, gateway: 'bad gateway' }],
    [{ ...entry, unexpected: true }],
  ]) {
    assert.throws(() => parseCleanupRecovery({ cleanupRecovery }), /Invalid/);
    assert.equal(
      (await createPlugin().definition.onValidateConfig!({ cleanupRecovery }))
        .ok,
      false,
    );
  }
});
test('stop-only recovery confirms stop and retains files', async () => {
  const f = fake();
  const l = await f.provider.acquire(f.params);
  f.provider.setCleanupRecovery(async () => [
    {
      environmentId: 'environment',
      gateway: 'test',
      workspace: 'default',
      configHome: '/paperclip/.config',
      rejectedAttemptIds: [],
    },
  ]);
  const start = f.calls.length;
  assert.equal(
    (
      await f.provider.destroy({
        ...release(f, l),
        resourceDisposition: 'stop_and_retain',
      })
    ).state,
    'stopped',
  );
  assert.equal(f.record.phase, 'Stopped');
  assert.ok(
    f.calls
      .slice(start)
      .every((call) => call.env?.XDG_CONFIG_HOME === '/paperclip/.config'),
  );
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
});
test('JSON and response validation fail closed', () => {
  assert.throws(() => json('not json'), /Malformed/);
});
test('legacy oversized attempts reconcile only after a successful scoped absence check', async () => {
  const f = fake({ image: 'curlimages/curl:8.21.0' });
  const seed = fake();
  seed.fail((a) => (a.includes('create') ? ok('malformed') : undefined));
  let cleanup: any;
  try {
    await seed.provider.acquire(seed.params);
  } catch (error) {
    cleanup = readEnvironmentCreationCleanupError(error);
  }
  assert.ok(cleanup);
  cleanup.providerLeaseId = `paperclip-${cleanup.attemptId}`;
  const p = {
    ...f.params,
    providerLeaseId: cleanup.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  };
  f.fail((a) => (a.includes('list') ? ok('malformed') : undefined));
  await assert.rejects(f.provider.destroy(p), /Malformed/);
  f.fail(undefined);
  assert.deepEqual(await f.provider.destroy(p), {
    providerLeaseId: cleanup.providerLeaseId,
    state: 'destroyed',
  });
  assert.ok(!f.calls.some((call) => call.args.includes('delete')));
  f.record = {
    id: 'observed-legacy',
    name: cleanup.providerLeaseId,
    workspace: 'default',
    phase: 'Ready',
    labels: cleanup.labels,
  };
  await assert.rejects(f.provider.destroy(p), (error: any) => {
    assert.equal(
      readEnvironmentCreationCleanupError(error)?.observedProviderLeaseId,
      'observed-legacy',
    );
    return true;
  });
  f.record.labels['paperclip-company'] = 'foreign';
  await assert.rejects(f.provider.destroy(p), /ownership/);
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
test('ownership label mismatch and malformed sandbox shapes fail closed', async () => {
  const f = fake({ reuseLease: true });
  const l = await f.provider.acquire(f.params);
  f.record.labels['paperclip-company'] = 'foreign';
  await assert.rejects(f.provider.destroy(release(f, l)), /ownership/);
  assert.ok(f.record);
  f.record.labels = null;
  await assert.rejects(
    f.provider.resume({ ...release(f, l), providerLeaseId: 'sandbox-id' }),
    /shape/,
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
