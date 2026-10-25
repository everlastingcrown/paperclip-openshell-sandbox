import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginManifestV1Schema } from '@paperclipai/shared';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import manifest from '../src/manifest.js';
test('manifest validates against pinned SDK shared contract', async () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  assert.equal(manifest.id, 'paperclip.openshell-sandbox-provider');
  assert.deepEqual(manifest.capabilities, [
    'environment.drivers.register',
    'ui.page.register',
    'ui.sidebar.register',
  ]);
  assert.equal(manifest.entrypoints.ui, './dist/ui');
  assert.equal(
    manifest.ui?.slots?.find((slot) => slot.type === 'page')?.exportName,
    'RecoveryPage',
  );
  assert.deepEqual(manifest.environmentDrivers![0].sandboxCapabilities, {
    reusableLeases: true,
    duplexCommandStream: true,
    independentControlCommands: true,
    nativeSyncIn: false,
    nativeSyncOut: false,
    persistentProcessSessions: false,
    incrementalSessionOutput: false,
  });
});
test('real worker advertises every declared lifecycle capability and stop-only hook', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          manifest,
          config: {},
          apiVersion: 1,
          instanceInfo: { instanceId: 'test', hostVersion: '2026.1005.0' },
        },
      }) + '\n',
    );
    const response: any = await new Promise((resolve, reject) => {
      lines.once('line', (line) => resolve(JSON.parse(line)));
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`worker exited: ${stderr}`)));
    });
    assert.equal(response.result.ok, true);
    const methods = response.result.supportedMethods;
    for (const method of [
      'duplexChannelOpen',
      'duplexChannelWrite',
      'duplexChannelStop',
      'duplexChannelClose',
      'environmentAcquireLease',
      'environmentResumeLease',
      'environmentReleaseLease',
      'environmentDestroyLease',
      'environmentStopLease',
      'environmentExecute',
      'environmentRealizeWorkspace',
      'environmentValidateConfig',
      'environmentProbe',
    ])
      assert.ok(methods.includes(method), method);
    for (const method of ['environmentSyncIn', 'environmentSyncOut'])
      assert.ok(!methods.includes(method));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
});

