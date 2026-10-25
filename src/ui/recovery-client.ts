import type { Environment, EnvironmentLease } from '@paperclipai/shared';
import { pluginId } from '../plugin-id.js';
import { parseCleanupRecovery, type CleanupRecovery } from '../recovery.js';
import { isAttemptId } from '../validation.js';

export type PendingRecovery = {
  environment: Environment;
  lease: EnvironmentLease;
};
export type RecoverySnapshot = {
  pending: PendingRecovery[];
  config: Record<string, unknown>;
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isOurLease(
  lease: EnvironmentLease,
  companyId: string,
): boolean {
  const metadata = record(lease.metadata);
  const owner = metadata.pluginKey ?? record(metadata.openshell).pluginId;
  return (
    lease.companyId === companyId &&
    lease.provider === 'openshell' &&
    owner === pluginId
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function recoveryDraft(
  pending: PendingRecovery,
  config: Record<string, unknown>,
): CleanupRecovery {
  const { environment, lease } = pending;
  const metadata = record(lease.metadata);
  const saved = record(metadata.openshell);
  const existing = parseCleanupRecovery(config).find(
    (entry) => entry.environmentId === environment.id,
  );
  // Match cleanupConfig's immutable lease scope before considering fallback config.
  const source = saved.gateway
    ? saved
    : metadata.gateway
      ? metadata
      : environment.config;
  const gateway =
    text(source.gateway) ||
    text(environment.config.gateway) ||
    existing?.gateway ||
    '';
  const workspace = source.gateway
    ? text(source.workspace) || 'default'
    : existing?.workspace || 'default';
  const matching =
    existing?.gateway === gateway && existing.workspace === workspace
      ? existing
      : undefined;
  return {
    environmentId: environment.id,
    gateway,
    workspace,
    configHome: matching?.configHome ?? (text(source.configHome) || undefined),
    rejectedAttemptIds: matching?.rejectedAttemptIds ?? [],
  };
}

export function creationAttempt(pending: PendingRecovery): string | undefined {
  const cleanup = record(pending.lease.metadata?.failedCreateCleanup);
  return cleanup.companyId === pending.lease.companyId &&
    cleanup.environmentId === pending.environment.id &&
    cleanup.providerLeaseId === pending.lease.providerLeaseId &&
    isAttemptId(cleanup.attemptId)
    ? cleanup.attemptId
    : undefined;
}

export function mergeRecovery(
  config: Record<string, unknown>,
  draft: CleanupRecovery,
  rejectedAttempt?: string,
): Record<string, unknown> {
  const entries = parseCleanupRecovery(config);
  const previous = entries.find(
    (entry) => entry.environmentId === draft.environmentId,
  );
  if (
    previous &&
    (previous.gateway !== draft.gateway ||
      previous.workspace !== draft.workspace)
  ) {
    throw new Error(
      'This environment already has recovery settings for a different gateway or workspace. Review its entries in plugin settings first.',
    );
  }
  const rejectedAttemptIds = [
    ...new Set([
      ...(previous?.rejectedAttemptIds ?? []),
      ...(rejectedAttempt ? [rejectedAttempt] : []),
    ]),
  ];
  const entry = { ...draft, rejectedAttemptIds };
  const next = {
    ...config,
    cleanupRecovery: [
      ...entries.filter((value) => value.environmentId !== draft.environmentId),
      entry,
    ],
  };
  parseCleanupRecovery(next);
  return next;
}

export class RecoveryClient {
  // Window.fetch must be called with the browser global as its receiver,
  // rather than as a method of this client.
  constructor(
    private readonly request: typeof fetch = (...args) =>
      globalThis.fetch(...args),
  ) {}

  private async api<T>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(`/api${path}`, {
      credentials: 'include',
      signal,
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      // Host errors may contain provider diagnostics. Only display fixed messages.
      if (response.status === 401)
        throw new Error('Sign in to Paperclip, then refresh this page.');
      if (response.status === 403)
        throw new Error(
          body === undefined
            ? 'You do not have access to these recovery records. Ask an instance administrator for help.'
            : 'Saving recovery settings requires an instance administrator and access to this company. Plugin management must also be enabled.',
        );
      throw new Error(
        `Paperclip could not ${body === undefined ? 'load recovery information' : 'save recovery settings'} (HTTP ${response.status}). Refresh and try again.`,
      );
    }
    return response.json() as Promise<T>;
  }

  private async config(
    companyId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.api<{
      configJson: Record<string, unknown>;
    } | null>(
      `/plugins/${pluginId}/config?companyId=${encodeURIComponent(companyId)}`,
      signal,
    );
    return record(result?.configJson);
  }

  async load(
    companyId: string,
    signal: AbortSignal,
  ): Promise<RecoverySnapshot> {
    const [environments, config] = await Promise.all([
      this.api<Environment[]>(
        `/companies/${encodeURIComponent(companyId)}/environments`,
        signal,
      ),
      this.config(companyId, signal),
    ]);
    const pending: PendingRecovery[] = [];
    // Environments are instance-scoped; check all of them for historical leases,
    // then restrict the results to this company and provider. Bound fan-out.
    for (let i = 0; i < environments.length; i += 4) {
      const batches = await Promise.all(
        environments.slice(i, i + 4).map(async (environment) => {
          const leases = await this.api<EnvironmentLease[]>(
            `/environments/${encodeURIComponent(environment.id)}/leases?status=pending_cleanup`,
            signal,
          );
          return leases
            .filter(
              (lease) =>
                lease.environmentId === environment.id &&
                lease.status === 'pending_cleanup' &&
                isOurLease(lease, companyId),
            )
            .map((lease) => ({ environment, lease }));
        }),
      );
      pending.push(...batches.flat());
    }
    return { pending, config };
  }

  async save(
    companyId: string,
    pending: PendingRecovery,
    draft: CleanupRecovery,
    signal: AbortSignal,
    rejectedAttempt?: string,
  ): Promise<void> {
    // Re-read the host records. The browser never invokes provider cleanup or
    // updates a lease, and a completed/foreign lease must not seed new recovery.
    const lease = await this.api<EnvironmentLease>(
      `/environment-leases/${encodeURIComponent(pending.lease.id)}`,
      signal,
    );
    if (
      lease.id !== pending.lease.id ||
      lease.environmentId !== pending.environment.id ||
      lease.providerLeaseId !== pending.lease.providerLeaseId ||
      lease.status !== 'pending_cleanup' ||
      !isOurLease(lease, companyId)
    ) {
      throw new Error(
        'This cleanup record has changed or is no longer pending. Refresh before saving.',
      );
    }
    if (
      draft.environmentId !== pending.environment.id ||
      (rejectedAttempt &&
        creationAttempt({ ...pending, lease }) !== rejectedAttempt)
    ) {
      throw new Error(
        'The creation attempt has changed. Refresh before saving.',
      );
    }
    const config = await this.config(companyId, signal);
    const current = recoveryDraft({ ...pending, lease }, config);
    if (
      current.gateway &&
      (current.gateway !== draft.gateway ||
        current.workspace !== draft.workspace)
    ) {
      throw new Error(
        'The saved connection details have changed. Refresh before saving.',
      );
    }
    const configJson = mergeRecovery(config, draft, rejectedAttempt);
    await this.api(`/plugins/${pluginId}/config`, signal, {
      companyId,
      configJson,
    });
  }
}
