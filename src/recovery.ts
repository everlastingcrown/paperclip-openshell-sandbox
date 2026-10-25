import { attemptPattern, isAttemptId, isScopeName } from './validation.js';
export interface CleanupRecovery {
  environmentId: string;
  gateway: string;
  workspace: string;
  configHome?: string;
  rejectedAttemptIds: string[];
}

export function parseCleanupRecovery(
  config: Record<string, unknown>,
): CleanupRecovery[] {
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
