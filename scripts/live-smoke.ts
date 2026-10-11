import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { OpenShellProvider } from '../src/provider.js';
import { parseConfig } from '../src/config.js';
import { run } from '../src/cli.js';
// Uses the real host fallback from an installed v2026.1005.0 checkout.
if (!process.env.OPENSHELL_SMOKE_CONFIG || !process.env.PAPERCLIP_SOURCE) {
  console.log(
    'SKIP: set OPENSHELL_SMOKE_CONFIG (JSON file path) and PAPERCLIP_SOURCE (installed v2026.1005.0 checkout).',
  );
  process.exit(0);
}
const source = path.resolve(process.env.PAPERCLIP_SOURCE);
assert.equal(
  execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim(),
  'v2026.1005.0',
);
assert.equal(
  execFileSync(
    'git',
    ['status', '--porcelain', '--', 'packages/adapter-utils'],
    { cwd: source, encoding: 'utf8' },
  ).trim(),
  '',
  'Use unmodified pinned host fallback',
);
const { createCommandManagedRuntimeClient } = await import(
  pathToFileURL(
    path.join(source, 'packages/adapter-utils/src/command-managed-runtime.ts'),
  ).href
);
const { prepareSandboxManagedRuntime } = await import(
  pathToFileURL(
    path.join(source, 'packages/adapter-utils/src/sandbox-managed-runtime.ts'),
  ).href
);
const config = {
  ...parseConfig(
    JSON.parse(await readFile(process.env.OPENSHELL_SMOKE_CONFIG, 'utf8')),
  ),
  reuseLease: true,
};
const version = await run(config.executable, ['--version'], 5000);
assert.match(version.stdout, /openshell 0\.1\.2\b/);
const provider = new OpenShellProvider();
const base = {
  driverKey: 'openshell',
  companyId: 'smoke-company',
  environmentId: 'smoke-environment',
  runId: 'smoke-run',
  config,
};
const temp = await mkdtemp(path.join(tmpdir(), 'openshell-live-'));
let lease: Awaited<ReturnType<typeof provider.acquire>> | undefined;
let prepared: any;
try {
  const local = path.join(temp, 'workspace');
  await mkdir(local);
  await writeFile(path.join(local, 'roundtrip.txt'), 'host content\n');
  // Exercise the fallback's exact 4 MiB base64 stdin boundary and multiple chunks.
  const binary = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  await writeFile(path.join(local, 'binary.dat'), binary);
  lease = await provider.acquire(base);
  const metadata = lease.metadata!;
  const cwd = metadata.remoteCwd as string;
  const execute = async (input: any) => ({
    ...(await provider.execute({ ...base, ...input, lease: lease! })),
    pid: null,
  });
  const client = createCommandManagedRuntimeClient({
    runner: { execute },
    commandCwd: cwd,
    timeoutMs: config.timeoutMs,
    shellCommand: 'bash',
  });
  assert.equal(client.syncOut, undefined);
  prepared = await prepareSandboxManagedRuntime({
    client,
    adapterKey: 'openshell-smoke',
    workspaceLocalDir: local,
    workspaceRemoteDir: cwd,
    workspaceFileMode: 'all',
    spec: {
      transport: 'sandbox',
      provider: 'openshell',
      sandboxId: lease.providerLeaseId!,
      remoteCwd: cwd,
      timeoutMs: config.timeoutMs,
      apiKey: null,
    },
  });
  const result = await execute({
    command: 'bash',
    args: [
      '-c',
      'printf "sandbox content\\n" > roundtrip.txt; printf stdout; printf stderr >&2',
    ],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'stdout');
  assert.equal(result.stderr, 'stderr');
  await prepared.restoreWorkspace();
  assert.equal(
    await readFile(path.join(local, 'roundtrip.txt'), 'utf8'),
    'sandbox content\n',
  );
  assert.deepEqual(await readFile(path.join(local, 'binary.dat')), binary);
  const lifecycle = {
    ...base,
    providerLeaseId: lease.providerLeaseId!,
    leaseMetadata: lease.metadata,
  };
  await provider.release(lifecycle);
  lease = await provider.resume(lifecycle);
  assert.equal(lease.providerLeaseId, lifecycle.providerLeaseId);
  assert.equal((await provider.stop(lifecycle)).state, 'stopped');
  lease = await provider.resume(lifecycle);
  assert.equal(
    (await execute({ command: 'cat', args: ['roundtrip.txt'] })).stdout,
    'sandbox content\n',
  );
  assert.equal((await provider.destroy(lifecycle)).state, 'destroyed');
  lease = undefined;
  console.log(
    'PASS: acquisition, execution, real Paperclip fallback sync in/out, retention, resume, stop preservation and destruction',
  );
} finally {
  await prepared?.cleanupWorkspaceSnapshot();
  try {
    if (lease?.providerLeaseId)
      await provider.destroy({
        ...base,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
