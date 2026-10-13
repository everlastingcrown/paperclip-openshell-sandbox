import {
  parseRuntimeConfig,
  runtimeConfigSchema,
  type Config,
} from './runtime-config.js';
import { resolvePreset } from './presets.js';
export {
  remotePath,
  runtimeTools,
  validateRuntimeImage,
  parseRuntimeConfig,
} from './runtime-config.js';
export type { Config } from './runtime-config.js';
export function parseConfig(
  raw: Record<string, unknown>,
  pluginConfig: Record<string, unknown> = {},
): Config {
  return parseRuntimeConfig(resolvePreset(raw, pluginConfig));
}

const { oneOf: _sourceChoice, ...environmentSchema } = runtimeConfigSchema;
void _sourceChoice;
const runtimeProperties = Object.fromEntries(
  Object.entries(runtimeConfigSchema.properties)
    .filter(([key]) => key !== 'policy' && key !== 'policyFile')
    .map(([key, value]) => {
      const { default: _default, ...schema } = value as Record<string, unknown>;
      void _default;
      return [key, schema];
    }),
);
export const configSchema = {
  ...environmentSchema,
  required: [],
  properties: {
    ...runtimeProperties,
    provider: { type: 'string', const: 'openshell' },
    archiveOnRelease: {
      type: 'boolean',
      description:
        'Paperclip probe flag; OpenShell uses ordinary release cleanup',
    },
    profile: { type: 'string', description: 'Named plugin runtime profile' },
    policyPreset: {
      type: 'string',
      description: 'Named plugin policy YAML preset',
    },
  },
};
