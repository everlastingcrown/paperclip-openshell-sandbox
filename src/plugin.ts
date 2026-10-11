import { definePlugin } from '@paperclipai/plugin-sdk';
import { parseConfig } from './config.js';
import { OpenShellProvider } from './provider.js';
export function createPlugin(provider = new OpenShellProvider()) {
  return definePlugin({
    async setup() {},
    async onEnvironmentValidateConfig(p) {
      try { if (p.driverKey !== 'openshell') throw new Error('Unsupported driver key'); return { ok: true, normalizedConfig: { ...parseConfig(p.config) } }; }
      catch (error) { return { ok: false, errors: [(error as Error).message] }; }
    },
    onEnvironmentAcquireLease: p => provider.acquire(p),
    onEnvironmentResumeLease: p => provider.resume(p),
    onEnvironmentReleaseLease: p => provider.release(p),
    onEnvironmentDestroyLease: p => provider.destroy(p),
    onEnvironmentStopLease: p => provider.stop(p),
    onEnvironmentRealizeWorkspace: p => provider.realize(p),
    onEnvironmentExecute: p => provider.execute(p),
  });
}
export default createPlugin();
