export interface CleanupRecovery {
  environmentId: string;
  gateway: string;
  workspace: string;
  configHome?: string;
  rejectedAttemptIds: string[];
}

const attemptPattern =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

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
    const { environmentId, gateway, configHome } = value;
    const workspace = value.workspace ?? 'default';
    const rejectedAttemptIds = value.rejectedAttemptIds ?? [];
    if (
      typeof environmentId !== 'string' ||
      !environmentId.trim() ||
      environmentId.includes('\0') ||
      environments.has(environmentId) ||
      typeof gateway !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(gateway) ||
      typeof workspace !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(workspace) ||
      (configHome !== undefined &&
        (typeof configHome !== 'string' ||
          !configHome.startsWith('/') ||
          configHome.includes('\0'))) ||
      !Array.isArray(rejectedAttemptIds) ||
      rejectedAttemptIds.some(
        (id) => typeof id !== 'string' || !new RegExp(attemptPattern).test(id),
      ) ||
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
      default: [],
      description:
        'Operator recovery for pending cleanup; scoped to the invoking company and environment',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['environmentId', 'gateway'],
        properties: {
          environmentId: { type: 'string', minLength: 1 },
          gateway: { type: 'string', minLength: 1 },
          workspace: { type: 'string', default: 'default' },
          configHome: {
            type: 'string',
            description: 'Absolute XDG config directory used for cleanup only',
          },
          rejectedAttemptIds: {
            type: 'array',
            default: [],
            description:
              'Attempt UUIDs whose original creation was verified rejected; successful scoped absence is required to reconcile',
            items: { type: 'string', pattern: attemptPattern },
          },
        },
      },
    },
  },
};
