import {
  definePlugin,
  type PluginLogger,
  type PluginEnvironmentDriverBaseParams,
} from '@paperclipai/plugin-sdk';
import { parseConfig, validateRuntimeImage } from './config.js';
import { OpenShellProvider } from './provider.js';
export function createPlugin(provider = new OpenShellProvider()) {
  let logger: PluginLogger | undefined;
  const control = async <T>(
    operation: string,
    p: PluginEnvironmentDriverBaseParams,
    action: () => Promise<T>,
  ) => {
    try {
      return await action();
    } catch (error) {
      logger?.error('OpenShell control failed', {
        operation,
        companyId: p.companyId,
        environmentId: p.environmentId,
        error: (error as Error).message,
      });
      throw error;
    }
  };
  return definePlugin({
    async setup(ctx) {
      logger = ctx.logger;
      provider.setLogger(ctx.logger);
    },
    async onEnvironmentValidateConfig(p) {
      try {
        if (p.driverKey !== 'openshell')
          throw new Error('Unsupported driver key');
        const config = parseConfig(p.config);
        validateRuntimeImage(config);
        return { ok: true, normalizedConfig: { ...config } };
      } catch (error) {
        return { ok: false, errors: [(error as Error).message] };
      }
    },
    onEnvironmentProbe: (p) => provider.probe(p),
    onEnvironmentAcquireLease: (p) => provider.acquire(p),
    onEnvironmentResumeLease: (p) => provider.resume(p),
    onEnvironmentReleaseLease: (p) =>
      control('release', p, () => provider.release(p)),
    onEnvironmentDestroyLease: (p) =>
      control('destroy', p, () => provider.destroy(p)),
    onEnvironmentStopLease: (p) => control('stop', p, () => provider.stop(p)),
    onEnvironmentRealizeWorkspace: (p) => provider.realize(p),
    onEnvironmentExecute: (p) => provider.execute(p),
  });
}
export default createPlugin();
