import { OpenShellProvider } from '../src/provider.js';
import type { Sandbox } from '../src/identity.js';
import type { PluginEnvironmentLease } from '@paperclipai/plugin-sdk';
import type { Runner, CommandResult } from '../src/cli.js';
import type { SandboxClient } from '../src/sandbox-client.js';
export const config = {
  gateway: 'test',
  image: 'runtime:test',
  timeoutMs: 1000,
};
export const base = {
  driverKey: 'openshell',
  companyId: 'company',
  environmentId: 'environment',
  runId: 'run',
  config,
};
export const ok = (stdout = ''): CommandResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
});
export function fake(
  extra: Record<string, unknown> = {},
  settings?: Record<string, unknown>,
) {
  const calls: {
    args: string[];
    stdin?: string;
    timeout: number;
    env?: { XDG_CONFIG_HOME?: string };
  }[] = [];
  let record: Sandbox | undefined;
  let fail:
    | ((
        args: string[],
      ) => CommandResult | undefined | Promise<CommandResult | undefined>)
    | undefined;
  const runner: Runner = async (_executable, args, timeout, stdin, env) => {
    calls.push({ args, stdin, timeout, env });
    const result = await fail?.(args);
    if (result) return result;
    const flag = (key: string) => args[args.indexOf(key) + 1];
    const operation = args[5];
    if (operation === 'template')
      return ok(
        JSON.stringify({
          id: 'template-id',
          name: args[7],
          workspace: 'default',
        }),
      );
    if (operation === 'create') {
      const labels = Object.fromEntries(
        args.flatMap((a, index) =>
          a === '--label' ? [args[index + 1].split('=')] : [],
        ),
      );
      record = {
        id: 'sandbox-id',
        name: flag('--name'),
        workspace: 'default',
        phase: 'Ready',
        labels,
      };
      return ok(JSON.stringify(record));
    }
    if (operation === 'list')
      return ok(
        JSON.stringify({
          sandboxes: record ? [record] : [],
          next_page_token: '',
        }),
      );
    if (operation === 'delete') record = undefined;
    if (operation === 'stop' && record) record.phase = 'Stopped';
    if (operation === 'start' && record) record.phase = 'Ready';
    return ok();
  };
  const provider = new OpenShellProvider(runner, 1);
  // Fake CLI operations do no real I/O. Advance time only for requested waits,
  // so scheduling delays and wall-clock changes cannot exhaust their budgets.
  let now = 0;
  Object.assign((provider as unknown as { client: SandboxClient }).client, {
    clock: {
      now: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    },
  });
  if (settings) provider.setPluginConfig(async () => settings);
  return {
    settings: settings ?? {},
    provider,
    runner,
    calls,
    params: { ...base, config: { ...config, ...extra } },
    get record() {
      return record;
    },
    set record(v) {
      record = v;
    },
    fail(f: typeof fail) {
      fail = f;
    },
  };
}
export const release = (
  f: ReturnType<typeof fake>,
  l: PluginEnvironmentLease,
) => ({
  ...f.params,
  providerLeaseId: l.providerLeaseId,
  leaseMetadata: l.metadata,
});
