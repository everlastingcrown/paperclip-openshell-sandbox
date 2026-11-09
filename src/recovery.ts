import {
  parseMissingSandboxStopRecovery,
  missingSandboxStopRecoverySchema,
} from './missing-sandbox-stop-recovery.js';
import { attemptPattern, isAttemptId, isScopeName } from './validation.js';
import { parseConfig } from './config.js';
export interface CleanupRecovery {
  environmentId: string;
  gateway: string;
  workspace: string;
  configHome?: string;
  rejectedAttemptIds: string[];
}

export function hasSavedConnection(metadata: Record<string, unknown> = {}) {
  return metadata.openshell !== undefined || metadata.gateway !== undefined;
}

// Select one complete historical connection; never combine an edited gateway
// with an old workspace or credential directory. Also used by the recovery UI.
export function cleanupConnection(
  metadata: Record<string, unknown> = {},
  current: Record<string, unknown>,
  recovery?: CleanupRecovery,
) {
  const saved = metadata.openshell;
  if (
    saved !== undefined &&
    (!saved || typeof saved !== 'object' || Array.isArray(saved))
  )
    throw new Error('Invalid saved OpenShell connection');
  const source =
    saved !== undefined
      ? (saved as Record<string, unknown>)
      : metadata.gateway !== undefined
        ? metadata
        : recovery
          ? { ...recovery }
          : current;
  const connection = parseConfig({
    gateway: source.gateway,
    workspace: source.workspace,
    executable: source.executable,
    configHome: source.configHome,
    image: 'cleanup',
  });
  const matching =
    recovery?.gateway === connection.gateway &&
    recovery.workspace === connection.workspace
      ? recovery
      : undefined;
  const c = parseConfig({
    ...connection,
    configHome: matching?.configHome ?? connection.configHome,
  });
  return { c, recovery: matching };
}

export function parseCleanupRecovery(
  config: Record<string, unknown>,
): CleanupRecovery[] {
  parseMissingSandboxStopRecovery(config);
  if (
    config.showRecoveryPage !== undefined &&
    typeof config.showRecoveryPage !== 'boolean'
  )
    throw new Error('Invalid showRecoveryPage (expected a boolean)');
  const entries = config.cleanupRecovery ?? [];
  if (!Array.isArray(entries)) throw new Error('Invalid cleanupRecovery');
  const environments = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid cleanupRecovery entry');
    const value = entry as Record<string, unknown>;
    const { environmentId, gateway } = value;
    const configHome =
      typeof value.configHome === 'string' && !value.configHome.trim()
        ? undefined
        : value.configHome;
    const workspace =
      typeof value.workspace === 'string' && !value.workspace.trim()
        ? 'default'
        : (value.workspace ?? 'default');
    const rejectedAttemptIds = value.rejectedAttemptIds ?? [];
    if (
      typeof environmentId !== 'string' ||
      !environmentId.trim() ||
      environmentId.includes('\0') ||
      environments.has(environmentId) ||
      !isScopeName(gateway) ||
      !isScopeName(workspace) ||
      (configHome !== undefined &&
        (typeof configHome !== 'string' ||
          !configHome.startsWith('/') ||
          configHome.includes('\0'))) ||
      !Array.isArray(rejectedAttemptIds) ||
      rejectedAttemptIds.some((id) => !isAttemptId(id)) ||
      Object.keys(value).some(
        (key) =>
          ![
            'environmentId',
            'gateway',
            'workspace',
            'configHome',
            'rejectedAttemptIds',
          ].includes(key),
      )
    )
      throw new Error(
        'Invalid cleanupRecovery entry (check environment, scope, absolute configHome and attempt UUIDs)',
      );
    environments.add(environmentId);
    return {
      environmentId,
      gateway,
      workspace,
      configHome,
      rejectedAttemptIds,
    };
  });
}

export const recoveryConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    missingSandboxStopRecovery: missingSandboxStopRecoverySchema,
    showRecoveryPage: {
      type: 'boolean',
      title: 'Show OpenShell recovery page',
      default: true,
      description:
        'Show the recovery page and its sidebar link for this company. Turning this off does not affect automatic cleanup or saved recovery entries.',
    },
    cleanupRecovery: {
      type: 'array',
      title: 'Cleanup recovery entries',
      default: [],
      description:
        'Advanced operator recovery. Use the OpenShell recovery page in the sidebar to fill these entries from pending cleanup records. Leave empty for normal operation. Saving settings does not trigger immediate cleanup. Each entry uses the original gateway and workspace and is scoped to the invoking company and environment.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['environmentId', 'gateway'],
        properties: {
          environmentId: {
            type: 'string',
            title: 'Paperclip environment ID',
            minLength: 1,
            description:
              'ID of the environment awaiting cleanup, not its display name or sandbox ID. Add only one recovery entry per environment.',
          },
          gateway: {
            type: 'string',
            title: 'Original OpenShell gateway',
            minLength: 1,
            description:
              'Registered gateway name used for the original allocation.',
          },
          workspace: {
            type: 'string',
            title: 'Original OpenShell workspace',
            default: 'default',
            description:
              'Workspace used for the original allocation. Leave blank to use "default".',
          },
          configHome: {
            type: 'string',
            title: 'Worker configuration directory',
            description:
              'Absolute worker-local XDG_CONFIG_HOME containing the openshell directory used for cleanup. Leave blank to inherit the worker configuration.',
          },
          rejectedAttemptIds: {
            type: 'array',
            title: 'Verified rejected creation attempts',
            default: [],
            description:
              'Leave empty unless the original creation was verified rejected. Add one canonical lowercase attempt UUID per item from the cleanup evidence. A timeout alone is not proof of rejection; successful scoped absence is also required to reconcile.',
            items: { type: 'string', pattern: attemptPattern },
          },
        },
      },
    },
  },
};
