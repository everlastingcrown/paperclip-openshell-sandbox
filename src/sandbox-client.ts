import type { PluginLogger } from '@paperclipai/plugin-sdk';
import { log } from './logging.js';
import {
  OpenShellCommandError,
  lifecycle,
  invoke,
  json,
  object,
  scope,
  checkStdin,
  type Runner,
} from './cli.js';
import type { Config } from './config.js';
import { sandbox, verify, type Sandbox, type Identity } from './identity.js';
import { OperationDeadlineError, systemClock, type Clock } from './deadline.js';
export class SandboxClient {
  logger?: PluginLogger;
  private readonly inspections = new Map<
    string,
    { deadline: number; result: Promise<Sandbox | null> }
  >();
  constructor(
    private readonly runner: Runner,
    private readonly pollMs = 500,
    readonly clock: Clock = systemClock,
  ) {}
  async command(
    c: Config,
    args: string[],
    deadline: number,
    signal?: AbortSignal,
  ) {
    const started = this.clock.now();
    const fields = {
      operation: args[0],
      gateway: c.gateway,
      workspace: c.workspace,
    };
    log(this.logger, 'debug', 'OpenShell command started', fields);
    try {
      const result = await lifecycle(
        c,
        args,
        deadline,
        this.runner,
        this.clock,
        signal,
      );
      log(this.logger, 'debug', 'OpenShell command completed', {
        ...fields,
        durationMs: this.clock.now() - started,
      });
      return result;
    } catch (error) {
      log(this.logger, 'warn', 'OpenShell command failed', {
        ...fields,
        durationMs: this.clock.now() - started,
        error: (error as Error).message,
      });
      throw error;
    }
  }
  async remove(c: Config, i: Identity, deadline: number) {
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(this.logger, 'info', 'OpenShell cleanup attempt', {
        attempt,
        sandboxName: i.name,
        sandboxId: i.id,
        gateway: c.gateway,
        workspace: c.workspace,
      });
      try {
        const found = await this.inspect(c, i.name, deadline);
        if (found) {
          verify(found, i);
          i.id = found.id;
          await this.command(c, ['delete', i.name], deadline);
          await this.wait(c, i, 'missing', deadline);
        } else if (!i.id) {
          throw new Error('Allocation outcome uncertain');
        }
        log(this.logger, 'info', 'OpenShell cleanup confirmed', {
          sandboxName: i.name,
          sandboxId: i.id,
        });
        return;
      } catch (error) {
        failure = error;
        log(this.logger, 'warn', 'OpenShell cleanup attempt failed', {
          attempt,
          sandboxName: i.name,
          error: (error as Error).message,
        });
        // Retry transport/process failures and uncertain visibility. Contract
        // or ownership failures must not authorize a later destructive call.
        if (
          !(error instanceof OpenShellCommandError) &&
          (error as Error).message !== 'Allocation outcome uncertain' &&
          !(error as Error).message.includes('confirmation timed out')
        )
          throw error;
        const budget = deadline - this.clock.now();
        if (attempt === 3 || budget <= 1) break;
        await this.clock.sleep(Math.min(500, Math.floor(budget / 2)));
      }
    }
    throw failure;
  }
  async preflight(c: Config, name: string, deadline: number) {
    if (await this.inspect(c, name, deadline))
      throw new Error('Sandbox name already exists before allocation');
    // OpenShell validates templates and policy files when creating the sandbox.
  }

  async inspect(
    c: Config,
    name: string,
    deadline: number,
    selector?: string,
    signal?: AbortSignal,
  ): Promise<Sandbox | null> {
    let match: Sandbox | null = null;
    let token = '';
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      if (signal?.aborted)
        throw new OpenShellCommandError('OpenShell command cancelled');
      const response = object(
        json(
          await this.command(
            c,
            [
              'list',
              '--output',
              'json',
              '--page-size',
              '100',
              '--page-token',
              token,
              ...(selector ? ['--selector', selector] : []),
            ],
            deadline,
            signal,
          ),
        ),
      );
      if (
        !Array.isArray(response.sandboxes) ||
        typeof response.next_page_token !== 'string'
      )
        throw new Error('Invalid sandbox list JSON shape');
      const entries = response.sandboxes.map(sandbox);
      const found = entries.filter((s) => s.name === name);
      if (found.length > 1) throw new Error('Ambiguous sandbox identity');
      if (found[0]) {
        if (match) throw new Error('Ambiguous sandbox identity');
        match = found[0];
      }
      token = response.next_page_token;
      if (!token) return match;
      if (seen.has(token))
        throw new Error('Repeated OpenShell pagination token');
      seen.add(token);
    }
    throw new Error('OpenShell pagination limit exceeded');
  }
  async inspectExecution(c: Config, i: Identity, deadline: number) {
    const selector = `paperclip-attempt=${i.labels['paperclip-attempt']}`;
    const key = JSON.stringify([
      c.executable,
      c.configHome ?? null,
      c.gateway,
      c.workspace,
      i.name,
      selector,
    ]);
    const pending = this.inspections.get(key);
    // Reuse work only while it is in flight and within this caller's budget.
    // Never retain a completed ownership check or share lifecycle inspections.
    if (pending && pending.deadline <= deadline) return pending.result;
    const entry = {
      deadline,
      result: this.inspect(c, i.name, deadline, selector),
    };
    this.inspections.set(key, entry);
    try {
      return await entry.result;
    } finally {
      if (this.inspections.get(key) === entry) this.inspections.delete(key);
    }
  }
  async wait(
    c: Config,
    i: Identity,
    state: 'Ready' | 'Stopped' | 'missing',
    deadline: number,
  ) {
    while (this.clock.now() < deadline) {
      let s: Sandbox | null;
      try {
        s = await this.inspect(c, i.name, deadline);
      } catch (error) {
        // The budget can expire after the loop guard, including between list
        // pages. Report the same confirmation timeout as expiry during sleep.
        // Preserve transport, response-shape and ownership failures.
        if (
          error instanceof OperationDeadlineError &&
          this.clock.now() >= deadline
        )
          break;
        throw error;
      }
      if (!s) {
        if (state === 'missing') return;
        if (state !== 'Ready') throw new Error('Sandbox missing');
      }
      if (s) verify(s, i);
      log(this.logger, 'debug', 'OpenShell sandbox state', {
        sandboxName: i.name,
        sandboxId: s?.id,
        phase: s?.phase ?? 'missing',
        expected: state,
      });
      if (s?.phase === state) return;
      if (
        state === 'Ready' &&
        s &&
        ['Error', 'Completed', 'Deleting'].includes(s.phase)
      )
        throw new Error(
          `Sandbox ${i.name} did not become ready (phase=${s.phase})`,
        );
      await this.clock.sleep(
        Math.min(this.pollMs, Math.max(1, deadline - this.clock.now())),
      );
    }
    throw new Error(`Sandbox ${state} confirmation timed out`);
  }
  async exec(
    c: Config,
    i: Identity,
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    stdin: string | undefined,
    timeoutMs: number,
    onOutput?: Parameters<Runner>[5],
  ) {
    validateExecution(command, args, cwd, env, stdin, timeoutMs);
    const flags = [
      'exec',
      '--name',
      i.name,
      '--no-tty',
      '--no-login-shell',
      '--workdir',
      cwd,
      '--timeout',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ];
    const setup: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (/[\r\n]/.test(value)) {
        // OpenShell 0.1.2 rejects CR/LF in exec environment overrides. Decode
        // these values inside the workload instead. Keys are validated above;
        // only base64 data enters shell source. The sentinel preserves trailing
        // newlines that command substitution would otherwise strip.
        const encoded = Buffer.from(value, 'utf8').toString('base64');
        setup.push(
          `${key}=$(printf '%s' '${encoded}' | base64 -d && printf '.') || exit "$?"`,
          `export ${key}="\${${key}%.}"`,
        );
      } else {
        flags.push('--env', `${key}=${value}`);
      }
    }
    const remoteCommand = setup.length
      ? [
          'sh',
          '-c',
          [...setup, 'exec "$@"'].join('; '),
          'paperclip-env',
          command,
          ...args,
        ]
      : [command, ...args];
    const started = this.clock.now();
    log(this.logger, 'debug', 'OpenShell execution started', {
      sandboxName: i.name,
      timeoutMs,
    });
    const result = await invoke(
      this.runner,
      c.executable,
      [...scope(c), 'sandbox', ...flags, '--', ...remoteCommand],
      timeoutMs,
      stdin,
      c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
      onOutput,
    );
    // The v0.1.2 CLI exposes remote timeout as exit 124, with no separate flag.
    log(this.logger, 'debug', 'OpenShell execution completed', {
      sandboxName: i.name,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: this.clock.now() - started,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
    });
    return { ...result, timedOut: result.timedOut || result.exitCode === 124 };
  }
}

export function validateExecution(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin: string | undefined,
  timeoutMs: number,
) {
  checkStdin(stdin);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000)
    throw new Error('Invalid execution timeout');
  if (
    typeof command !== 'string' ||
    !command ||
    command.includes('\0') ||
    !Array.isArray(args) ||
    args.some((a) => typeof a !== 'string' || a.includes('\0')) ||
    typeof cwd !== 'string' ||
    !cwd.startsWith('/') ||
    cwd.includes('\0')
  )
    throw new Error('Invalid execution arguments');
  if (!env || typeof env !== 'object' || Array.isArray(env))
    throw new Error('Invalid command environment');
  for (const [key, value] of Object.entries(env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== 'string' ||
      value.includes('\0')
    )
      throw new Error('Invalid command environment');
  }
}
