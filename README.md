# OpenShell sandbox provider for Paperclip

A small CLI bridge for Paperclip **2026.1005.0** and OpenShell **0.1.2**. It creates a sandbox, prepares a workspace, runs commands, and stops or deletes the sandbox. Paperclip handles workspace transfer using its tar/base64 fallback.

Install the package in Paperclip and enable its `openshell` sandbox driver. The Paperclip worker needs Node >=24.11.0 and an installed `openshell` CLI. Register and authenticate the gateway in the worker's OpenShell configuration directory before testing.

Configure the workload directly in OpenShell using a named template. In the Paperclip environment, select provider `openshell` and supply:

```json
{
  "provider": "openshell",
  "gateway": "my-gateway",
  "template": "paperclip-runtime",
  "configHome": "/absolute/path/to/.config"
}
```

`configHome` is the parent of the `openshell` configuration directory (the CLI's `XDG_CONFIG_HOME`). Omit it when the worker already inherits the correct directory. The CLI subprocess uses the selected gateway and workspace explicitly; it removes `OPENSHELL_GATEWAY_ENDPOINT` to avoid overriding that selection.

Templates specify the workload image, resources, driver configuration and environment in OpenShell. OpenShell 0.1.2's CLI supplies sandbox policy and credential-provider bindings separately: use an authored policy file and names of providers already configured and authenticated in OpenShell. The plugin does not author policy or create credential providers.

```json
{
  "provider": "openshell",
  "gateway": "my-gateway",
  "template": "paperclip-runtime",
  "policyFile": "/absolute/worker/path/policy.yaml",
  "providers": ["github"]
}
```

In the environment form, choose exactly one workload source: **Workload template** (recommended) or **Container image**. Leave the unused field blank. For a simple workload without a template, replace `template` with `image`. Configure resource limits in an OpenShell template. The provider starts a persistent `/bin/sh` process and uses `/sandbox/paperclip-workspace`. Your image and policy must allow workspace writes and these tools:

```text
sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename awk sed head tail touch cp ln sleep
```

Use a runtime image containing your agent tooling. Acquisition checks the tools and workspace before returning a lease.

| Setting               | Default     | Purpose                                      |
| --------------------- | ----------- | -------------------------------------------- |
| `gateway`             | required    | Registered OpenShell gateway                 |
| `template` or `image` | required    | Workload source; supply one                  |
| `workspace`           | `default`   | OpenShell workspace                          |
| `configHome`          | inherited   | Worker-local XDG configuration directory     |
| `executable`          | `openshell` | CLI executable                               |
| `sshExecutable`       | `ssh`       | Worker SSH executable selector               |
| `enableDuplex`        | `false`     | Enable duplex callback bridge for new runs   |
| `policyFile`          | omitted     | Authored policy file on the worker           |
| `providers`           | `[]`        | Existing credential-provider names           |
| `timeoutMs`           | `300000`    | Acquisition/command budget, 1000–86400000 ms |
| `reuseLease`          | `false`     | Keep ordinary released leases for resume     |

The form puts gateway, workspace and worker configuration first, followed by the two workload alternatives. **Advanced options** groups policy and credentials, lifecycle settings, worker executables and callback transport. Credential providers use an editable list; reuse and duplex use checkboxes; the timeout uses a bounded numeric input.

Leaving `workspace`, `executable`, `sshExecutable` or `timeoutMs` blank uses the defaults above, including when a previously entered value is cleared. Blank `configHome` and `policyFile` values are treated as omitted. Gateway and the selected workload source still require values; there is no default gateway, template or image.

Paperclip-owned and future configuration fields are accepted and preserved. Only fields the provider consumes are validated. OpenShell validates policy and template contents when creating the sandbox. Plugin instance settings are unnecessary for normal operation.

## Multiline task environment values

OpenShell 0.1.2 rejects carriage returns and newlines in `sandbox exec --env` values. The provider transports multiline task values as base64 in a shell wrapper, restores them inside the sandbox, and replaces the wrapper with the requested command. This preserves trailing newlines, argument boundaries and stdin; ordinary values still use `--env`.

With an older plugin, this can surface as `Failed to install the adapter runtime command` even when the image already contains the CLI: Paperclip's availability check and install attempt both receive the rejected environment. Update the plugin and reload its worker. No harness image change is needed for this transport error.

## Image environment variables missing in tasks

OpenShell 0.1.2 starts the sandbox's initial process with the image environment, but rebuilds the environment for subsequent `sandbox exec` commands. Dockerfile `ENV` values such as `JAVA_HOME`, `ANDROID_HOME`, and `PLAYWRIGHT_BROWSERS_PATH` are not automatically inherited by those commands. The exec environment includes selected defaults (including `PATH`), explicitly configured template environment variables, provider variables, and command overrides.

This provider keeps an initial process running and launches Paperclip task commands through `sandbox exec --no-tty --no-login-shell`. Consequently, variables visible after an interactive `openshell sandbox create` can be absent from Paperclip tasks using the same image and policy. Removing `--no-login-shell` only enables shell startup files; it does not restore Dockerfile `ENV` inheritance.

Declare required non-secret variables explicitly when creating the OpenShell template. For the Paperclip Expo image, for example, create a new template with the same image and resources:

```sh
openshell sandbox template create paperclip-expo-env \
  --image '<same-image-reference>' \
  --cpu 2 --memory 4Gi \
  --env JAVA_HOME=/opt/java17 \
  --env ANDROID_HOME=/opt/android-sdk \
  --env ANDROID_SDK_ROOT=/opt/android-sdk \
  --env PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
  --env PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  --env NO_UPDATE_CHECK=1
```

Use the same gateway/workspace scope as the Paperclip environment, preserve any other template settings, then select the new template in Paperclip and start a fresh sandbox. Keep `policyFile` configured separately. Use credential providers for secrets.

To check an existing sandbox through the same execution path, substitute its name and the configured gateway/workspace:

```sh
openshell --gateway my-gateway --workspace default sandbox exec \
  --name '<sandbox-name>' --no-tty --no-login-shell -- \
  /bin/sh -c 'printf "JAVA_HOME=%s\nANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nPLAYWRIGHT_BROWSERS_PATH=%s\n" "$JAVA_HOME" "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$PLAYWRIGHT_BROWSERS_PATH"'
```

## Opt-in duplex callback bridge

The provider supports Paperclip's existing duplex command channel through one
persistent noninteractive SSH command. Ordinary executions and native live output
streaming keep their current behavior. The worker needs OpenSSH (`sshExecutable`,
default `ssh`) as well as OpenShell 0.1.2. Install the provider with the environment
option **off until controlled live acceptance succeeds**. Live exec-reduction
measurements are outstanding; mocked and RPC tests do not establish live coverage.

Two independent settings control new runs. The environment editor's **Enable
duplex callback bridge** checkbox (`enableDuplex`, default false) stays editable.
It requires an instance admin to enable `enableSandboxDuplexBridge` through the
existing instance API; Paperclip v2026.1005.0 has no corresponding admin UI switch.
The plugin never reads or modifies that instance setting.

As an instance admin signed in to your Paperclip instance, run this in its browser
console. It reads and records the previous value, patches only the duplex field,
and verifies the effective setting using your existing same-origin login:

```js
const settingsPath = '/api/instance/settings/experimental';
const beforeResponse = await fetch(settingsPath, {
  credentials: 'same-origin',
});
if (!beforeResponse.ok)
  throw new Error(`Read failed: ${beforeResponse.status}`);
const beforeSettings = await beforeResponse.json();
console.log('Previous value:', beforeSettings.enableSandboxDuplexBridge);
const patchResponse = await fetch(settingsPath, {
  method: 'PATCH',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enableSandboxDuplexBridge: true }),
});
if (!patchResponse.ok)
  throw new Error(`Update failed: ${patchResponse.status}`);
const verifyResponse = await fetch(settingsPath, {
  credentials: 'same-origin',
  cache: 'no-store',
});
if (!verifyResponse.ok)
  throw new Error(`Verify failed: ${verifyResponse.status}`);
const effectiveSettings = await verifyResponse.json();
if (effectiveSettings.enableSandboxDuplexBridge !== true)
  throw new Error('Instance duplex setting is not effectively enabled');
console.log(
  'Instance duplex setting enabled; enable the environment option next.',
);
```

API rejection or an effective managed-off setting must be resolved through your
instance's authorization and policy; this endpoint does not bypass either.
The instance flag and provider environment config are separate settings.
Saving the environment option as true while the instance flag is false is valid.

Next, enable the checkbox in the selected environment and turn **Stream run logs**
off (`streamRunLogs: false`). The generic host hint that output appears only on
completion does not describe this provider: its native streaming still delivers
live output. Leaving this setting on retains extra log-tail polling. The plugin
never changes it for you. Start a new run and confirm host duplex readiness.

| Instance gate | Environment option | Hooks/capability | New run                                                     |
| ------------- | ------------------ | ---------------- | ----------------------------------------------------------- |
| Off/unknown   | Either             | Either           | File bridge                                                 |
| On            | Off/missing        | Present          | Provider declines before SSH; bounded host startup fallback |
| On            | On                 | Missing          | File bridge with capability diagnostic                      |
| On            | On                 | Present          | SSH attempt, then host protocol readiness handshake         |

An SSH spawn alone does not establish bridge readiness. Correlate worker
`OpenShell duplex environment selection`, open duration and termination reason
with host readiness/selection/fallback diagnostics using the route/session IDs.
A fallback to file polling still risks exhausting OpenShell's lifetime budget of
4,096 exec identities. After establishment, transport loss fails the channel;
requests are not replayed or silently switched to file polling. SSH status 255,
a local signal or a provider close is reported as transport loss, which does not
prove remote termination. A known SSH remote exit is reported separately.

For rollback, disable the environment checkbox, or repeat the PATCH with
`enableSandboxDuplexBridge: false` and verify the effective value. Patch only that
field; preserve unrelated instance settings. Changes select transport for new
runs; established channels continue. The worker refreshes environment opt-in on
the next successful validated acquisition, resume or execution. Release, stop,
destroy and shutdown invalidate the saved lease and close its channels. After a
worker restart, resume or execute with verified lease metadata before opening.

The transport uses the pinned CLI's
[name-mode SSH proxy](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/ssh.rs),
with explicit gateway/workspace and `XDG_CONFIG_HOME`. The CLI resolves local
gateway credentials and creates a fresh SSH session per proxy invocation; the
plugin does not store session tokens. SSH host-key checks match OpenShell's
relay model: the authenticated gateway and its sandbox relay are the trust
boundary, rather than a globally pinned sandbox SSH key. No global SSH files are
changed. Inherited endpoint overrides and SSH config are excluded, PTY and
interactive authentication are disabled, remote argv elements are quoted
individually, and the supervisor receives `OPENSHELL_NO_LOGIN_SHELL=1`.

Plugin limits are 128 concurrent routes, 1,024 recent close acknowledgements,
1,024 saved verified leases (oldest evicted with channel cleanup), and 1,024
concurrent validations. Per route: 192 KiB decoded input frames, 4 MiB queued
input and 256 queued writes; write completion respects stdin backpressure and a
10-second budget. Open has a 10-second budget; close allows 250 ms for stdin EOF,
250 ms after SIGTERM, then up to 1 second after SIGKILL of the SSH process group,
including proxy helpers. Stderr is discarded with a saturated 16 KiB diagnostic
counter; no command, payload or stderr enters lifecycle logs. Output is raw binary
in at most 16 KiB notifications, with no lifetime output accumulation or plugin
pre-bind output queue. Ordinary exec retains its 4 MiB stdin and 16 MiB combined
output limits.

SDK notifications return void and do not propagate consumer backpressure. The
pinned host bounds pre-bind frames/bytes, pending writes and route output (default
256 MiB total data and one hour duration); its limits can terminate a channel.
The plugin's slow-stdin tests verify its own queues, not end-to-end memory under
a slow host consumer. Do not infer unlimited channel lifetime or bounded total
worker RPC memory from this implementation.

One bridge command consumes an exec identity; bytes sent on that command do not
create more executions. Setup, sync and legitimate agent executions still consume
identities. Neither activation nor rollback repairs an exhausted runtime; a
controlled sandbox generation reset interrupts active work and requires separate
operator planning. There is no automatic restart or command replay.

See the [implementation handoff and live acceptance checklist](docs/duplex-implementation-handoff.md)
and [validation record](docs/duplex-validation.md). Run `pnpm test:live -- --duplex`
with the documented smoke variables for a fresh designated test sandbox; complete
the real OpenCode workflow and 20-minute exec-count comparison separately.

## Failure handling and logs

### Long-running workloads

Execution output now streams through the SDK while the command runs, while the
final result still contains complete stdout/stderr. Set `streamRunLogs: false` in
Paperclip's sandbox configuration to disable its additional file-tail poller.
This removes recurring log-tail execs; it does not disable the callback bridge.
The optional duplex callback bridge below removes callback-queue polling once the host handshake succeeds. Persistent process sessions remain unsupported.

Execution ownership checks use an OpenShell label selector for the lease's
attempt instead of listing the entire workspace. All returned pages and ownership
fields are still validated. Simultaneous checks of the same scoped allocation
can share an in-flight lookup; completed results are never cached. Lifecycle and
cleanup lookups remain independent and complete. Inspection and execution now
share the caller's timeout, so a short bridge command cannot spend the full
environment timeout inspecting before starting another execution timeout.

With duplex disabled or startup fallback selected, Paperclip's queue callback bridge still polls, and each poll still needs an exec.
Provider execution diagnostics use debug logging to avoid two info-level host
log events per poll. Live gateway CPU and latency improvements require measurement
on the deployed workload.

Repeated `POST /runtime-tools/github/credentials` requests are separate from empty
queue polling: Paperclip's managed GitHub launcher makes these requests when
`git` or `gh` is invoked. If they recur every few hundred milliseconds, inspect
the sandbox process tree for repeated Git invocations and nested managed launcher
directories in `PATH`. Check the OpenShell exec rate and the Paperclip runtime
version alongside these requests. The provider does not cache broker credentials
or bypass per-operation identity checks. DNS/policy messages for every request
can add further sandbox work; this change does not suppress security audit logs.

### Cleanup and diagnostics

The draft probe checks gateway access without allocating anything. Paperclip's **Test Provider** creates a fresh sandbox with `reuseLease: false`, then releases it. This provider deletes test sandboxes, including those with Paperclip's `archiveOnRelease` flag.

If acquisition fails after creation, cleanup gets a fresh budget of up to 30 seconds, separate from the failed command. Cleanup retries up to three times, verifies ownership before deletion, and confirms absence. Ordinary destruction uses the same routine and is idempotent for an already deleted sandbox. Stop and `stop_and_retain` confirm the stopped state and preserve files.

Cleanup of a saved lease uses its recorded gateway, workspace, executable and config directory. Changed images, removed templates, unreadable policy files, invalid runtime fields, or unavailable plugin configuration cannot block this path. Existing leases keep their ownership metadata format.

A gateway outage can prevent deletion. An interrupted create can also finish remotely after the CLI exits. In these cases the provider reports structured cleanup evidence; Paperclip records `pending_cleanup` and retries. It never reports a sandbox destroyed without confirmation. Once deletion is confirmed, Paperclip can expire the cleanup lease. The plugin cannot reset Paperclip database/UI state itself.

Logs include operation start/completion/failure, company/environment/run and attempt IDs, sandbox identity, scope, command duration, observed state, cleanup retry count and confirmation. Command arguments, stdin, environment values, policy contents and raw CLI output are excluded. Execution logs include exit code, signal, timeout and output byte counts. Logger failures never interrupt resource cleanup.

To debug, find the acquisition attempt/environment ID in the Paperclip plugin logs, then correlate the sandbox name with your OpenShell gateway logs. Check gateway registration, the worker's config directory, template/image, authored policy and existing credential providers. Retry Test Provider after fixing the cause.

For old pending cleanup records or a moved configuration directory, plugin instance configuration supports the recovery escape hatch:

```json
{
  "cleanupRecovery": [
    {
      "environmentId": "paperclip-environment-id",
      "gateway": "my-gateway",
      "workspace": "default",
      "configHome": "/absolute/path/to/.config",
      "rejectedAttemptIds": []
    }
  ]
}
```

Only add an attempt UUID to `rejectedAttemptIds` after gateway/CLI evidence establishes that creation was rejected. A successful scoped absence check is still required. When a late allocation is discovered without a persisted sandbox ID, the provider returns its observed identity for Paperclip to persist before the next teardown attempt.

## Migration from the previous canary

Move plugin `defaults`/`profiles` into each environment's direct configuration. Replace `profile` with an OpenShell `template` or an explicit `image`. Move `cpu` and `memory` into that template. Write plugin `policies`/inline YAML to a worker-local authored file and set `policyFile` directly; `policyPreset` is removed. Old configuration layers are no longer resolved. Existing persisted leases remain stoppable and destroyable using their recorded connection settings.

See [development and verification](docs/development.md) and [verified upstream contracts](docs/upstream-contracts.md).
