import { log } from './logging.js';
import {
  PluginEnvironmentCreationCleanupError,
  type PluginEnvironmentAcquireLeaseParams as Acquire,
  type PluginEnvironmentResumeLeaseParams as Resume,
  type PluginEnvironmentReleaseLeaseParams as Release,
  type PluginEnvironmentExecuteParams as Execute,
  type PluginEnvironmentRealizeWorkspaceParams as Realize,
  type PluginEnvironmentLease,
  type PluginEnvironmentTerminationReceipt,
  type PluginEnvironmentProbeParams,
  type PluginEnvironmentProbeResult,
  type PluginLogger,
} from '@paperclipai/plugin-sdk';
import {
  DuplexChannels,
  DuplexUnavailableError,
  leaseKey,
  type DuplexLauncher,
} from './duplex.js';
import type { Config } from './config.js';
import type { Identity } from './identity.js';
import { parseConfig } from './config.js';
import { run, checkStdin, type Runner } from './cli.js';
import {
  identity,
  lease,
  verify,
  legacyName,
  cleanupIdentity,
} from './identity.js';
import { parseCleanupRecovery, type CleanupRecovery } from './recovery.js';
import { SandboxClient, validateExecution } from './sandbox-client.js';
import { acquire } from './acquisition.js';
import { remaining } from './deadline.js';
export class OpenShellProvider {
  private leases = new Map<string, { c: Config; i: Identity }>();
  private pending = new Set<{ scope: string; key?: string; valid: boolean }>();
  private shuttingDown = false;
  readonly duplex: DuplexChannels;
  private scopeKey(p: {
    companyId: string;
    environmentId: string;
    driverKey: string;
  }) {
    return JSON.stringify([p.companyId, p.environmentId, p.driverKey]);
  }
  private async validated<T>(
    p: {
      companyId: string;
      environmentId: string;
      driverKey: string;
      config: Record<string, unknown>;
    },
    id: string | null | undefined,
    action: () => Promise<T>,
    resultLease: (result: T) => PluginEnvironmentLease,
  ): Promise<T> {
    const token = {
      scope: this.scopeKey(p),
      key: id ? leaseKey({ ...p, providerLeaseId: id }) : undefined,
      valid: !this.shuttingDown,
    };
    if (this.pending.size >= 1024)
      throw new Error('Lease validation capacity exceeded');
    this.pending.add(token);
    try {
      const result = await action();
      const l = resultLease(result);
      if (!l.providerLeaseId) {
        if (token.key) await this.forget(p, id!);
      } else if (token.valid) {
        const c = await this.config(p);
        const i = identity(p, l.providerLeaseId, l.metadata, c);
        const key = leaseKey({ ...p, providerLeaseId: l.providerLeaseId });
        if (token.valid) {
          this.leases.set(key, {
            c: {
              executable: c.executable,
              sshExecutable: c.sshExecutable,
              configHome: c.configHome,
              gateway: c.gateway,
              workspace: c.workspace,
              timeoutMs: c.timeoutMs,
              enableDuplex: c.enableDuplex,
              reuseLease: c.reuseLease,
              image: '',
              providers: [],
            },
            i,
          });
          if (this.leases.size > 1024) {
            const oldest = this.leases.keys().next().value!;
            this.leases.delete(oldest);
            await this.duplex.invalidate(oldest);
          }
        }
      }
      return result;
    } catch (error) {
      if (id) await this.forget(p, id);
      throw error;
    } finally {
      this.pending.delete(token);
    }
  }
  private async forget(
    p: { companyId: string; environmentId: string; driverKey: string },
    id: string | null,
  ) {
    if (!id) return;
    const key = leaseKey({ ...p, providerLeaseId: id });
    for (const token of this.pending)
      if (token.key === key || (!token.key && token.scope === this.scopeKey(p)))
        token.valid = false;
    this.leases.delete(key);
    await this.duplex.invalidate(key);
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const token of this.pending) token.valid = false;
    this.leases.clear();
    await this.duplex.shutdown();
  }
  private logger?: PluginLogger;
  private pluginConfig?: (
    companyId: string,
  ) => Promise<Record<string, unknown>>;
  setPluginConfig(
    resolve: (companyId: string) => Promise<Record<string, unknown>>,
  ) {
    this.pluginConfig = resolve;
  }
  private cleanupRecovery?: (companyId: string) => Promise<CleanupRecovery[]>;
  setCleanupRecovery(
    resolve: (companyId: string) => Promise<CleanupRecovery[]>,
  ) {
    this.cleanupRecovery = resolve;
  }
  setLogger(logger: PluginLogger) {
    this.logger = logger;
    this.client.logger = logger;
    this.duplex.logger = logger;
  }
  constructor(runner: Runner = run, pollMs = 500, launcher?: DuplexLauncher) {
    this.client = new SandboxClient(runner, pollMs);
    this.duplex = new DuplexChannels(async (p, signal) => {
      const key = leaseKey(p);
      const entry = this.leases.get(key);
      log(this.logger, 'info', 'OpenShell duplex environment selection', {
        companyId: p.companyId,
        environmentId: p.environmentId,
        enableDuplex: entry?.c.enableDuplex === true,
      });
      if (p.driverKey !== 'openshell' || !entry)
        throw new DuplexUnavailableError(
          'lease unknown in this worker; resume or execute with verified metadata first',
        );
      if (!entry.c.enableDuplex)
        throw new DuplexUnavailableError(
          'environment enableDuplex is off; file polling remains active',
        );
      const valid = () =>
        !signal.aborted && !this.shuttingDown && this.leases.get(key) === entry;
      try {
        const sandbox = await this.client.inspect(
          entry.c,
          entry.i.name,
          this.client.clock.now() + Math.min(entry.c.timeoutMs, 10_000),
          undefined,
          signal,
        );
        if (!valid()) throw new Error('Duplex lease invalidated');
        if (!sandbox) throw new Error('Duplex sandbox unavailable');
        verify(sandbox, entry.i);
        if (!entry.i.id || sandbox.phase !== 'Ready')
          throw new Error('Duplex sandbox is not ready');
        return { ...entry, valid };
      } catch {
        if (this.leases.get(key) === entry)
          await this.forget(p, p.providerLeaseId);
        throw new DuplexUnavailableError(
          'fresh scoped lease lookup, allocation identity or readiness verification failed',
        );
      }
    }, launcher);
  }
  private readonly client: SandboxClient;
  async acquire(p: Acquire) {
    return this.validated(
      p,
      undefined,
      async () => acquire(p, await this.config(p), this.client, this.logger),
      (result) => result,
    );
  }
  private async config(p: {
    driverKey: string;
    companyId: string;
    config: Record<string, unknown>;
  }) {
    if (p.driverKey !== 'openshell') throw new Error('Unsupported driver key');
    return parseConfig(p.config);
  }
  private async cleanupConfig(p: Release) {
    if (p.driverKey !== 'openshell') throw new Error('Unsupported driver key');
    const metadata = p.leaseMetadata?.openshell;
    const saved =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    let entries: CleanupRecovery[] = [];
    try {
      entries = this.cleanupRecovery
        ? await this.cleanupRecovery(p.companyId)
        : parseCleanupRecovery((await this.pluginConfig?.(p.companyId)) ?? {});
    } catch (error) {
      if (!saved.gateway) throw error;
      log(
        this.logger,
        'warn',
        'OpenShell recovery settings unavailable; using saved lease connection',
        {
          companyId: p.companyId,
          environmentId: p.environmentId,
        },
      );
    }
    const scopeRecovery = entries.find(
      (entry) => entry.environmentId === p.environmentId,
    );
    // Persisted lease connection settings are independent of current runtime edits.
    const c = parseConfig({
      gateway: saved.gateway ?? p.config.gateway ?? scopeRecovery?.gateway,
      workspace: saved.gateway
        ? saved.workspace
        : (p.config.workspace ?? scopeRecovery?.workspace),
      executable: saved.gateway ? saved.executable : p.config.executable,
      configHome: saved.gateway
        ? saved.configHome
        : (scopeRecovery?.configHome ?? p.config.configHome),
      image: 'cleanup',
      timeoutMs:
        typeof p.config.timeoutMs === 'number' &&
        Number.isInteger(p.config.timeoutMs) &&
        p.config.timeoutMs >= 1000
          ? Math.min(p.config.timeoutMs, 30_000)
          : 30_000,
      reuseLease: p.config.reuseLease === true,
    });
    const recovery = entries?.find(
      (entry) =>
        entry.environmentId === p.environmentId &&
        entry.gateway === c.gateway &&
        entry.workspace === c.workspace,
    );
    if (recovery?.configHome) c.configHome = recovery.configHome;
    return { c, recovery };
  }
  async probe(
    p: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    try {
      const c = await this.config(p);
      await this.client.preflight(
        c,
        '',
        this.client.clock.now() + Math.min(c.timeoutMs, 30_000),
      );
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
      log(this.logger, 'warn', 'OpenShell draft probe failed', {
        error: message,
      });
      return {
        ok: false,
        summary: message,
        diagnostics: [
          { severity: 'error', code: 'openshell_preflight_failed', message },
        ],
      };
    }
  }
  async resume(p: Resume): Promise<PluginEnvironmentLease> {
    return this.validated(
      p,
      p.providerLeaseId,
      () => this.resumeValidated(p),
      (result) => result,
    );
  }
  private async resumeValidated(p: Resume): Promise<PluginEnvironmentLease> {
    const c = await this.config(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (!c.reuseLease || !i.reuseLease)
      return { providerLeaseId: null, metadata: { expired: true } };
    const deadline = this.client.clock.now() + c.timeoutMs;
    const s = await this.client.inspect(c, i.name, deadline);
    if (!s) return { providerLeaseId: null, metadata: { expired: true } };
    verify(s, i);
    if (s.phase === 'Stopped')
      await this.client.command(c, ['start', i.name], deadline);
    await this.client.wait(c, i, 'Ready', deadline);
    return lease(i);
  }
  async execute(p: Execute, onOutput?: Parameters<Runner>[5]) {
    return this.validated(
      p,
      p.lease.providerLeaseId,
      () => this.executeValidated(p, onOutput),
      () => p.lease,
    );
  }
  private async executeValidated(p: Execute, onOutput?: Parameters<Runner>[5]) {
    const started = this.client.clock.now();
    const c = await this.config(p);
    checkStdin(p.stdin);
    const i = identity(p, p.lease.providerLeaseId, p.lease.metadata, c);
    validateExecution(
      p.command,
      p.args ?? [],
      p.cwd ?? i.remotePath,
      p.env ?? {},
      p.stdin,
      p.timeoutMs ?? c.timeoutMs,
    );
    const timeoutMs = p.timeoutMs ?? c.timeoutMs;
    const deadline = started + timeoutMs;
    const s = await this.client.inspectExecution(c, i, deadline);
    if (!s) throw new Error('Sandbox missing');
    verify(s, i);
    if (s.phase !== 'Ready') throw new Error('Sandbox is not ready');
    log(this.logger, 'debug', 'OpenShell execution ownership verified', {
      sandboxName: i.name,
      inspectionMs: this.client.clock.now() - started,
      remainingMs: Math.max(0, deadline - this.client.clock.now()),
    });
    return this.client.exec(
      c,
      i,
      p.command,
      p.args ?? [],
      p.cwd ?? i.remotePath,
      p.env ?? {},
      p.stdin,
      remaining(deadline, this.client.clock),
      onOutput,
    );
  }
  async realize(p: Realize) {
    const c = await this.config(p);
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
    await this.forget(p, p.providerLeaseId);
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const { c } = await this.cleanupConfig(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (i.reuseLease && c.reuseLease) {
      if (p.cancelActiveWork) return this.stop(p);
      const s = await this.client.inspect(
        c,
        i.name,
        this.client.clock.now() + c.timeoutMs,
      );
      if (s) verify(s, i);
      return;
    }
    return this.destroy(p);
  }
  async stop(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    await this.forget(p, p.providerLeaseId);
    const { c } = await this.cleanupConfig(p);
    const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    const deadline = this.client.clock.now() + c.timeoutMs;
    const s = await this.client.inspect(c, i.name, deadline);
    if (!s) throw new Error('Cannot confirm stop of missing sandbox');
    verify(s, i);
    if (s.phase !== 'Stopped')
      await this.client.command(c, ['stop', i.name], deadline);
    await this.client.wait(c, i, 'Stopped', deadline);
    return { providerLeaseId: p.providerLeaseId!, state: 'stopped' };
  }
  async destroy(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    await this.forget(p, p.providerLeaseId);
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const { c, recovery } = await this.cleanupConfig(p);
    const deadline = this.client.clock.now() + c.timeoutMs;
    const value = p.leaseMetadata?.failedCreateCleanup;
    const failed =
      value === undefined
        ? undefined
        : cleanupIdentity(p, p.providerLeaseId, value, c);
    const i =
      failed?.identity ?? identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (failed && !i.id) {
      const s = await this.client.inspect(c, i.name, deadline);
      // Versions before this fix always sent 46-character names, rejected
      // before allocation by v0.1.2's 19-character validation. A successful
      // scoped list confirms absence; these attempts cannot appear later.
      if (
        !s &&
        (i.name === legacyName(failed.cleanup.attemptId) ||
          recovery?.rejectedAttemptIds.includes(failed.cleanup.attemptId))
      ) {
        log(this.logger, 'info', 'Reconciled rejected OpenShell allocation', {
          sandboxName: i.name,
          companyId: p.companyId,
          environmentId: p.environmentId,
          operatorConfirmed: i.name !== legacyName(failed.cleanup.attemptId),
        });
        return { providerLeaseId: p.providerLeaseId!, state: 'destroyed' };
      }
      if (s) verify(s, i);
      throw new PluginEnvironmentCreationCleanupError(
        [],
        `Uncertain creation of ${i.name} requires durable identity before teardown${s ? '; observed ID will be persisted for the next sweep' : `; no sandbox observed; verify original create outcome, then use plugin cleanupRecovery.rejectedAttemptIds for attempt ${failed.cleanup.attemptId} if creation was rejected`}`,
        {
          ...failed.cleanup,
          ...(s ? { observedProviderLeaseId: s.id } : {}),
        },
      );
    }
    await this.client.remove(c, i, deadline);
    return { providerLeaseId: p.providerLeaseId!, state: 'destroyed' };
  }
}
