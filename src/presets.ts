import { parseRuntimeConfig, runtimeConfigSchema } from './runtime-config.js';
import { parseCleanupRecovery, recoveryConfigSchema } from './recovery.js';

const presetPattern = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
const namePattern = new RegExp(presetPattern);
const runtimeKeys = [
  'executable',
  'configHome',
  'gateway',
  'workspace',
  'image',
  'template',
  'providers',
  'cpu',
  'memory',
  'timeoutMs',
  'reuseLease',
];
const profileKeys = [...runtimeKeys, 'policyPreset', 'policyFile'];
const environmentKeys = [...runtimeKeys, 'policyPreset', 'profile'];
const hostFields = [
  'driver',
  'pluginId',
  'pluginKey',
  'failedCreateCleanup',
  'sandboxProviderPlugin',
  'pendingCleanupAttemptId',
];

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${field} (expected object)`);
  return value as Record<string, unknown>;
}
function reference(value: unknown, field: string): string | undefined {
  if (value === undefined || (typeof value === 'string' && !value.trim()))
    return undefined;
  if (typeof value !== 'string' || !namePattern.test(value))
    throw new Error(`Invalid ${field} name`);
  return value;
}
function explicit(raw: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key, value]) =>
        value !== undefined &&
        !(
          typeof value === 'string' &&
          !value.trim() &&
          [
            'configHome',
            'cpu',
            'memory',
            'profile',
            'policyPreset',
            'policyFile',
            'template',
          ].includes(key)
        ),
    ),
  );
}
export interface PluginSettings {
  defaults?: Record<string, unknown>;
  policies: Record<string, string>;
  profiles: Record<string, Record<string, unknown>>;
}
export function parsePluginConfig(
  raw: Record<string, unknown>,
): PluginSettings {
  if (
    Object.keys(raw).some(
      (key) =>
        !['defaults', 'policies', 'profiles', 'cleanupRecovery'].includes(key),
    )
  )
    throw new Error('Unknown plugin configuration field');
  parseCleanupRecovery(raw);
  const policies = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(
    record(raw.policies === undefined ? {} : raw.policies, 'policies'),
  )) {
    if (!namePattern.test(name)) throw new Error('Invalid policy preset name');
    if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
      throw new Error('Invalid policy preset YAML (expected nonempty text)');
    policies[name] = value;
  }
  const validateDefaults = (value: unknown, field: string) => {
    const profile = record(value, field);
    if (Object.keys(profile).some((key) => !profileKeys.includes(key)))
      throw new Error(`Invalid ${field} field`);
    const policy = reference(profile.policyPreset, 'policyPreset');
    if (policy && !Object.hasOwn(policies, policy))
      throw new Error('Unknown policyPreset in profile/defaults');
    if (policy && profile.policyFile)
      throw new Error('Supply only one of policyPreset or policyFile');
    parseRuntimeConfig({
      gateway: 'validation',
      ...(profile.template ? {} : { image: 'validation' }),
      ...profile,
    });
    return explicit(profile);
  };
  const defaults = validateDefaults(
    raw.defaults === undefined ? {} : raw.defaults,
    'defaults',
  );
  const profiles = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [name, value] of Object.entries(
    record(raw.profiles === undefined ? {} : raw.profiles, 'profiles'),
  )) {
    if (!namePattern.test(name)) throw new Error('Invalid profile name');
    profiles[name] = validateDefaults(value, 'profile');
  }
  return { defaults, policies, profiles };
}

function environmentInput(raw: Record<string, unknown>, control = false) {
  const { policy, policyFile, provider, archiveOnRelease, ...environment } =
    raw;
  // Paperclip stores the sandbox provider selector alongside runtime settings.
  if (provider !== undefined && provider !== 'openshell')
    throw new Error('Invalid environment provider (expected "openshell")');
  // Paperclip injects this probe flag; providers without archive support
  // delete as usual, per the shared SandboxEnvironmentConfig contract.
  if (archiveOnRelease !== undefined && typeof archiveOnRelease !== 'boolean')
    throw new Error('Invalid archiveOnRelease (expected boolean)');
  if (
    !control &&
    [policy, policyFile].some(
      (value) =>
        value !== undefined && !(typeof value === 'string' && !value.trim()),
    )
  )
    throw new Error(
      'Move policy/policyFile to plugin settings: use policies with policyPreset, or defaults.policyFile',
    );
  for (const key of hostFields) delete environment[key];
  const unknown = Object.keys(environment).filter(
    (key) => !environmentKeys.includes(key),
  );
  if (unknown.length)
    throw new Error(
      `Unknown environment configuration field${unknown.length === 1 ? '' : 's'}: ${unknown.map((key) => JSON.stringify(key)).join(', ')}`,
    );
  const profileName = reference(environment.profile, 'profile');
  return { environment, profileName };
}

// Save validation has no company context in the pinned SDK. Validate explicit
// fields here; resolve references only in company-scoped provider operations.
export function validateEnvironmentConfig(raw: Record<string, unknown>) {
  const { environment } = environmentInput(raw);
  reference(environment.policyPreset, 'policyPreset');
  const runtime = Object.fromEntries(
    Object.entries(explicit(environment)).filter(([key]) =>
      runtimeKeys.includes(key),
    ),
  );
  return parseRuntimeConfig({
    // Company defaults are unavailable at save time in the pinned SDK.
    gateway: 'validation',
    ...(runtime.template ? {} : { image: 'validation' }),
    ...runtime,
  });
}

export function resolvePreset(
  raw: Record<string, unknown>,
  pluginConfig: Record<string, unknown>,
  control = false,
): Record<string, unknown> {
  const { environment, profileName } = environmentInput(raw, control);
  // Control operations must remain available after a policy is removed or changed.
  const settings = control
    ? {
        defaults: record(pluginConfig.defaults ?? {}, 'defaults'),
        policies: {} as Record<string, string>,
        profiles: record(
          pluginConfig.profiles === undefined ? {} : pluginConfig.profiles,
          'profiles',
        ),
      }
    : parsePluginConfig(pluginConfig);
  let profile: Record<string, unknown> = {};
  if (profileName) {
    if (!Object.hasOwn(settings.profiles, profileName)) {
      if (!control) throw new Error('Unknown profile');
    } else profile = record(settings.profiles[profileName], 'profile');
    if (Object.keys(profile).some((key) => !profileKeys.includes(key)))
      throw new Error('Invalid profile field');
  }
  const merged = mergeSettings(settings.defaults ?? {}, profile, environment);
  const policyName = control
    ? undefined
    : reference(merged.policyPreset, 'policyPreset');
  if (policyName && !Object.hasOwn(settings.policies, policyName))
    throw new Error('Unknown policyPreset');
  const runtime = Object.fromEntries(
    Object.entries(merged).filter(
      ([key]) =>
        [...runtimeKeys, 'policyFile'].includes(key) &&
        !(control && key === 'policyFile'),
    ),
  );
  return {
    ...runtime,
    ...(policyName ? { policy: settings.policies[policyName] } : {}),
  };
}

function mergeSettings(...layers: Record<string, unknown>[]) {
  const merged: Record<string, unknown> = {};
  for (const raw of layers) {
    const layer = explicit(raw);
    if (layer.template)
      for (const key of ['image', 'cpu', 'memory']) delete merged[key];
    if (layer.image) delete merged.template;
    if (layer.policyPreset) delete merged.policyFile;
    if (layer.policyFile) delete merged.policyPreset;
    Object.assign(merged, layer);
  }
  return merged;
}

export function normalizedEnvironment(raw: Record<string, unknown>) {
  const { policy: _policy, policyFile: _policyFile, ...environment } = raw;
  // Legacy blank fields are omitted rather than persisted as unsupported inputs.
  void [_policy, _policyFile];
  for (const key of hostFields) delete environment[key];
  return explicit(environment);
}

export function pluginConfigSchema() {
  const properties = Object.fromEntries(
    Object.entries(runtimeConfigSchema.properties)
      .filter(([key]) => [...runtimeKeys, 'policyFile'].includes(key))
      .map(([key, value]) => {
        // Defaults belong to resolution, not saved profile/environment overrides.
        const { default: _default, ...schema } = value as Record<
          string,
          unknown
        >;
        void _default;
        return [key, schema];
      }),
  );
  return {
    ...recoveryConfigSchema,
    properties: {
      ...recoveryConfigSchema.properties,
      defaults: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...properties,
          policyPreset: { type: 'string', pattern: presetPattern },
        },
        description:
          'Shared worker connection and runtime settings; environments can use an empty configuration',
      },
      policies: {
        type: 'object',
        propertyNames: { pattern: presetPattern },
        additionalProperties: { type: 'string', minLength: 1 },
        description: 'Named complete OpenShell policy YAML documents',
      },
      profiles: {
        type: 'object',
        propertyNames: { pattern: presetPattern },
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...properties,
            policyPreset: { type: 'string', pattern: presetPattern },
          },
        },
        description:
          'Named runtime defaults; environments may override individual settings',
      },
    },
  };
}
