import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  decodeChannelBytes,
  type PluginDuplexChannelOpenParams as Open,
  type PluginDuplexChannelWriteParams as Write,
  type PluginDuplexChannelStopParams as Stop,
  type PluginDuplexChannelCloseParams as Close,
} from '@paperclipai/plugin-sdk/protocol';
import type {
  PluginDuplexChannelClient,
  PluginLogger,
} from '@paperclipai/plugin-sdk/types';
import type { Config } from './config.js';
import type { Identity } from './identity.js';
import { log } from './logging.js';

export class DuplexUnavailableError extends Error {}

export const duplexLimits = {
  routes: 128,
  tombstones: 1024,
  frameBytes: 192 * 1024,
  inputBytes: 4 * 1024 * 1024,
  writes: 256,
  outputChunk: 16 * 1024,
  diagnosticBytes: 16 * 1024,
  openMs: 10_000,
  writeMs: 10_000,
  gracefulMs: 250,
  terminateMs: 250,
  forceMs: 1000,
};
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// OpenSSH expands percent tokens even inside shell quotes in ProxyCommand.
const proxyQuote = (s: string) => quote(s).replaceAll('%', '%%');
export function sshArgs(c: Config, i: Identity, command: readonly string[]) {
  const proxy = [
    c.executable,
    'ssh-proxy',
    '--gateway-name',
    c.gateway,
    '--name',
    i.name,
    '--workspace',
    c.workspace,
  ]
    .map(proxyQuote)
    .join(' ');
  return [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'IdentityAgent=none',
    '-o',
    'IdentityFile=none',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'SetEnv=OPENSHELL_NO_LOGIN_SHELL=1',
    '-o',
    `ProxyCommand=${proxy}`,
    'sandbox',
    command.map(quote).join(' '),
  ];
}
export type DuplexLauncher = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;
const launch: DuplexLauncher = (executable, args, env) =>
  spawn(executable, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    detached: true,
  });
type Connection = { c: Config; i: Identity; valid: () => boolean };
type Route = {
  hostRouteId: string;
  workerSessionId: string;
  leaseKey: string;
  cancel: AbortController;
  child?: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  finish: () => void;
  exited: boolean;
  closing?: Promise<void>;
  bytes: number;
  writes: number;
  tail: Promise<void>;
};
export const leaseKey = (p: {
  companyId: string;
  environmentId: string;
  driverKey: string;
  providerLeaseId: string;
}) =>
  JSON.stringify([
    p.companyId,
    p.environmentId,
    p.driverKey,
    p.providerLeaseId,
  ]);

