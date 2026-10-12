import {
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
import { systemClock, type Clock } from './deadline.js';
export class SandboxClient {
  constructor(
    private readonly runner: Runner,
    private readonly pollMs = 500,
    readonly clock: Clock = systemClock,
  ) {}
  command(c: Config, args: string[], deadline: number) {
    return lifecycle(c, args, deadline, this.runner, this.clock);
  }
  async inspect(
    c: Config,
    name: string,
    deadline: number,
  ): Promise<Sandbox | null> {
    let match: Sandbox | null = null;
    let token = '';
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
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
            ],
            deadline,
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
  async wait(
    c: Config,
    i: Identity,
    state: 'Ready' | 'Stopped' | 'missing',
    deadline: number,
  ) {
    while (this.clock.now() < deadline) {
      const s = await this.inspect(c, i.name, deadline);
      if (!s) {
        if (state === 'missing') return;
        throw new Error('Sandbox missing');
      }
      verify(s, i);
      if (s.phase === state) return;
      if (
        state === 'Ready' &&
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
    for (const [key, value] of Object.entries(env)) {
      flags.push('--env', `${key}=${value}`);
    }
    const result = await invoke(
      this.runner,
      c.executable,
      [...scope(c), 'sandbox', ...flags, '--', command, ...args],
      timeoutMs,
      stdin,
      c.configHome ? { XDG_CONFIG_HOME: c.configHome } : {},
    );
    // The v0.1.2 CLI exposes remote timeout as exit 124, with no separate flag.
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
