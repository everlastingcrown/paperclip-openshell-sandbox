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
export type Runner = (
  executable: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
  env?: { XDG_CONFIG_HOME?: string },
) => Promise<CommandResult>;
export function checkStdin(stdin = '') {
  if (Buffer.byteLength(stdin) > MAX_STDIN)
    throw new Error('stdin exceeds OpenShell 4 MiB limit');
}
export const run: Runner = async (
  executable,
  args,
  timeoutMs,
  stdin = '',
  overrides = {},
) => {
  checkStdin(stdin);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Operation deadline exceeded');
  return new Promise((resolve, reject) => {
    // Endpoint overrides would bypass the explicitly selected gateway scope.
    const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    delete env.OPENSHELL_GATEWAY_ENDPOINT;
    const child = spawn(executable, args, {
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
      kill('SIGTERM');
      hard ??= setTimeout(() => kill('SIGKILL'), 250);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        overflow = true;
        terminate();
      } else target.push(chunk);
    };
    child.stdout.on('data', (chunk) => capture(out, chunk));
    child.stderr.on('data', (chunk) => capture(err, chunk));
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') terminate();
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      reject(new Error('Unable to start OpenShell CLI'));
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      if (overflow) reject(new Error('OpenShell output exceeds 16 MiB limit'));
      else
        resolve({
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
export function scope(c: Config) {
  return ['--gateway', c.gateway, '--workspace', c.workspace];
}
export async function lifecycle(
  c: Config,
  args: string[],
  deadline: number,
  runner: Runner,
): Promise<string> {
  const result = await runner(
    c.executable,
    [...scope(c), 'sandbox', ...args],
    deadline - Date.now(),
    undefined,
    c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
  );
  if (result.timedOut || result.exitCode !== 0)
    throw new Error(
      result.timedOut
        ? 'OpenShell operation timed out'
        : 'OpenShell lifecycle command failed (check host authentication and gateway)',
    );
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