export class DuplexChannels {
  private routes = new Map<string, Route>();
  private closed = new Map<
    string,
    { hostRouteId: string; workerSessionId?: string }
  >();
  private stopped = false;
  logger?: PluginLogger;
  notifications?: PluginDuplexChannelClient;
  constructor(
    private resolve: (p: Open, signal: AbortSignal) => Promise<Connection>,
    private launcher: DuplexLauncher = launch,
    private now: () => number = Date.now,
  ) {}
  private pair(r: Route) {
    return { hostRouteId: r.hostRouteId, workerSessionId: r.workerSessionId };
  }
  private remember(
    id: string,
    pair: { hostRouteId: string; workerSessionId?: string },
  ) {
    this.closed.delete(id);
    this.closed.set(id, pair);
    if (this.closed.size > duplexLimits.tombstones)
      this.closed.delete(this.closed.keys().next().value!);
  }
  private kill(r: Route, signal: NodeJS.Signals) {
    try {
      if (r.child?.pid) process.kill(-r.child.pid, signal);
      else r.child?.kill(signal);
    } catch {
      /* already gone */
    }
  }
  private exit(r: Route, code: number | null, transportClosed: boolean) {
    if (r.exited) return;
    r.exited = true;
    r.cancel.abort();
    this.kill(r, 'SIGKILL'); // includes the ProxyCommand helper
    r.finish();
    if (this.routes.get(r.hostRouteId) === r) this.routes.delete(r.hostRouteId);
    this.remember(r.hostRouteId, this.pair(r));
    try {
      this.notifications?.exit(
        r.hostRouteId,
        r.workerSessionId,
        code,
        transportClosed,
      );
    } catch {
      /* notification sink unavailable */
    }
    log(this.logger, 'info', 'OpenShell duplex channel terminated', {
      ...this.pair(r),
      reason: transportClosed ? 'transport_closed' : 'remote_exit',
      exitCode: code,
    });
  }
  async open(p: Open) {
    if (this.stopped)
      throw new Error('Duplex unavailable: worker shutting down');
    if (
      typeof p.hostRouteId !== 'string' ||
      !p.hostRouteId ||
      p.hostRouteId.length > 1024 ||
      this.routes.has(p.hostRouteId) ||
      this.closed.has(p.hostRouteId)
    )
      throw new Error('Duplex route unavailable or already registered');
    if (this.routes.size >= duplexLimits.routes)
      throw new Error('Duplex route capacity exceeded');
    if (
      !Array.isArray(p.command) ||
      !p.command.length ||
      !p.command[0] ||
      p.command.some((s) => typeof s !== 'string' || s.includes('\0')) ||
      Buffer.byteLength(JSON.stringify(p.command)) > duplexLimits.frameBytes
    )
      throw new Error('Invalid duplex command');
    let finish!: () => void;
    const r: Route = {
      hostRouteId: p.hostRouteId,
      workerSessionId: randomUUID(),
      leaseKey: leaseKey(p),
      cancel: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
      exited: false,
      bytes: 0,
      writes: 0,
      tail: Promise.resolve(),
    };
    this.routes.set(p.hostRouteId, r);
    const started = this.now();
    const timer = setTimeout(() => {
      void this.closeRoute(r);
    }, duplexLimits.openMs);
    const cancelled = new Promise<never>((_, reject) => {
      r.cancel.signal.addEventListener(
        'abort',
        () => reject(new Error('Duplex open cancelled')),
        { once: true },
      );
    });
    try {
      // The lookup is bounded by the same deadline; late completion cannot spawn.
      const connection = await Promise.race([
        this.resolve(p, r.cancel.signal),
        cancelled,
      ]);
      if (r.cancel.signal.aborted || !connection.valid())
        throw new Error('Duplex lease invalidated');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(connection.c.configHome
          ? { XDG_CONFIG_HOME: connection.c.configHome }
          : {}),
      };
      delete env.OPENSHELL_GATEWAY_ENDPOINT;
      const child = this.launcher(
        connection.c.sshExecutable,
        sshArgs(connection.c, connection.i, p.command),
        env,
      );
      r.child = child;
      let diagnostics = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        // Count and discard bounded diagnostics; never expose proxy output.
        diagnostics = Math.min(
          duplexLimits.diagnosticBytes,
          diagnostics + chunk.length,
        );
      });
      const ioFailed = () => {
        void this.closeRoute(r);
      };
      child.stdin.on('error', ioFailed);
      child.stdout.on('error', ioFailed);
      child.stderr.on('error', ioFailed);
      child.stdout.on('data', (chunk: Buffer) => {
        if (r.exited || r.cancel.signal.aborted) return;
        try {
          for (
            let offset = 0;
            offset < chunk.length;
            offset += duplexLimits.outputChunk
          )
            this.notifications?.data(
              r.hostRouteId,
              r.workerSessionId,
              chunk.subarray(offset, offset + duplexLimits.outputChunk),
            );
        } catch {
          ioFailed();
        }
      });
      child.once('close', (code, signal) =>
        this.exit(
          r,
          !r.cancel.signal.aborted && !signal && code !== 255 ? code : null,
          r.cancel.signal.aborted || !!signal || code === 255 || code === null,
        ),
      );
      child.once('error', () => this.exit(r, null, true));
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', () =>
            reject(
              new Error(
                'Duplex SSH startup failed; check sshExecutable and worker access',
              ),
            ),
          );
          child.once('close', () =>
            reject(new Error('Duplex SSH closed during startup')),
          );
        }),
        cancelled,
      ]);
      if (r.cancel.signal.aborted || !connection.valid())
        throw new Error('Duplex lease invalidated');
      log(
        this.logger,
        'info',
        'OpenShell duplex SSH started; host handshake pending',
        {
          ...this.pair(r),
          enableDuplex: true,
          durationMs: this.now() - started,
        },
      );
      return this.pair(r);
    } catch (error) {
      await this.closeRoute(r);
      const reason =
        error instanceof DuplexUnavailableError
          ? error.message
          : 'cancelled, stale lease or SSH startup failed; check worker access and gateway authentication';
      log(
        this.logger,
        'warn',
        'OpenShell duplex open unavailable; host may fall back to file polling',
        {
          ...this.pair(r),
          durationMs: this.now() - started,
          reason,
        },
      );
      // eslint-disable-next-line preserve-caught-error -- subprocess errors may contain credentials
      throw new Error(`Duplex unavailable: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
  private live(p: Stop) {
    const r = this.routes.get(p.hostRouteId);
    if (
      !r ||
      r.workerSessionId !== p.workerSessionId ||
      r.exited ||
      r.cancel.signal.aborted ||
      !r.child
    )
      throw new Error('Duplex route/session unavailable');
    return r;
  }
  async write(p: Write) {
    const r = this.live(p);
    if (
      typeof p.data !== 'string' ||
      p.data.length > Math.ceil(duplexLimits.frameBytes / 3) * 4
    )
      throw new Error('Duplex frame exceeds limit');
    const data = decodeChannelBytes(p.data);
    if (!data) throw new Error('Invalid duplex byte frame');
    if (
      r.bytes + data.byteLength > duplexLimits.inputBytes ||
      r.writes >= duplexLimits.writes
    ) {
      await this.closeRoute(r);
      throw new Error('Duplex input queue exceeded');
    }
    r.bytes += data.byteLength;
    r.writes++;
    const write = r.tail
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (r.cancel.signal.aborted) {
              reject(new Error('Duplex closed'));
              return;
            }
            let settled = false;
            const complete = (failed: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              r.cancel.signal.removeEventListener('abort', aborted);
              if (failed) reject(new Error('Duplex input failed or timed out'));
              else resolve();
            };
            const aborted = () => complete(true);
            const timer = setTimeout(() => {
              complete(true);
              void this.closeRoute(r);
            }, duplexLimits.writeMs);
            r.cancel.signal.addEventListener('abort', aborted, { once: true });
            r.child!.stdin.write(data, (error) => complete(!!error));
          }),
      )
      .finally(() => {
        r.bytes -= data.byteLength;
        r.writes--;
      });
    r.tail = write.catch(() => {
      void this.closeRoute(r);
    });
    return write;
  }
  async stop(p: Stop) {
    this.live(p);
    await this.close(p);
  }
  async close(p: Close) {
    if (
      typeof p.hostRouteId !== 'string' ||
      !p.hostRouteId ||
      p.hostRouteId.length > 1024
    )
      throw new Error('Invalid duplex route');
    const r = this.routes.get(p.hostRouteId);
    if (!r) {
      const pair = this.closed.get(p.hostRouteId) ?? {
        hostRouteId: p.hostRouteId,
      };
      this.remember(p.hostRouteId, pair);
      return pair;
    }
    return this.closeRoute(r);
  }
  private async closeRoute(r: Route) {
    if (r.exited) return this.pair(r);
    r.cancel.abort();
    r.closing ??= (async () => {
      if (!r.child) {
        this.exit(r, null, true);
        return;
      }
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          void r.done.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      r.child.stdin.end();
      await wait(duplexLimits.gracefulMs);
      if (r.exited) return;
      this.kill(r, 'SIGTERM');
      await wait(duplexLimits.terminateMs);
      if (r.exited) return;
      this.kill(r, 'SIGKILL');
      await wait(duplexLimits.forceMs);
      r.child.stdin.destroy();
      r.child.stdout.destroy();
      r.child.stderr.destroy();
      this.exit(r, null, true);
    })();
    await r.closing;
    return this.pair(r);
  }
  async invalidate(key: string) {
    await Promise.all(
      [...this.routes.values()]
        .filter((r) => r.leaseKey === key)
        .map((r) => this.closeRoute(r)),
    );
  }
  async shutdown() {
    this.stopped = true;
    await Promise.all(
      [...this.routes.keys()].map((hostRouteId) => this.close({ hostRouteId })),
    );
  }
}
