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
  ...runtimeConfigSchema,
  required: [],
  anyOf: [{ required: ['profile'] }, { required: ['gateway', 'image'] }],
  properties: {
    ...runtimeProperties,
    profile: { type: 'string', description: 'Named plugin runtime profile' },
    policyPreset: {
      type: 'string',
      description: 'Named plugin policy YAML preset',
    },
  },
};
