import { remaining, systemClock, type Clock } from './deadline.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
  // These diagnostics originate before CreateSandbox in the pinned CLI.
  // The provisioning marker is emitted only after allocation succeeds; never
  // interpret a subsequent watch/runtime error as definitive rejection.
  const allocationObserved =
    /Provisioning sandbox \(structured output on stdout\)/i.test(text);
  if (
    /failed to (?:parse sandbox policy YAML|decode sandbox policy fields)|unknown field '[^']*' in authored policy|unsupported policy version|sandbox policy is not valid UTF-8|policy exceeds the \d+-byte input limit/i.test(
      text,
    )
  ) {
    reason =
      'policy YAML is invalid; check the OpenShell v0.1.2 policy schema (version, filesystem_policy, process and network_policies)';
    allocationImpossible = true;
  } else if (
    /failed to (?:inspect|read) sandbox policy|sandbox policy source is not a regular file/i.test(
      text,
    )
  ) {
    reason =
      'policy file cannot be read; use an absolute path accessible to the Paperclip worker';
    allocationImpossible = true;
  } else if (
    /missing required provider|provider '[^']*' not found and no provider profile named|no existing local credentials found for provider profile/i.test(
      text,
    )
  ) {
    reason =
      'credential provider is unavailable; create and authenticate it in the selected OpenShell gateway/workspace before testing';
    allocationImpossible = true;
  } else if (/name exceeds.*maximum length/i.test(text)) {
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
  } else if (
    /status: (?:InvalidArgument|FailedPrecondition)|code: (?:InvalidArgument|FailedPrecondition)/i.test(
      text,
    )
  ) {
    reason =
      'gateway rejected configuration; check OpenShell policy, provider profiles, template and resource requirements in gateway logs';
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
      allocationImpossible &&
      !allocationObserved,
  );
}
export type Runner = (
  executable: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
  env?: { XDG_CONFIG_HOME?: string },
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  signal?: AbortSignal,
) => Promise<CommandResult>;
export function checkStdin(stdin = '') {
  if (typeof stdin !== 'string') throw new Error('Invalid execution stdin');
  if (Buffer.byteLength(stdin) > MAX_STDIN)
    throw new Error('stdin exceeds OpenShell 4 MiB limit');
}
export function createRunner(spawnProcess: typeof spawn = spawn): Runner {
  return async (
    executable,
    args,
    timeoutMs,
    stdin = '',
    overrides = {},
    onOutput,
    cancellationSignal,
  ) => {
    checkStdin(stdin);
    if (cancellationSignal?.aborted)
      throw new OpenShellCommandError('OpenShell command cancelled');
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
      const decoders = {
        stdout: new StringDecoder('utf8'),
        stderr: new StringDecoder('utf8'),
      };
      const emit = (stream: 'stdout' | 'stderr', chunk: string) => {
        if (!chunk) return;
        try {
          onOutput?.(stream, chunk);
        } catch {
          /* logging cannot interrupt execution */
        }
      };
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
      const cancelled = () => terminate();
      cancellationSignal?.addEventListener('abort', cancelled, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      const capture = (
        stream: 'stdout' | 'stderr',
        target: Buffer[],
        chunk: Buffer,
      ) => {
        if (settled || overflow) return;
        size += chunk.length;
        if (size > MAX_OUTPUT) {
          overflow = true;
          terminate();
        } else {
          target.push(chunk);
          // Bound each notification, including when a custom stream supplies a
          // large chunk. Separate decoders preserve split UTF-8 characters.
          if (onOutput)
            for (let offset = 0; offset < chunk.length; offset += 16384)
              emit(
                stream,
                decoders[stream].write(chunk.subarray(offset, offset + 16384)),
              );
        }
      };
      child.stdout.on('data', (chunk) => capture('stdout', out, chunk));
      child.stderr.on('data', (chunk) => capture('stderr', err, chunk));
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
        cancellationSignal?.removeEventListener('abort', cancelled);
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
        if (!settled && onOutput) {
          emit('stdout', decoders.stdout.end());
          emit('stderr', decoders.stderr.end());
        }
        if (cancellationSignal?.aborted)
          finish(new OpenShellCommandError('OpenShell command cancelled'));
        else if (overflow)
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
  signal?: AbortSignal,
): Promise<string> {
  const timeoutMs = remaining(deadline, clock);
  const result = await invoke(
    runner,
    c.executable,
    [...scope(c), 'sandbox', ...args],
    timeoutMs,
    undefined,
    c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
    undefined,
    signal,
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
