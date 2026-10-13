import { createHash } from 'node:crypto';
import type {
  PluginEnvironmentDriverBaseParams as Base,
  PluginEnvironmentLease,
  PluginEnvironmentCreationCleanup,
} from '@paperclipai/plugin-sdk';
import { remotePath, type Config } from './config.js';
import { object } from './cli.js';
import { pluginId } from './manifest.js';
import { isAttemptId, isText } from './validation.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const fingerprint = (c: Config) =>
  hash(JSON.stringify([c.gateway, c.workspace]));
// OpenShell v0.1.2 MAX_ROUTABLE_NAME_LEN is 19. Keep the full attempt UUID
// in ownership labels; 64 random bits suffice for the short routable name.
export const nameFor = (attempt: string) => `pc-${hash(attempt).slice(0, 16)}`;
export const legacyName = (attempt: string) => `paperclip-${attempt}`;
export const labelsFor = (p: Base, attempt: string) => ({
  'paperclip-provider': 'openshell',
  'paperclip-company': hash(p.companyId).slice(0, 32),
  'paperclip-environment': hash(p.environmentId).slice(0, 32),
  'paperclip-attempt': attempt,
});
export interface Identity {
  name: string;
  id?: string;
  gateway: string;
  workspace: string;
  labels: Record<string, string>;
  remotePath: string;
  reuseLease: boolean;
  executable?: string;
  configHome?: string;
}
export interface Sandbox {
  id: string;
  name: string;
  workspace: string;
  phase: string;
  labels: Record<string, string>;
}
function stringLabels(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, value]) => {
      if (typeof value !== 'string')
        throw new Error('Invalid sandbox labels shape');
      return [key, value];
    }),
  );
}
export function sandbox(value: unknown): Sandbox {
  const v = object(value);
  const { id, name, workspace, phase } = v;
  if (!isText(id) || !isText(name) || !isText(workspace) || !isText(phase))
    throw new Error('Invalid sandbox JSON shape');
  return {
    id,
    name,
    workspace,
    phase,
    labels: stringLabels(v.labels),
  };
}
export function identity(
  p: Base,
  id: string | null,
  metadata: Record<string, unknown> | undefined,
  c: Config,
): Identity {
  if (!isText(id)) throw new Error('Missing provider lease ID');
  const m = object(metadata?.openshell);
  const labels = stringLabels(m.labels);
  const attempt = labels['paperclip-attempt'];
  if (
    !isAttemptId(attempt) ||
    m.pluginId !== pluginId ||
    m.id !== id ||
    typeof m.name !== 'string' ||
    ![nameFor(attempt), legacyName(attempt)].includes(m.name) ||
    m.gateway !== c.gateway ||
    m.workspace !== c.workspace ||
    m.remotePath !== remotePath ||
    typeof m.reuseLease !== 'boolean' ||
    Object.entries(labelsFor(p, attempt)).some(([k, v]) => labels[k] !== v)
  )
    throw new Error('Lease ownership or scope mismatch');
  return {
    id,
    name: m.name,
    gateway: c.gateway,
    workspace: c.workspace,
    remotePath,
    reuseLease: m.reuseLease,
    labels,
    ...(m.executable !== undefined ? { executable: c.executable } : {}),
    ...(m.configHome !== undefined ? { configHome: c.configHome } : {}),
  };
}
export function cleanupIdentity(
  p: Base,
  providerLeaseId: string | null,
  value: unknown,
  c: Config,
): { identity: Identity; cleanup: PluginEnvironmentCreationCleanup } {
  const f = object(value);
  const labels = stringLabels(f.labels);
  const { attemptId, observedProviderLeaseId, runId } = f;
  if (
    !isText(providerLeaseId) ||
    f.providerLeaseId !== providerLeaseId ||
    f.companyId !== p.companyId ||
    f.environmentId !== p.environmentId ||
    f.accountFingerprint !== fingerprint(c) ||
    !isAttemptId(attemptId) ||
    ![nameFor(attemptId), legacyName(attemptId)].includes(providerLeaseId) ||
    Object.entries(labelsFor(p, attemptId)).some(([k, v]) => labels[k] !== v) ||
    (observedProviderLeaseId !== undefined &&
      !isText(observedProviderLeaseId)) ||
    (runId !== undefined && typeof runId !== 'string')
  )
    throw new Error('Failed creation ownership mismatch');
  const id = observedProviderLeaseId;
  return {
    identity: {
      name: providerLeaseId,
      id,
      gateway: c.gateway,
      workspace: c.workspace,
      labels,
      remotePath,
      reuseLease: false,
    },
    cleanup: {
      providerLeaseId,
      companyId: p.companyId,
      environmentId: p.environmentId,
      ...(runId !== undefined ? { runId } : {}),
      attemptId,
      accountFingerprint: fingerprint(c),
      labels,
      ...(id ? { observedProviderLeaseId: id } : {}),
    },
  };
}
export function lease(i: Identity): PluginEnvironmentLease {
  if (!isText(i.id)) throw new Error('Missing observed sandbox ID');
  return {
    providerLeaseId: i.id,
    metadata: {
      remoteCwd: i.remotePath,
      shellCommand: 'bash',
      openshell: { ...i, pluginId },
    },
    expiresAt: null,
  };
}
export function verify(s: Sandbox, i: Identity) {
  if (
    (i.id && s.id !== i.id) ||
    s.name !== i.name ||
    s.workspace !== i.workspace ||
    Object.entries(i.labels).some(([k, v]) => s.labels[k] !== v)
  )
    throw new Error('Sandbox ownership mismatch');
}