test('real SDK routes interleaved output before concurrent execute replies', async () => {
  const source = `
    import { startWorkerRpcHost } from '@paperclipai/plugin-sdk';
    import { createPlugin } from './src/plugin.ts';
    import { OpenShellProvider } from './src/provider.ts';
    class StreamingProvider extends OpenShellProvider {
      async execute(p, output) {
        output('stdout', p.command);
        await new Promise(resolve => setTimeout(resolve, p.command === 'first' ? 40 : 5));
        output('stderr', p.command + '-done');
        return { stdout: p.command, stderr: p.command + '-done', exitCode: 0, signal: null, timedOut: false };
      }
    }
    startWorkerRpcHost({ plugin: createPlugin(new StreamingProvider()) });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout });
  const messages: any[] = [];
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const send = (
    id: number,
    method: string,
    params: unknown,
    invocation?: string,
  ) =>
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
        ...(invocation
          ? {
              paperclipInvocation: {
                id: invocation,
                scope: { companyId: 'company' },
              },
            }
          : {}),
      }) + '\n',
    );
  try {
    const initialized = new Promise<void>((resolve, reject) => {
      lines.once('line', () => resolve());
      child.once('exit', () =>
        reject(new Error('worker exited before initialization')),
      );
    });
    send(1, 'initialize', {
      manifest,
      config: {},
      apiVersion: 1,
      instanceInfo: { instanceId: 'test', hostVersion: '2026.1005.0' },
    });
    await initialized;
    const completed = new Promise<void>((resolve, reject) => {
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        if (messages.filter((m) => m.id === 2 || m.id === 3).length === 2)
          resolve();
      });
      child.once('exit', () =>
        reject(new Error('worker exited before replies')),
      );
    });
    send(
      2,
      'environmentExecute',
      {
        driverKey: 'openshell',
        companyId: 'company',
        environmentId: 'env',
        config: {},
        command: 'first',
      },
      'invocation-first',
    );
    send(
      3,
      'environmentExecute',
      {
        driverKey: 'openshell',
        companyId: 'company',
        environmentId: 'env',
        config: {},
        command: 'second',
      },
      'invocation-second',
    );
    await completed;
    const notifications = messages.filter((m) => m.method === 'execute.log');
    assert.equal(notifications.length, 4);
    for (const command of ['first', 'second']) {
      const chunks = notifications.filter(
        (m) => m.paperclipInvocationId === `invocation-${command}`,
      );
      assert.deepEqual(
        chunks.map((m) => m.params),
        [
          { stream: 'stdout', chunk: command },
          { stream: 'stderr', chunk: command + '-done' },
        ],
      );
      assert.ok(
        messages.indexOf(chunks[0]) <
          messages.findIndex((m) => m.id === (command === 'first' ? 2 : 3)),
      );
    }
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
});

test('real SDK duplex RPC binds byte notifications, route-only close and exit exactly once', async () => {
  const source = `
    import { spawn } from 'node:child_process';
    import { startWorkerRpcHost } from '@paperclipai/plugin-sdk';
    import { createPlugin } from './src/plugin.ts';
    import { OpenShellProvider } from './src/provider.ts';
    import { fake } from './test/helpers.ts';
    const f = fake();
    const provider = new OpenShellProvider(f.runner, 1, () => spawn(process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
    startWorkerRpcHost({ plugin: createPlugin(provider) });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout });
  const messages: any[] = [];
  const pending = new Map<number, (message: any) => void>();
  let id = 0;
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) =>
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result),
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) +
          '\n',
      );
    });
  try {
    await call('initialize', {
      manifest,
      config: {},
      apiVersion: 1,
      instanceInfo: { instanceId: 'test', hostVersion: '2026.1005.0' },
    });
    const base = {
      driverKey: 'openshell',
      companyId: 'company',
      environmentId: 'environment',
      runId: 'run',
      config: {
        gateway: 'test',
        image: 'runtime:test',
        enableDuplex: true,
        timeoutMs: 1000,
      },
    };
    const lease = await call('environmentAcquireLease', base);
    const pair = await call('duplexChannelOpen', {
      ...base,
      providerLeaseId: lease.providerLeaseId,
      hostRouteId: 'rpc-route',
      command: ['cat'],
    });
    assert.equal(pair.hostRouteId, 'rpc-route');
    await assert.rejects(
      call('duplexChannelWrite', {
        ...pair,
        workerSessionId: 'wrong',
        data: 'AA==',
      }),
      /unavailable/,
    );
    await call('duplexChannelWrite', {
      ...pair,
      data: Buffer.from([0, 255, 128]).toString('base64'),
    });
    const data = await new Promise<any>((resolve, reject) => {
      const existing = messages.find((m) => m.method === 'duplexChannel.data');
      if (existing) {
        resolve(existing);
        return;
      }
      const deadline = setTimeout(
        () => reject(new Error('Missing duplex data')),
        3000,
      );
      const onLine = (line: string) => {
        const message = JSON.parse(line);
        if (message.method === 'duplexChannel.data') {
          clearTimeout(deadline);
          lines.off('line', onLine);
          resolve(message);
        }
      };
      lines.on('line', onLine);
    });
    assert.deepEqual(data.params, {
      ...pair,
      chunk: Buffer.from([0, 255, 128]).toString('base64'),
    });
    assert.deepEqual(
      await call('duplexChannelClose', { hostRouteId: 'rpc-route' }),
      pair,
    );
    assert.deepEqual(
      await call('duplexChannelClose', {
        hostRouteId: 'rpc-route',
        workerSessionId: 'non-authoritative',
      }),
      pair,
    );
    const exits = messages.filter((m) => m.method === 'duplexChannel.exit');
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0].params, {
      ...pair,
      exitCode: null,
      transportClosed: true,
    });
    assert.ok(messages.indexOf(data) < messages.indexOf(exits[0]));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
});
