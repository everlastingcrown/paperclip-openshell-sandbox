import { randomUUID } from 'node:crypto';
import {
  PluginEnvironmentCreationCleanupError,
  type PluginEnvironmentCreationCleanup,
  type PluginEnvironmentAcquireLeaseParams as Acquire,
  type PluginEnvironmentLease,
  type PluginLogger,
} from '@paperclipai/plugin-sdk';
import {
  remotePath,
  runtimeTools,
  validateRuntimeImage,
  type Config,
} from './config.js';
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
import { withPolicyFile, type PolicyFiles } from './policy.js';
import { SandboxClient } from './sandbox-client.js';
import { remaining } from './deadline.js';
export async function acquire(
  p: Acquire,
  c: Config,
  client: SandboxClient,
  logger?: PluginLogger,
  policyFiles?: PolicyFiles,
): Promise<PluginEnvironmentLease> {
  validateRuntimeImage(c);
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
  let outcome: 'not_attempted' | 'rejected' | 'uncertain' | 'observed' =
    'not_attempted';
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
    if (c.cpu) args.push('--cpu', c.cpu);
    if (c.memory) args.push('--memory', c.memory);
    // A detached login shell can exit at EOF. Use a persistent canonical
    // command so subsequent exec and retained leases stay available.
    args.push('--', '/bin/sh', '-c', 'while :; do sleep 3600; done');
    await withPolicyFile(
      c,
      async (path) => {
        if (path) args.splice(args.indexOf('--'), 0, '--policy', path);
        remaining(setupDeadline, client.clock);
        outcome = 'uncertain';
        let response: string;
        try {
          response = await client.command(c, args, setupDeadline);
        } catch (error) {
          if (
            error instanceof OpenShellCommandError &&
            error.allocationImpossible
          )
            outcome = 'rejected';
          throw error;
        }
        const created = sandbox(json(response));
        verify(created, i);
        i.id = created.id;
        outcome = 'observed';
      },
      policyFiles,
    );
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
    return lease(i);
  } catch (error) {
    const reason = (error as Error).message;
    logger?.error('OpenShell acquisition failed', {
      phase,
      sandboxName: i.name,
      gateway: c.gateway,
      workspace: c.workspace,
      error: reason,
    });
    if (outcome === 'not_attempted' || outcome === 'rejected')
      throw new Error(
        `OpenShell acquisition failed during ${phase}; no allocation created: ${reason}`,
        { cause: error },
      );
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const found = await client.inspect(c, i.name, deadline);
        if (!found) {
          if (!i.id)
            throw new Error('Allocation outcome uncertain', { cause: error });
        } else {
          verify(found, i);
          i.id = found.id;
          await client.command(c, ['delete', i.name], deadline);
          await client.wait(c, i, 'missing', deadline);
        }
        cleanupError = undefined;
        break;
      } catch (failure) {
        cleanupError = failure;
        const budget = deadline - client.clock.now();
        if (attempt === 2 || budget <= 1) break;
        await client.clock.sleep(Math.min(500, Math.floor(budget / 2)));
      }
    }
    if (cleanupError) {
      const cleanupReason = (cleanupError as Error).message;
      logger?.error('OpenShell allocation cleanup requires reconciliation', {
        sandboxName: i.name,
        error: cleanupReason,
      });
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
