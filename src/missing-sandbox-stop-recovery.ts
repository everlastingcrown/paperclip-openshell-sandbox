import { attemptPattern, isAttemptId, isText } from './validation.js';

// Temporary compatibility workaround for Paperclip's stopped-only recovery gate.
// Remove this module, its schema property and the stop catch branch together.
export interface MissingSandboxStopRecovery {
  environmentId: string;
  providerLeaseId: string;
  attemptId: string;
}

export function parseMissingSandboxStopRecovery(
  config: Record<string, unknown>,
): MissingSandboxStopRecovery[] {
  const entries = config.missingSandboxStopRecovery;
  if (entries === undefined) return [];
  const invalid = () => new Error('Invalid missingSandboxStopRecovery');
  if (!Array.isArray(entries)) throw invalid();
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw invalid();
    const { environmentId, providerLeaseId, attemptId } = entry;
    if (
      !isText(environmentId) ||
      !isText(providerLeaseId) ||
      !isAttemptId(attemptId) ||
      Object.keys(entry).some(
        (key) =>
          !['environmentId', 'providerLeaseId', 'attemptId'].includes(key),
      )
    )
      throw invalid();
    const key = JSON.stringify([environmentId, providerLeaseId, attemptId]);
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return { environmentId, providerLeaseId, attemptId };
  });
}

export const missingSandboxStopRecoverySchema = {
  type: 'array',
  title: 'Advanced: accept missing sandboxes as stopped',
  default: [],
  description:
    'Temporary recovery override for exact leases in this company. A successful complete lookup must confirm absence. Adding an entry acknowledges that workspace files are unavailable and permits reporting the missing allocation as stopped. Later workspace recovery may still fail. Remove entries to disable. Saving does not trigger cleanup.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['environmentId', 'providerLeaseId', 'attemptId'],
    properties: {
      environmentId: {
        type: 'string',
        title: 'Paperclip environment ID',
        minLength: 1,
      },
      providerLeaseId: {
        type: 'string',
        title: 'Exact OpenShell allocation ID',
        minLength: 1,
      },
      attemptId: {
        type: 'string',
        title: 'Saved creation attempt UUID',
        pattern: attemptPattern,
      },
    },
  },
};
