import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
import { configSchema } from './config.js';
import { version } from './version.js';
export const pluginId = 'paperclip.openshell-sandbox-provider';
const manifest: PaperclipPluginManifestV1 = {
  id: pluginId, apiVersion: 1, version, displayName: 'OpenShell Sandbox Provider',
  description: 'Host CLI integration for OpenShell v0.1.2', author: 'everlastingcrown',
  categories: ['workspace'], capabilities: ['environment.drivers.register'],
  entrypoints: { worker: './dist/worker.js' },
  environmentDrivers: [{ driverKey: 'openshell', kind: 'sandbox_provider', displayName: 'OpenShell',
    defaultAcquireTimeoutMs: 300000, configSchema,
    sandboxCapabilities: { reusableLeases: true, independentControlCommands: true, nativeSyncIn: false,
      nativeSyncOut: false, persistentProcessSessions: false, incrementalSessionOutput: false },
  }],
};
export default manifest;
