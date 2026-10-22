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
  }
  constructor(runner: Runner = run, pollMs = 500) {
    this.client = new SandboxClient(runner, pollMs);
  }
  private readonly client: SandboxClient;
  async acquire(p: Acquire) {
    return acquire(p, await this.config(p), this.client, this.logger);
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
