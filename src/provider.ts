import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PluginEnvironmentCreationCleanupError,
  type PluginEnvironmentCreationCleanup,
  type PluginEnvironmentAcquireLeaseParams as Acquire,
  type PluginEnvironmentResumeLeaseParams as Resume,
  type PluginEnvironmentReleaseLeaseParams as Release,
  type PluginEnvironmentExecuteParams as Execute,
  type PluginEnvironmentRealizeWorkspaceParams as Realize,
  type PluginEnvironmentDriverBaseParams as Base,
  type PluginEnvironmentLease,
  type PluginEnvironmentTerminationReceipt,
  type PluginEnvironmentProbeParams,
  type PluginEnvironmentProbeResult,
  type PluginLogger,
} from '@paperclipai/plugin-sdk';
import {
  parseConfig,
  remotePath,
  runtimeTools,
  validateRuntimeImage,
  type Config,
} from './config.js';
import {
  run,
  lifecycle,
  json,
  object,
  scope,
  checkStdin,
  commandFailure,
  OpenShellCommandError,
  type Runner,
} from './cli.js';
import { pluginId } from './manifest.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fingerprint = (c: Config) =>
  hash(JSON.stringify([c.gateway, c.workspace]));
async function withPolicyFile<T>(
  c: Config,
  action: (path: string | undefined) => Promise<T>,
): Promise<T> {
  if (!c.policy) return action(c.policyFile);
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'paperclip-openshell-policy-'));
  } catch {
    throw new Error('Cannot create temporary OpenShell policy directory');
  }
  try {
    const path = join(directory, 'policy.yaml');
    try {
      await writeFile(path, c.policy, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new Error('Cannot write temporary OpenShell policy');
    }
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      throw new Error('Cannot remove temporary OpenShell policy');
    });
  }
}
// OpenShell v0.1.2 MAX_ROUTABLE_NAME_LEN is 19. Keep the full attempt UUID
// in ownership labels; 64 random bits suffice for the short routable name.
const nameFor = (attempt: string) => `pc-${hash(attempt).slice(0, 16)}`;
const legacyName = (attempt: string) => `paperclip-${attempt}`;
const labelsFor = (p: Base, attempt: string) => ({
  'paperclip-provider': 'openshell',
  'paperclip-company': hash(p.companyId).slice(0, 32),
  'paperclip-environment': hash(p.environmentId).slice(0, 32),
  'paperclip-attempt': attempt,
});
interface Identity {
  name: string;
  id?: string;
  gateway: string;
  workspace: string;
  labels: Record<string, string>;
  remotePath: string;
  reuseLease: boolean;
}
interface Sandbox {
  id: string;
  name: string;
  workspace: string;
  phase: string;
  labels: Record<string, string>;
}
function sandbox(value: unknown): Sandbox {
  const v = object(value);
  const labels = object(v.labels);
  if (
    ['id', 'name', 'workspace', 'phase'].some(
      (k) => typeof v[k] !== 'string' || !v[k],
    ) ||
    Object.values(labels).some((v) => typeof v !== 'string')
  )
    throw new Error('Invalid sandbox JSON shape');
  return v as unknown as Sandbox;
}
function identity(
  p: Base,
  id: string | null,
  metadata: Record<string, unknown> | undefined,
  c: Config,
): Identity {
  if (!id) throw new Error('Missing provider lease ID');
  const m = object(metadata?.openshell);
  const labels = object(m.labels);
  const expected = labelsFor(p, String(labels['paperclip-attempt']));
  if (
    m.pluginId !== pluginId ||
    m.id !== id ||
    typeof m.name !== 'string' ||
    ![
      nameFor(String(labels['paperclip-attempt'])),
      legacyName(String(labels['paperclip-attempt'])),
    ].includes(m.name) ||
    m.gateway !== c.gateway ||
    m.workspace !== c.workspace ||
    m.remotePath !== remotePath ||
    typeof m.reuseLease !== 'boolean' ||
    !/^[0-9a-f-]{36}$/.test(String(labels['paperclip-attempt'])) ||
    Object.entries(expected).some(([k, v]) => labels[k] !== v)
  )
    throw new Error('Lease ownership or scope mismatch');
  return m as unknown as Identity;
}
function lease(i: Identity): PluginEnvironmentLease {
  return {
    providerLeaseId: i.id!,
    metadata: {
      remoteCwd: i.remotePath,
      shellCommand: 'bash',
      openshell: { ...i, pluginId },
    },
    expiresAt: null,
  };
}
function verify(s: Sandbox, i: Identity) {
  if (
    (i.id && s.id !== i.id) ||
    s.name !== i.name ||
    s.workspace !== i.workspace ||
    Object.entries(i.labels).some(([k, v]) => s.labels[k] !== v)
  )
    throw new Error('Sandbox ownership mismatch');
}
export class OpenShellProvider {
  private logger?: PluginLogger;
  setLogger(logger: PluginLogger) {
    this.logger = logger;
  }
  constructor(
    private readonly runner: Runner = run,
    private readonly pollMs = 500,
  ) {}
  private config(p: { driverKey: string; config: Record<string, unknown> }) {
    if (p.driverKey !== 'openshell') throw new Error('Unsupported driver key');
    return parseConfig(p.config);
  }
  async probe(
    p: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    try {
      const c = this.config(p);
      validateRuntimeImage(c);
      await this.inspect(c, '', Date.now() + Math.min(c.timeoutMs, 30_000));
      return {
        ok: true,
        summary: `OpenShell gateway ${c.gateway} is accessible in workspace ${c.workspace}.`,
        diagnostics: [
          {
            severity: 'info',
            code: 'gateway_accessible',
            message:
              'Connectivity checked without allocating a sandbox. Test Provider checks image boot, runtime tools and workspace writes.',
          },
        ],
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger?.warn('OpenShell draft probe failed', { error: message });
      return {
        ok: false,
        summary: message,
        diagnostics: [
          { severity: 'error', code: 'openshell_preflight_failed', message },
        ],
      };
    }
  }
  private async inspect(
    c: Config,
    name: string,
    deadline: number,
  ): Promise<Sandbox | null> {
    let token = '';
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const response = object(
        json(
          await lifecycle(
            c,
            [
              'list',
              '--output',
              'json',
              '--page-size',
              '100',
              '--page-token',
              token,
            ],
            deadline,
            this.runner,
          ),
        ),
      );
      if (
        !Array.isArray(response.sandboxes) ||
        typeof response.next_page_token !== 'string'
      )
        throw new Error('Invalid sandbox list JSON shape');
      const entries = response.sandboxes.map(sandbox);
      const found = entries.filter((s) => s.name === name);
      if (found.length > 1) throw new Error('Ambiguous sandbox identity');
      if (found[0]) return found[0];
      token = response.next_page_token;
      if (!token) return null;
      if (seen.has(token))
        throw new Error('Repeated OpenShell pagination token');
      seen.add(token);
    }
    throw new Error('OpenShell pagination limit exceeded');
  }
  private async wait(
    c: Config,
    i: Identity,
    state: 'Ready' | 'Stopped' | 'missing',
    deadline: number,
  ) {
    while (Date.now() < deadline) {
      const s = await this.inspect(c, i.name, deadline);
      if (!s) {
        if (state === 'missing') return;
        throw new Error('Sandbox missing');
      }
      verify(s, i);
      if (s.phase === state) return;
      if (
        state === 'Ready' &&
        ['Error', 'Completed', 'Deleting'].includes(s.phase)
      )
        throw new Error(
          `Sandbox ${i.name} did not become ready (phase=${s.phase})`,
        );
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Sandbox ${state} confirmation timed out`);
  }
  private async exec(
    c: Config,
    i: Identity,
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    stdin: string | undefined,
    timeoutMs: number,
  ) {
    checkStdin(stdin);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 86_400_000
    )
      throw new Error('Invalid execution timeout');
    if (
      !command ||
      command.includes('\0') ||
      args.some((a) => typeof a !== 'string' || a.includes('\0')) ||
      !cwd.startsWith('/') ||
      cwd.includes('\0')
    )
      throw new Error('Invalid execution arguments');
    const flags = [
      'exec',
      '--name',
      i.name,
      '--no-tty',
      '--no-login-shell',
      '--workdir',
      cwd,
      '--timeout',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ];
    for (const [key, value] of Object.entries(env)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== 'string' ||
        value.includes('\0')
      )
        throw new Error('Invalid command environment');
      flags.push('--env', `${key}=${value}`);
    }
    const result = await this.runner(
      c.executable,
      [...scope(c), 'sandbox', ...flags, '--', command, ...args],
      timeoutMs,
      stdin,
      c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
    );
    // The v0.1.2 CLI exposes remote timeout as exit 124, with no separate flag.
    return { ...result, timedOut: result.timedOut || result.exitCode === 124 };
  }
  async acquire(p: Acquire): Promise<PluginEnvironmentLease> {
    const c = this.config(p);
    validateRuntimeImage(c);
    if (p.requestedExpiresAt != null)
      throw new Error(
        'OpenShell CLI cannot guarantee provider-enforced expiry',
      );
    const attemptId = randomUUID();
    const i: Identity = {
      name: nameFor(attemptId),
      gateway: c.gateway,
      workspace: c.workspace,
      labels: labelsFor(p, attemptId),
      remotePath,
      reuseLease: c.reuseLease,
    };
    const deadline = Date.now() + c.timeoutMs;
    const setupDeadline =
      deadline - Math.min(30_000, Math.floor(c.timeoutMs / 10));
    let allocated = false;
    let phase = 'preflight';
    const cleanup = (): PluginEnvironmentCreationCleanup => ({
      providerLeaseId: i.name,
      ...(i.id ? { observedProviderLeaseId: i.id } : {}),
      companyId: p.companyId,
      environmentId: p.environmentId,
      runId: p.runId,
      attemptId,
      accountFingerprint: fingerprint(c),
      labels: i.labels,
    });
    try {
      // Fail gateway, worker config and response-contract errors before a
      // create request can leave a durable uncertain-cleanup record.
      await this.inspect(c, i.name, setupDeadline);
      phase = 'allocation';
      const args = [
        'create',
        '--name',
        i.name,
        '--from',
        c.image,
        '--detach',
        '--no-tty',
        '--no-auto-providers',
        '--approval-mode',
        'manual',
        '--output',
        'json',
      ];
      for (const [key, value] of Object.entries(i.labels))
        args.push('--label', `${key}=${value}`);
      for (const provider of c.providers) args.push('--provider', provider);
      if (c.cpu) args.push('--cpu', c.cpu);
      if (c.memory) args.push('--memory', c.memory);
      // A detached login shell can exit at EOF. Use a persistent canonical
      // command so subsequent exec and retained leases stay available.
      args.push('--', '/bin/sh', '-c', 'while :; do sleep 3600; done');
      const created = sandbox(
        json(
          await withPolicyFile(c, async (path) => {
            // Insert flags before the canonical command separator.
            if (path) args.splice(args.indexOf('--'), 0, '--policy', path);
            allocated = true;
            return lifecycle(c, args, setupDeadline, this.runner);
          }),
        ),
      );
      verify(created, i);
      i.id = created.id;
      phase = 'readiness';
      await this.wait(c, i, 'Ready', setupDeadline);
      phase = 'workspace and runtime checks';
      const setup = await this.exec(
        c,
        i,
        '/bin/sh',
        [
          '-c',
          `set -eu; for tool in ${runtimeTools.join(' ')}; do command -v "$tool" >/dev/null || { echo "paperclip: missing tool $tool" >&2; exit 1; }; done; mkdir -p "$1" || { echo 'paperclip: cannot create workspace' >&2; exit 1; }; test -w "$1" || { echo 'paperclip: workspace is not writable' >&2; exit 1; }`,
          'paperclip-setup',
          remotePath,
        ],
        '/',
        {},
        undefined,
        setupDeadline - Date.now(),
      );
      if (setup.exitCode !== 0 || setup.timedOut) {
        const missing = runtimeTools.filter((tool) =>
          setup.stderr.includes(`paperclip: missing tool ${tool}\n`),
        );
        const workspace =
          setup.stderr.includes('paperclip: cannot create workspace') ||
          setup.stderr.includes('paperclip: workspace is not writable');
        throw new Error(
          `Runtime workspace/tool check failed for image ${c.image}: ${missing.length ? `missing ${missing.join(', ')}` : workspace ? `cannot write ${remotePath}; check image user and filesystem policy` : commandFailure(c, 'exec', setup).message}`,
        );
      }
      return lease(i);
    } catch (error) {
      const reason = (error as Error).message;
      this.logger?.error('OpenShell acquisition failed', {
        phase,
        sandboxName: i.name,
        gateway: c.gateway,
        workspace: c.workspace,
        error: reason,
      });
      if (
        !allocated ||
        (error instanceof OpenShellCommandError && error.allocationImpossible)
      )
        throw new Error(
          `OpenShell acquisition failed during ${phase}; no allocation created: ${reason}`,
          { cause: error },
        );
      try {
        const found = await this.inspect(c, i.name, deadline);
        if (!found) {
          if (!i.id)
            throw new Error('Allocation outcome uncertain', { cause: error });
        } else {
          verify(found, i);
          i.id = found.id;
          await lifecycle(c, ['delete', i.name], deadline, this.runner);
          await this.wait(c, i, 'missing', deadline);
        }
      } catch (cleanupError) {
        const cleanupReason = (cleanupError as Error).message;
        this.logger?.error(
          'OpenShell allocation cleanup requires reconciliation',
          { sandboxName: i.name, error: cleanupReason },
        );
        // The SDK explicitly forbids serializing provider exceptions here.
        throw new PluginEnvironmentCreationCleanupError(
          [],
          `OpenShell acquisition failed during ${phase}: ${reason}; allocation cleanup requires reconciliation for ${i.name}: ${cleanupReason}`,
          cleanup(),
        );
      }
      throw new Error(
        `OpenShell acquisition failed during ${phase}; owned allocation cleaned up: ${reason}`,
        { cause: error },
      );
    }
  }
  async resume(p: Resume): Promise<PluginEnvironmentLease> {
    const c = this.config(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (!c.reuseLease || !i.reuseLease)
      return { providerLeaseId: null, metadata: { expired: true } };
    const deadline = Date.now() + c.timeoutMs;
    const s = await this.inspect(c, i.name, deadline);
    if (!s) return { providerLeaseId: null, metadata: { expired: true } };
    verify(s, i);
    if (s.phase === 'Stopped')
      await lifecycle(c, ['start', i.name], deadline, this.runner);
    await this.wait(c, i, 'Ready', deadline);
    return lease(i);
  }
  async execute(p: Execute) {
    const c = this.config(p);
    checkStdin(p.stdin);
    const i = identity(p, p.lease.providerLeaseId, p.lease.metadata, c);
    const s = await this.inspect(c, i.name, Date.now() + c.timeoutMs);
    if (!s) throw new Error('Sandbox missing');
    verify(s, i);
    if (s.phase !== 'Ready') throw new Error('Sandbox is not ready');
    return this.exec(
      c,
      i,
      p.command,
      p.args ?? [],
      p.cwd ?? i.remotePath,
      p.env ?? {},
      p.stdin,
      p.timeoutMs ?? c.timeoutMs,
    );
  }
  async realize(p: Realize) {
    const c = this.config(p);
    const i = identity(p, p.lease.providerLeaseId, p.lease.metadata, c);
    const cwd = p.workspace.remotePath ?? i.remotePath;
    const result = await this.execute({
      ...p,
      command: 'mkdir',
      args: ['-p', '--', cwd],
      cwd: '/',
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error('Workspace realization failed');
    return { cwd };
  }
  async release(
    p: Release,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const c = this.config(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (i.reuseLease && c.reuseLease) {
      if (p.cancelActiveWork) return this.stop(p);
      const s = await this.inspect(c, i.name, Date.now() + c.timeoutMs);
      if (s) verify(s, i);
      return;
    }
    return this.destroy(p);
  }
  async stop(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    const c = this.config(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    const deadline = Date.now() + c.timeoutMs;
    const s = await this.inspect(c, i.name, deadline);
    if (!s) throw new Error('Cannot confirm stop of missing sandbox');
    verify(s, i);
    if (s.phase !== 'Stopped')
      await lifecycle(c, ['stop', i.name], deadline, this.runner);
    await this.wait(c, i, 'Stopped', deadline);
    return { providerLeaseId: p.providerLeaseId!, state: 'stopped' };
  }
  async destroy(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const c = this.config(p);
    const deadline = Date.now() + c.timeoutMs;
    let i: Identity;
    const failed = p.leaseMetadata?.failedCreateCleanup;
    if (failed) {
      const f = object(failed);
      const labels = object(f.labels);
      if (
        f.providerLeaseId !== p.providerLeaseId ||
        f.companyId !== p.companyId ||
        f.environmentId !== p.environmentId ||
        f.accountFingerprint !== fingerprint(c) ||
        typeof f.attemptId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(f.attemptId) ||
        ![nameFor(f.attemptId), legacyName(f.attemptId)].includes(
          String(f.providerLeaseId),
        ) ||
        Object.entries(labelsFor(p, f.attemptId)).some(
          ([k, v]) => labels[k] !== v,
        ) ||
        (f.observedProviderLeaseId !== undefined &&
          typeof f.observedProviderLeaseId !== 'string')
      )
        throw new Error('Failed creation ownership mismatch');
      i = {
        name: f.providerLeaseId as string,
        id: f.observedProviderLeaseId as string | undefined,
        gateway: c.gateway,
        workspace: c.workspace,
        labels: labels as Record<string, string>,
        remotePath,
        reuseLease: false,
      };
    } else i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    const s = await this.inspect(c, i.name, deadline);
    if (failed && !i.id) {
      // Versions before this fix always sent 46-character names, rejected
      // before allocation by v0.1.2's 19-character validation. A successful
      // scoped list confirms absence; these attempts cannot appear later.
      if (!s && i.name === legacyName(String(object(failed).attemptId))) {
        this.logger?.info('Reconciled rejected legacy OpenShell allocation', {
          sandboxName: i.name,
        });
        return { providerLeaseId: p.providerLeaseId!, state: 'destroyed' };
      }
      if (s) verify(s, i);
      throw new PluginEnvironmentCreationCleanupError(
        [],
        `Uncertain creation of ${i.name} requires durable identity before teardown${s ? '; observed ID will be persisted for the next sweep' : '; no sandbox observed, investigate the original create failure before manual reconciliation'}`,
        {
          ...(failed as PluginEnvironmentCreationCleanup),
          ...(s ? { observedProviderLeaseId: s.id } : {}),
        },
      );
    }
    if (s) {
      verify(s, i);
      await lifecycle(c, ['delete', i.name], deadline, this.runner);
      await this.wait(c, i, 'missing', deadline);
    }
    return { providerLeaseId: p.providerLeaseId!, state: 'destroyed' };
  }
}
