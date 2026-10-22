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

For a simple workload without a template, replace `template` with `image`. Configure resource limits in an OpenShell template. The provider starts a persistent `/bin/sh` process and uses `/sandbox/paperclip-workspace`. Your image and policy must allow workspace writes and these tools:

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
| `policyFile`          | omitted     | Authored policy file on the worker           |
| `providers`           | `[]`        | Existing credential-provider names           |
| `timeoutMs`           | `300000`    | Acquisition/command budget, 1000–86400000 ms |
| `reuseLease`          | `false`     | Keep ordinary released leases for resume     |

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

## Failure handling and logs

### Long-running workloads

Execution output now streams through the SDK while the command runs, while the
final result still contains complete stdout/stderr. Set `streamRunLogs: false` in
Paperclip's sandbox configuration to disable its additional file-tail poller.
This removes recurring log-tail execs; it does not disable the callback bridge.
Persistent sessions and duplex transport remain unsupported by this provider.

Execution ownership checks use an OpenShell label selector for the lease's
attempt instead of listing the entire workspace. All returned pages and ownership
fields are still validated. Simultaneous checks of the same scoped allocation
can share an in-flight lookup; completed results are never cached. Lifecycle and
cleanup lookups remain independent and complete. Inspection and execution now
share the caller's timeout, so a short bridge command cannot spend the full
environment timeout inspecting before starting another execution timeout.

Paperclip's queue callback bridge still polls, and each poll still needs an exec.
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
