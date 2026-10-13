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

## Failure handling and logs

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
