# Proposal: reduce OpenShell exec traffic and adapter latency

Status: partially implemented. Native output forwarding, execution-scoped
in-flight inspection sharing, label filtering, and a shared inspection/execution
deadline are implemented. SSH duplex channels remain proposed; callback queue
polling is still active. Set `streamRunLogs: false` to remove the extra log-tail
poller when using the streaming provider.

Analysis date: 2026-10-21. Scope: provider-only changes, retaining Paperclip SDK
2026.1005.0 and OpenShell CLI 0.1.2.

## Findings

The observed rate of approximately 3–5 exec commands per second is consistent with
Paperclip’s transport polling, though production traces are needed to confirm the
contribution of each loop:

| Source             | Current behavior                                                    | Cost                                               |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------------- |
| Run logs           | Tails output files every 250 ms                                     | Repeated execs, including during silence           |
| Callback bridge    | Checks request files every 100 ms                                   | Repeated execs; additional calls to relay requests |
| Provider execution | Lists every sandbox page, verifies ownership, then launches the CLI | Adds latency and subprocess work to every poll     |

These intervals include command duration, so they do not imply a fixed 14 execs
per second. Several execs per second is plausible. See Paperclip’s pinned
[log tailer](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/packages/adapter-utils/src/sandbox-run-log-stream.ts)
and
[callback bridge](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/packages/adapter-utils/src/sandbox-callback-bridge.ts).

The provider also buffers output until process completion. OpenShell already
streams command output; forwarding those chunks would improve perceived
responsiveness. Its noninteractive exec path reads stdin to EOF before launching
the command, so an open exec stdin pipe cannot supply a persistent duplex
connection. See the
[OpenShell implementation](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/run.rs).

## Provider changes

### Native output forwarding

- Extend the runner with an optional output callback, preserving existing callers
  and final result shapes.
- Decode stdout/stderr incrementally with separate UTF-8 decoders and forward
  bounded chunks through `ctx.execution.log`.
- Continue collecting the complete final output for OpenCode parsing and
  Paperclip’s existing suffix deduplication.
- Preserve argument handling, closed stdin, timeout behavior, and the 4 MiB input
  / 16 MiB combined-output limits.
- Keep acquisition and lifecycle diagnostics separate from streamed command
  output.

### SSH duplex channels

- Implement the SDK’s four duplex channel hooks using one noninteractive SSH
  process through `openshell ssh-proxy`, with explicit gateway, workspace and
  config directory. OpenShell provides this
  [scoped proxy mechanism](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/ssh.rs).
- Use `shell: false`, disable PTY allocation and inherited SSH configuration, and
  quote remote argv and ProxyCommand arguments independently. Follow OpenShell’s
  tunnel-specific SSH options without modifying user SSH files.
- Add `sshExecutable`, defaulting to `ssh`; ordinary exec continues using the
  current CLI path.
- Resolve opens from a validated, in-memory lease registry populated by
  successful acquisition, resume and execution. Check company, environment,
  allocation ID, scope, ownership and readiness before opening.
- Bind data and control operations to the exact host-route/session pair. Keep
  stdout binary; exclude SSH stderr from protocol data.
- Bound pending buffers, respect stdin backpressure, emit exit once, and handle
  close-during-open and lost-open-response races.
- Close associated channels during lease teardown and worker shutdown. A
  disconnected local transport must not count as confirmed sandbox termination.
- Advertise `duplexCommandStream: true` once implemented. Keep persistent process
  sessions and native sync disabled.

## Activation and measurement

No Paperclip source changes or dependency upgrades are included.

Document this deployment combination:

- `streamRunLogs: false` in the Paperclip sandbox configuration disables its
  file-tail poller. With provider output forwarding, the existing host path
  receives live output directly.
- `experimental.enableSandboxDuplexBridge: true` enables the existing HTTP/2
  callback bridge when the provider grants duplex capability.
- Leave Paperclip’s existing startup fallback intact. Report transport selection
  clearly; do not silently replay requests after an established channel fails.

Add sanitized timing fields for total execution, ownership inspection, CLI
execution, first output, and duplex opening. Record inspection page counts and
channel failures without arguments, environment values or output contents.

Do not introduce ownership TTL caching. If concurrent inspections duplicate work,
coalesce only simultaneously in-flight, identically scoped lookups; retain
complete pagination validation and verification for each caller.

## Validation and acceptance

- Test output arriving before completion, split UTF-8 characters, concurrent
  invocation routing, exact final output, timeouts and output overflow.
- Test binary duplex round trips, delayed writes without EOF, malformed frames,
  mismatched routes, backpressure, SSH failure, early exit and teardown races.
- Extend the real SDK worker contract tests to verify streamed notifications and
  duplex method discovery.
- Compare an identical OpenCode workload before and after activation: exec/list
  counts, idle traffic, callback latency, first-output latency and total duration.
- Acceptance: a quiet established run produces no recurring log-tail or
  callback-queue execs; output arrives before command completion; callback
  requests use the persistent channel; ownership and cleanup regressions remain
  passing.
- Run lint, typecheck, tests, build and packed-consumer validation. Extend the
  opt-in live smoke test for SSH duplex and report live coverage separately.

## Assumptions and limits

Target SDK **2026.1005.0**, OpenShell **0.1.2**, and Node **>=24.11.0**. The worker
needs an SSH client for duplex support.

Streaming plus both host settings should remove the identified polling traffic.
It will not remove legitimate setup, sync or agent commands. Latency gains remain
unmeasured; no production logs or live sandbox were exercised during this
analysis. Revalidate the upstream contracts before implementation if the pinned
versions change.
