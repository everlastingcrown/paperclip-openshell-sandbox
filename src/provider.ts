import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginEnvironmentCreationCleanupError, type PluginEnvironmentCreationCleanup,
  type PluginEnvironmentAcquireLeaseParams as Acquire, type PluginEnvironmentResumeLeaseParams as Resume,
  type PluginEnvironmentReleaseLeaseParams as Release, type PluginEnvironmentExecuteParams as Execute,
  type PluginEnvironmentRealizeWorkspaceParams as Realize, type PluginEnvironmentDriverBaseParams as Base,
  type PluginEnvironmentLease, type PluginEnvironmentTerminationReceipt } from '@paperclipai/plugin-sdk';
import { parseConfig, remotePath, type Config } from './config.js';
import { run, lifecycle, json, object, scope, checkStdin, type Runner } from './cli.js';
import { pluginId } from './manifest.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fingerprint = (c: Config) => hash(JSON.stringify([c.gateway, c.workspace]));
const labelsFor = (p: Base, attempt: string) => ({ 'paperclip-provider': 'openshell', 'paperclip-company': hash(p.companyId).slice(0,32), 'paperclip-environment': hash(p.environmentId).slice(0,32), 'paperclip-attempt': attempt });
interface Identity { name: string; id?: string; gateway: string; workspace: string; labels: Record<string,string>; remotePath: string; reuseLease: boolean; }
interface Sandbox { id: string; name: string; workspace: string; phase: string; labels: Record<string,string>; }
function sandbox(value: unknown): Sandbox {
  const v = object(value); const labels = object(v.labels);
  if (['id','name','workspace','phase'].some(k => typeof v[k] !== 'string' || !v[k]) || Object.values(labels).some(v => typeof v !== 'string')) throw new Error('Invalid sandbox JSON shape');
  return v as unknown as Sandbox;
}
function identity(p: Base, id: string | null, metadata: Record<string,unknown> | undefined, c: Config): Identity {
  if (!id) throw new Error('Missing provider lease ID');
  const m = object(metadata?.openshell); const labels = object(m.labels);
  const expected = labelsFor(p, String(labels['paperclip-attempt']));
  if (m.pluginId !== pluginId || m.id !== id || typeof m.name !== 'string' || !/^paperclip-[0-9a-f-]{36}$/.test(m.name) ||
      m.gateway !== c.gateway || m.workspace !== c.workspace || m.remotePath !== remotePath || typeof m.reuseLease !== 'boolean' ||
      !/^[0-9a-f-]{36}$/.test(String(labels['paperclip-attempt'])) ||
      Object.entries(expected).some(([k,v]) => labels[k] !== v)) throw new Error('Lease ownership or scope mismatch');
  return m as unknown as Identity;
}
function lease(i: Identity): PluginEnvironmentLease { return { providerLeaseId: i.id!, metadata: { remoteCwd: i.remotePath, shellCommand: 'bash', openshell: { ...i, pluginId } }, expiresAt: null }; }
function verify(s: Sandbox, i: Identity) {
  if ((i.id && s.id !== i.id) || s.name !== i.name || s.workspace !== i.workspace || Object.entries(i.labels).some(([k,v]) => s.labels[k] !== v)) throw new Error('Sandbox ownership mismatch');
}
export class OpenShellProvider {
  constructor(private readonly runner: Runner = run, private readonly pollMs = 500) {}
  private config(p: { driverKey: string; config: Record<string,unknown> }) {
    if (p.driverKey !== 'openshell') throw new Error('Unsupported driver key');
    return parseConfig(p.config);
  }
  private async inspect(c: Config, name: string, deadline: number): Promise<Sandbox | null> {
    let token = ''; const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const response = object(json(await lifecycle(c, ['list', '--output', 'json', '--page-size', '100', '--page-token', token], deadline, this.runner)));
      if (!Array.isArray(response.sandboxes) || typeof response.next_page_token !== 'string') throw new Error('Invalid sandbox list JSON shape');
      const entries = response.sandboxes.map(sandbox);
      const found = entries.filter(s => s.name === name);
      if (found.length > 1) throw new Error('Ambiguous sandbox identity');
      if (found[0]) return found[0];
      token = response.next_page_token;
      if (!token) return null;
      if (seen.has(token)) throw new Error('Repeated OpenShell pagination token');
      seen.add(token);
    }
    throw new Error('OpenShell pagination limit exceeded');
  }
  private async wait(c: Config, i: Identity, state: 'Ready' | 'Stopped' | 'missing', deadline: number) {
    while (Date.now() < deadline) {
      const s = await this.inspect(c, i.name, deadline);
      if (!s) { if (state === 'missing') return; throw new Error('Sandbox missing'); }
      verify(s, i);
      if (s.phase === state) return;
      if (state === 'Ready' && ['Error','Completed','Deleting'].includes(s.phase)) throw new Error('Sandbox did not become ready');
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Sandbox ${state} confirmation timed out`);
  }
  private async exec(c: Config, i: Identity, command: string, args: string[], cwd: string, env: Record<string,string>, stdin: string | undefined, timeoutMs: number) {
    checkStdin(stdin);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000) throw new Error('Invalid execution timeout');
    if (!command || command.includes('\0') || args.some(a => typeof a !== 'string' || a.includes('\0')) || !cwd.startsWith('/') || cwd.includes('\0')) throw new Error('Invalid execution arguments');
    const flags = ['exec', '--name', i.name, '--no-tty', '--no-login-shell', '--workdir', cwd, '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    for (const [key,value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid command environment');
      flags.push('--env', `${key}=${value}`);
    }
    const result = await this.runner(c.executable, [...scope(c), 'sandbox', ...flags, '--', command, ...args], timeoutMs, stdin);
    // The v0.1.2 CLI exposes remote timeout as exit 124, with no separate flag.
    return { ...result, timedOut: result.timedOut || result.exitCode === 124 };
  }
  async acquire(p: Acquire): Promise<PluginEnvironmentLease> {
    const c = this.config(p);
    if (p.requestedExpiresAt != null) throw new Error('OpenShell CLI cannot guarantee provider-enforced expiry');
    const attemptId = randomUUID();
    const i: Identity = { name: `paperclip-${attemptId}`, gateway: c.gateway, workspace: c.workspace, labels: labelsFor(p, attemptId), remotePath, reuseLease: c.reuseLease };
    const deadline = Date.now() + c.timeoutMs;
    const setupDeadline = deadline - Math.min(30_000, Math.floor(c.timeoutMs / 10));
    let allocated = false;
    let phase = 'allocation';
    const cleanup = (): PluginEnvironmentCreationCleanup => ({ providerLeaseId: i.name, ...(i.id ? { observedProviderLeaseId: i.id } : {}), companyId: p.companyId, environmentId: p.environmentId, runId: p.runId, attemptId, accountFingerprint: fingerprint(c), labels: i.labels });
    try {
      const args = ['create', '--name', i.name, '--from', c.image, '--detach', '--no-tty', '--no-auto-providers', '--approval-mode', 'manual', '--output', 'json'];
      for (const [key,value] of Object.entries(i.labels)) args.push('--label', `${key}=${value}`);
      for (const provider of c.providers) args.push('--provider', provider);
      if (c.policyFile) args.push('--policy', c.policyFile);
      if (c.cpu) args.push('--cpu', c.cpu); if (c.memory) args.push('--memory', c.memory);
      allocated = true;
      const created = sandbox(json(await lifecycle(c, args, setupDeadline, this.runner)));
      verify(created, i); i.id = created.id;
      phase = 'readiness';
      await this.wait(c, i, 'Ready', setupDeadline);
      phase = 'workspace and runtime checks';
      const setup = await this.exec(c, i, '/bin/sh', ['-c', 'set -eu; mkdir -p "$1"; for tool in sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename awk sed head tail touch cp ln sleep; do command -v "$tool" >/dev/null; done; test -w "$1"', 'paperclip-setup', remotePath], '/', {}, undefined, setupDeadline - Date.now());
      if (setup.exitCode !== 0 || setup.timedOut) throw new Error('Runtime workspace/tool check failed');
      return lease(i);
    } catch {
      if (!allocated) throw new Error('Acquisition failed before allocation');
      try {
        const found = await this.inspect(c, i.name, deadline);
        if (!found) { if (!i.id) throw new Error('Allocation outcome uncertain'); }
        else { verify(found, i); i.id = found.id; await lifecycle(c, ['delete', i.name], deadline, this.runner); await this.wait(c, i, 'missing', deadline); }
      } catch {
        throw new PluginEnvironmentCreationCleanupError([], `OpenShell acquisition failed during ${phase}; allocation cleanup requires reconciliation`, cleanup());
      }
      throw new Error(`OpenShell acquisition failed during ${phase}; owned allocation cleaned up`);
    }
  }
  async resume(p: Resume): Promise<PluginEnvironmentLease> {
    const c = this.config(p); const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (!c.reuseLease || !i.reuseLease) return { providerLeaseId: null, metadata: { expired: true } };
    const deadline = Date.now() + c.timeoutMs; const s = await this.inspect(c, i.name, deadline);
    if (!s) return { providerLeaseId: null, metadata: { expired: true } };
    verify(s, i);
    if (s.phase === 'Stopped') await lifecycle(c, ['start', i.name], deadline, this.runner);
    await this.wait(c, i, 'Ready', deadline);
    return lease(i);
  }
  async execute(p: Execute) {
    const c = this.config(p); checkStdin(p.stdin);
    const i = identity(p, p.lease.providerLeaseId, p.lease.metadata, c);
    const s = await this.inspect(c, i.name, Date.now() + c.timeoutMs);
    if (!s) throw new Error('Sandbox missing'); verify(s, i);
    if (s.phase !== 'Ready') throw new Error('Sandbox is not ready');
    return this.exec(c, i, p.command, p.args ?? [], p.cwd ?? i.remotePath, p.env ?? {}, p.stdin, p.timeoutMs ?? c.timeoutMs);
  }
  async realize(p: Realize) {
    const c = this.config(p); const i = identity(p, p.lease.providerLeaseId, p.lease.metadata, c);
    const cwd = p.workspace.remotePath ?? i.remotePath;
    const result = await this.execute({ ...p, command: 'mkdir', args: ['-p', '--', cwd], cwd: '/' });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('Workspace realization failed');
    return { cwd };
  }
  async release(p: Release): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const c = this.config(p); const i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    if (i.reuseLease && c.reuseLease) {
      if (p.cancelActiveWork) return this.stop(p);
      const s = await this.inspect(c, i.name, Date.now() + c.timeoutMs); if (s) verify(s, i);
      return;
    }
    return this.destroy(p);
  }
  async stop(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    const c = this.config(p); const i = identity(p, p.providerLeaseId, p.leaseMetadata, c); const deadline = Date.now() + c.timeoutMs;
    const s = await this.inspect(c, i.name, deadline); if (!s) throw new Error('Cannot confirm stop of missing sandbox'); verify(s, i);
    if (s.phase !== 'Stopped') await lifecycle(c, ['stop', i.name], deadline, this.runner);
    await this.wait(c, i, 'Stopped', deadline);
    return { providerLeaseId: p.providerLeaseId!, state: 'stopped' };
  }
  async destroy(p: Release): Promise<PluginEnvironmentTerminationReceipt> {
    if (p.resourceDisposition === 'stop_and_retain') return this.stop(p);
    const c = this.config(p); const deadline = Date.now() + c.timeoutMs;
    let i: Identity;
    const failed = p.leaseMetadata?.failedCreateCleanup;
    if (failed) {
      const f = object(failed); const labels = object(f.labels);
      if (f.providerLeaseId !== p.providerLeaseId || f.companyId !== p.companyId || f.environmentId !== p.environmentId ||
          f.accountFingerprint !== fingerprint(c) || typeof f.attemptId !== 'string' || !/^[0-9a-f-]{36}$/.test(f.attemptId) ||
          f.providerLeaseId !== `paperclip-${f.attemptId}` || Object.entries(labelsFor(p, f.attemptId)).some(([k,v]) => labels[k] !== v) ||
          (f.observedProviderLeaseId !== undefined && typeof f.observedProviderLeaseId !== 'string')) throw new Error('Failed creation ownership mismatch');
      i = { name: f.providerLeaseId as string, id: f.observedProviderLeaseId as string | undefined, gateway: c.gateway, workspace: c.workspace, labels: labels as Record<string,string>, remotePath, reuseLease: false };
    } else i = identity(p, p.providerLeaseId, p.leaseMetadata, c);
    const s = await this.inspect(c, i.name, deadline);
    if (failed && !i.id) {
      if (s) verify(s, i);
      throw new PluginEnvironmentCreationCleanupError([], 'Uncertain creation requires durable identity before teardown', { ...(failed as PluginEnvironmentCreationCleanup), ...(s ? { observedProviderLeaseId: s.id } : {}) });
    }
    if (s) { verify(s, i); await lifecycle(c, ['delete', i.name], deadline, this.runner); await this.wait(c, i, 'missing', deadline); }
    return { providerLeaseId: p.providerLeaseId!, state: 'destroyed' };
  }
}
