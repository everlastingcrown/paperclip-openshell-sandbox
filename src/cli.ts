import { remaining, systemClock, type Clock } from './deadline.js';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
export const MAX_STDIN = 4 * 1024 * 1024;
export const MAX_OUTPUT = 16 * 1024 * 1024;
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}
export class OpenShellCommandError extends Error {
  constructor(
    message: string,
    readonly allocationImpossible = false,
  ) {
    super(message);
  }
}
// Only recognized diagnostics are forwarded. Arbitrary CLI output can contain
// provider credentials, and must not enter RPC errors or host logs.
export function commandFailure(
  c: Config,
  operation: string,
  result: CommandResult,
) {
  const text = result.stderr
    // eslint-disable-next-line no-control-regex -- strip ANSI before classification
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ');
  let reason = 'check gateway authentication, policy and CLI compatibility';
  let allocationImpossible = false;
  if (/name exceeds.*maximum length/i.test(text)) {
    reason = 'sandbox name exceeds the OpenShell 19-character limit';
    allocationImpossible = true;
  } else if (/Unknown gateway/i.test(text)) {
    reason =
      'gateway is not registered in the worker config directory; check configHome and gateway registration';
    allocationImpossible = true;
  } else if (
    /unexpected argument|unrecognized option|invalid value.*for.*--/i.test(text)
  ) {
    reason =
      'CLI rejected an argument; install OpenShell v0.1.2 and check resource quantities';
    allocationImpossible = true;
  } else if (/HOME is not set/i.test(text)) {
    reason =
      'CLI cannot resolve its config directory; set configHome for the plugin worker';
    allocationImpossible = true;
  } else if (/permission denied|operation not permitted/i.test(text)) {
    reason =
      'permission denied; check worker access to configHome, TLS files and policy files';
  } else if (/certificate|invalid peer|unknown issuer/i.test(text)) {
    reason =
      'TLS verification failed; check gateway hostname and client/CA certificates';
  } else if (
    /connection refused|connect error|dns error|failed to lookup|transport error/i.test(
      text,
    )
  ) {
    reason =
      'gateway connection failed; check DNS, gateway availability and network access';
  } else if (/unauthenticated|unauthorized|authentication/i.test(text)) {
    reason =
      'gateway authentication failed; check the worker gateway credentials';
  }
  return new OpenShellCommandError(
    `OpenShell sandbox ${operation} ${result.timedOut ? 'timed out' : `failed (exit ${result.exitCode ?? 'none'}${result.signal ? `, signal ${result.signal}` : ''})`}; gateway=${c.gateway}, workspace=${c.workspace}, configHome=${c.configHome ?? 'inherited/default'}: ${reason}`,
    operation === 'create' &&
      !result.timedOut &&
      result.signal === null &&
      result.exitCode !== null &&
      allocationImpossible,
  );
}
export type Runner = (
  executable: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
  env?: { XDG_CONFIG_HOME?: string },
) => Promise<CommandResult>;
export function checkStdin(stdin = '') {
  if (typeof stdin !== 'string') throw new Error('Invalid execution stdin');
  if (Buffer.byteLength(stdin) > MAX_STDIN)
    throw new Error('stdin exceeds OpenShell 4 MiB limit');
}
export function createRunner(spawnProcess: typeof spawn = spawn): Runner {
  return async (executable, args, timeoutMs, stdin = '', overrides = {}) => {
    checkStdin(stdin);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('Operation deadline exceeded');
    return new Promise((resolve, reject) => {
      // Endpoint overrides would bypass the explicitly selected gateway scope.
      const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
      delete env.OPENSHELL_GATEWAY_ENDPOINT;
      const child = spawnProcess(executable, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        detached: process.platform !== 'win32',
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let overflow = false;
      let ioFailed = false;
      let settled = false;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* already exited */
        }
      };
      let hard: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        if (settled) return;
        kill('SIGTERM');
        hard ??= setTimeout(() => kill('SIGKILL'), 250);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      const capture = (target: Buffer[], chunk: Buffer) => {
        if (settled || overflow) return;
        size += chunk.length;
        if (size > MAX_OUTPUT) {
          overflow = true;
          terminate();
        } else target.push(chunk);
      };
      child.stdout.on('data', (chunk) => capture(out, chunk));
      child.stderr.on('data', (chunk) => capture(err, chunk));
      const ioFailure = () => {
        ioFailed = true;
        terminate();
      };
      child.stdout.on('error', ioFailure);
      child.stderr.on('error', ioFailure);
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') ioFailure();
      });
      const finish = (error?: Error, result?: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hard) clearTimeout(hard);
        if (error) reject(error);
        else resolve(result!);
      };
      child.once('error', (error: NodeJS.ErrnoException) => {
        const code = /^E[A-Z]+$/.test(error.code ?? '')
          ? error.code
          : 'spawn error';
        finish(
          new OpenShellCommandError(
            `Unable to start OpenShell CLI (${code}); check executable and worker PATH`,
            true,
          ),
        );
      });
      child.once('close', (exitCode, signal) => {
        if (overflow)
          finish(
            new OpenShellCommandError('OpenShell output exceeds 16 MiB limit'),
          );
        else if (ioFailed)
          finish(
            new OpenShellCommandError('OpenShell CLI input/output failed'),
          );
        else
          finish(undefined, {
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
            exitCode,
            signal,
            timedOut,
          });
      });
      child.stdin.end(stdin);
    });
  };
}
export const run: Runner = createRunner();
export function scope(c: Config) {
  return ['--gateway', c.gateway, '--workspace', c.workspace];
}
export async function lifecycle(
  c: Config,
  args: string[],
  deadline: number,
  runner: Runner,
  clock: Clock = systemClock,
): Promise<string> {
  const timeoutMs = remaining(deadline, clock);
  const result = await invoke(
    runner,
    c.executable,
    [...scope(c), 'sandbox', ...args],
    timeoutMs,
    undefined,
    c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
  );
  if (result.timedOut || result.exitCode !== 0)
    throw commandFailure(c, args[0], result);
  return result.stdout;
}
export function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Malformed OpenShell JSON response');
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OpenShell response shape');
  return value as Record<string, unknown>;
}

// Injected runners and platform errors must not forward arbitrary messages.
export async function invoke(
  runner: Runner,
  ...args: Parameters<Runner>
): Promise<CommandResult> {
  try {
    return await runner(...args);
  } catch (error) {
    if (error instanceof OpenShellCommandError) throw error;
    throw new OpenShellCommandError(
      'OpenShell CLI execution failed; check worker access and CLI availability',
    );
  }
}
