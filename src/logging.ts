import type { PluginLogger } from '@paperclipai/plugin-sdk';

// Logging must never interrupt allocation or teardown. Callers supply only
// provider diagnostics, never command arguments, credentials or raw output.
export function log(
  logger: PluginLogger | undefined,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
) {
  try {
    logger?.[level](message, fields);
  } catch {
    // A disconnected host logger cannot change the resource lifecycle.
  }
}
