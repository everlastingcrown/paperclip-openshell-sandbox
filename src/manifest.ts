import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
import { configSchema } from './config.js';
import { version } from './version.js';
import { recoveryConfigSchema } from './recovery.js';
import { pluginId } from './plugin-id.js';
export { pluginId } from './plugin-id.js';
const manifest: PaperclipPluginManifestV1 = {
  id: pluginId,
  apiVersion: 1,
  version,
  displayName: 'OpenShell Sandbox Provider',
  description: 'Host CLI integration for OpenShell v0.1.2',
  author: 'everlastingcrown',
  categories: ['workspace'],
  capabilities: [
    'environment.drivers.register',
    'ui.page.register',
    'ui.sidebar.register',
  ],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  ui: {
    slots: [
      {
        type: 'page',
        id: 'cleanup',
        displayName: 'OpenShell recovery',
        exportName: 'RecoveryPage',
        routePath: 'openshell-recovery',
      },
      {
        type: 'sidebar',
        id: 'cleanup-link',
        displayName: 'OpenShell recovery',
        exportName: 'RecoveryLink',
      },
    ],
  },
  instanceConfigSchema: recoveryConfigSchema,
  environmentDrivers: [
    {
      driverKey: 'openshell',
      kind: 'sandbox_provider',
      displayName: 'OpenShell',
      defaultAcquireTimeoutMs: 300000,
      configSchema,
      sandboxCapabilities: {
        reusableLeases: true,
        duplexCommandStream: true,
        independentControlCommands: true,
        nativeSyncIn: false,
        nativeSyncOut: false,
        persistentProcessSessions: false,
        incrementalSessionOutput: false,
      },
    },
  ],
};
export default manifest;
