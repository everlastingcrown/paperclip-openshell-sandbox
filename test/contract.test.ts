import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginManifestV1Schema } from '@paperclipai/shared';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import manifest from '../src/manifest.js';
test('manifest validates against pinned SDK shared contract', async () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  assert.equal(manifest.id, 'paperclip.openshell-sandbox-provider');
  assert.deepEqual(manifest.capabilities, ['environment.drivers.register']);
  assert.deepEqual(manifest.environmentDrivers![0].sandboxCapabilities, {
    reusableLeases: true,
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
      'environmentAcquireLease',
      'environmentResumeLease',
      'environmentReleaseLease',
      'environmentDestroyLease',
      'environmentStopLease',
      'environmentExecute',
      'environmentRealizeWorkspace',
      'environmentValidateConfig',
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
