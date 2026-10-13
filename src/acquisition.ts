import { log } from './logging.js';
import { randomUUID } from 'node:crypto';
import {
  PluginEnvironmentCreationCleanupError,
  type PluginEnvironmentCreationCleanup,
  type PluginEnvironmentAcquireLeaseParams as Acquire,
  type PluginEnvironmentLease,
  type PluginLogger,
} from '@paperclipai/plugin-sdk';
import { remotePath, runtimeTools, type Config } from './config.js';
import { json, commandFailure, OpenShellCommandError } from './cli.js';
import {
  fingerprint,
  labelsFor,
  nameFor,
  sandbox,
  verify,
  lease,
  type Identity,
} from './identity.js';
import { SandboxClient } from './sandbox-client.js';
import { remaining } from './deadline.js';
export async function acquire(
  p: Acquire,
  c: Config,
  client: SandboxClient,
  logger?: PluginLogger,
): Promise<PluginEnvironmentLease> {
  if (p.requestedExpiresAt != null)
    throw new Error('OpenShell CLI cannot guarantee provider-enforced expiry');
  const attemptId = randomUUID();
  const i: Identity = {
    name: nameFor(attemptId),
    gateway: c.gateway,
    workspace: c.workspace,
    labels: labelsFor(p, attemptId),
    remotePath,
    reuseLease: c.reuseLease,
    executable: c.executable,
    ...(c.configHome ? { configHome: c.configHome } : {}),
  };
  const deadline = client.clock.now() + c.timeoutMs;
  const setupDeadline =
    deadline - Math.min(30_000, Math.floor(c.timeoutMs / 10));
  let outcome: 'not_attempted' | 'uncertain' | 'observed' = 'not_attempted';
  let rejected = false;
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
  log(logger, 'info', 'OpenShell acquisition started', {
    sandboxName: i.name,
    companyId: p.companyId,
    environmentId: p.environmentId,
    runId: p.runId,
    attemptId,
    gateway: c.gateway,
    workspace: c.workspace,
  });
  try {
    // Fail gateway, worker config and response-contract errors before a
    // create request can leave a durable uncertain-cleanup record.
    await client.preflight(c, i.name, setupDeadline);
    phase = 'allocation';
    const args = [
      'create',
      '--name',
      i.name,
      ...(c.template ? ['--template', c.template] : ['--from', c.image]),
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
    // A detached login shell can exit at EOF. Use a persistent canonical
    // command so subsequent exec and retained leases stay available.
    args.push('--', '/bin/sh', '-c', 'while :; do sleep 3600; done');
    if (c.policyFile)
      args.splice(args.indexOf('--'), 0, '--policy', c.policyFile);
    remaining(setupDeadline, client.clock);
    outcome = 'uncertain';
    let response: string;
    try {
      response = await client.command(c, args, setupDeadline);
    } catch (error) {
      if (error instanceof OpenShellCommandError && error.allocationImpossible)
        rejected = true;
      throw error;
    }
    const created = sandbox(json(response));
    verify(created, i);
    i.id = created.id;
    outcome = 'observed';
    phase = 'readiness';
    await client.wait(c, i, 'Ready', setupDeadline);
    phase = 'workspace and runtime checks';
    const setup = await client.exec(
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
      remaining(setupDeadline, client.clock),
    );
    if (setup.exitCode !== 0 || setup.timedOut) {
      const missing = runtimeTools.filter((tool) =>
        setup.stderr.includes(`paperclip: missing tool ${tool}\n`),
      );
      const workspace =
        setup.stderr.includes('paperclip: cannot create workspace') ||
        setup.stderr.includes('paperclip: workspace is not writable');
      throw new Error(
        `Runtime workspace/tool check failed for ${c.template ? `template ${c.template}` : `image ${c.image}`}: ${missing.length ? `missing ${missing.join(', ')}` : workspace ? `cannot write ${remotePath}; check image user and filesystem policy` : commandFailure(c, 'exec', setup).message}`,
      );
    }
    log(logger, 'info', 'OpenShell acquisition ready', {
      sandboxName: i.name,
      sandboxId: i.id,
      companyId: p.companyId,
      environmentId: p.environmentId,
      attemptId,
    });
    return lease(i);
  } catch (error) {
    const reason = (error as Error).message;
    log(logger, 'error', 'OpenShell acquisition failed', {
      phase,
      sandboxName: i.name,
      gateway: c.gateway,
      workspace: c.workspace,
      error: reason,
    });
    if (outcome === 'not_attempted' || rejected)
      throw new Error(
        `OpenShell acquisition failed during ${phase}; no allocation created: ${reason}`,
        { cause: error },
      );
    let cleanupError: unknown;
    // A timed-out create must not consume the cleanup budget.
    const cleanupDeadline = client.clock.now() + Math.min(c.timeoutMs, 30_000);
    try {
      await client.remove(c, i, cleanupDeadline);
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      const cleanupReason = (cleanupError as Error).message;
      log(
        logger,
        'error',
        'OpenShell allocation cleanup requires reconciliation',
        {
          sandboxName: i.name,
          error: cleanupReason,
        },
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
