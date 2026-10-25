import { log } from './logging.js';
import {
  definePlugin,
  type PluginLogger,
  type PluginEnvironmentDriverBaseParams,
} from '@paperclipai/plugin-sdk';
import { parseConfig } from './config.js';
import { OpenShellProvider } from './provider.js';
import { parseCleanupRecovery } from './recovery.js';
export function createPlugin(provider = new OpenShellProvider()) {
  let logger: PluginLogger | undefined;
  let onOutput: Parameters<OpenShellProvider['execute']>[1];
  const control = async <T>(
    operation: string,
    p: PluginEnvironmentDriverBaseParams,
    action: () => Promise<T>,
  ) => {
    const fields = {
      operation,
      companyId: p.companyId,
      environmentId: p.environmentId,
    };
    const started = Date.now();
    log(logger, 'info', 'OpenShell operation started', fields);
    try {
      const result = await action();
      log(logger, 'info', 'OpenShell operation completed', {
        ...fields,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      log(logger, 'error', 'OpenShell operation failed', {
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
      provider.duplex.notifications = ctx.duplexChannel;
      onOutput = (stream, chunk) => ctx.execution.log(stream, chunk);
      provider.setPluginConfig((companyId) => ctx.config.get(companyId));
      provider.setLogger(ctx.logger);
      ctx.data.register('recovery-page-settings', async (params) => {
        const companyId =
          typeof params.companyId === 'string' ? params.companyId : undefined;
        if (!companyId) return { showRecoveryPage: false };
        const config = await ctx.config.get(companyId);
        return { showRecoveryPage: config.showRecoveryPage !== false };
      });
    },
    onShutdown: () => provider.shutdown(),
    onDuplexChannelOpen: (p) => provider.duplex.open(p),
    onDuplexChannelWrite: (p) => provider.duplex.write(p),
    onDuplexChannelStop: (p) => provider.duplex.stop(p),
    onDuplexChannelClose: (p) => provider.duplex.close(p),
    async onValidateConfig(config) {
      try {
        parseCleanupRecovery(config);
        return { ok: true };
      } catch (error) {
        return { ok: false, errors: [(error as Error).message] };
      }
    },
    async onEnvironmentValidateConfig(p) {
      try {
        if (p.driverKey !== 'openshell')
          throw new Error('Unsupported driver key');
        parseConfig(p.config);
        return { ok: true, normalizedConfig: p.config };
      } catch (error) {
        return { ok: false, errors: [(error as Error).message] };
      }
    },
    onEnvironmentProbe: (p) => control('probe', p, () => provider.probe(p)),
    onEnvironmentAcquireLease: (p) =>
      control('acquire', p, () => provider.acquire(p)),
    onEnvironmentResumeLease: (p) =>
      control('resume', p, () => provider.resume(p)),
    onEnvironmentReleaseLease: (p) =>
      control('release', p, () => provider.release(p)),
    onEnvironmentDestroyLease: (p) =>
      control('destroy', p, () => provider.destroy(p)),
    onEnvironmentStopLease: (p) => control('stop', p, () => provider.stop(p)),
    onEnvironmentRealizeWorkspace: (p) =>
      control('realize', p, () => provider.realize(p)),
    onEnvironmentExecute: (p) => provider.execute(p, onOutput),
  });
}
export default createPlugin();
