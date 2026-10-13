# OpenShell environments for Paperclip

Run Paperclip agents in an existing OpenShell installation. The plugin creates a sandbox, checks that it can run your workload, and handles workspace transfer, execution, stopping and cleanup.

Requires **Paperclip 2026.1005.0**, **OpenShell CLI 0.1.2**, and **Node ≥24.11.0** on the Paperclip worker host. Install `@everlastingcrown/paperclip-openshell-sandbox` through Paperclip's plugin management UI and enable its `environment.drivers.register` capability. The environment provider is `openshell`.

## 1. Give the Paperclip worker access to OpenShell

Install the CLI where the Paperclip plugin worker runs. In a container deployment, that means inside the Paperclip container, with access to its gateway registration, authentication files and any policy files. A CLI installed only on your laptop is insufficient.

Run these commands as the worker's operating-system user, using the same configuration directory you will give the plugin:

```sh
openshell --version
XDG_CONFIG_HOME=/paperclip/.config openshell gateway list --output json
XDG_CONFIG_HOME=/paperclip/.config openshell --gateway homelab --workspace default sandbox list --output json
```

Replace `homelab` with your registered gateway. The last command must succeed. Register/authenticate your gateway through OpenShell first if it does not. See [OpenShell's CLI guide](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/skills/openshell-cli/SKILL.md).

**`configHome` is the parent of the `openshell` directory.** For registrations under `/paperclip/.config/openshell/gateways`, use `/paperclip/.config`. Paperclip workers have a minimal environment; do not assume they inherit the server's `HOME` or `XDG_CONFIG_HOME`. Mount the required configuration and credential files and make them accessible to the worker user.

The plugin always passes an explicit gateway and workspace and removes `OPENSHELL_GATEWAY_ENDPOINT` from CLI subprocesses. Keep that gateway name bound to the same installation while leases or cleanup records exist.

## 2. Configure the runtime in OpenShell

Use a [sandbox template](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/main.rs) to keep the image and resource settings in your OpenShell installation:

```sh
XDG_CONFIG_HOME=/paperclip/.config openshell --gateway homelab --workspace default sandbox template create paperclip \
  --image registry.example.com/paperclip-runtime:tested --cpu 2 --memory 4Gi

XDG_CONFIG_HOME=/paperclip/.config openshell --gateway homelab --workspace default sandbox template get paperclip --output json
```

Replace the example image with your own tested image. It needs your agent CLI, language runtimes and these tools:

```text
sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename
awk sed head tail touch cp ln sleep
```

The sandbox user and filesystem policy must allow creating and writing `/sandbox/paperclip-workspace`. The plugin checks these prerequisites during creation and starts a persistent shell sleep loop to keep the sandbox available. `curlimages/curl` cannot run a Paperclip workspace. An image with Node and the listed tools can test the provider, but running an agent also requires the CLI used by your Paperclip adapter.

Manage credential providers and their profiles in OpenShell. Create and authenticate provider instances before attaching their **instance names** in the plugin's `providers` array. OpenShell provider profiles define credential and endpoint behavior; they are separate from the optional Paperclip runtime profiles below. The plugin uses manual policy approval and disables automatic provider discovery.

Leave policy settings out of Paperclip to use OpenShell's gateway/default policy. If you already maintain a custom policy file, make it available inside the worker and use `defaults.policyFile` below. Policies must use the [OpenShell policy schema](https://docs.nvidia.com/openshell/v0.1.2/how-it-works/policies/schema) and permit the workspace, required binaries and outbound endpoints. A sandbox template controls workload settings; it does not replace policy or credential-provider configuration.

## 3. Set shared plugin defaults once

In the OpenShell plugin's company settings, save:

```json
{
  "defaults": {
    "configHome": "/paperclip/.config",
    "gateway": "homelab",
    "workspace": "default",
    "template": "paperclip"
  }
}
```

If needed, add `"providers": ["your-existing-provider"]` and `"policyFile": "/paperclip/policies/paperclip.yaml"` inside `defaults`. Paths refer to files on the worker host/container. Policy files are checked for readability before allocation and parsed by OpenShell; their contents stay out of Paperclip lease metadata and logs.

If you do not use templates, replace `template` with `image` and optionally `cpu` and `memory`. Do not combine `template` with `image`, `cpu` or `memory` in the same settings object; change template resources in OpenShell.

## 4. Create and test your Paperclip environment

Select **OpenShell** as the environment's sandbox provider. With plugin defaults configured, its provider configuration can be empty:

```json
{}
```

Save the environment, run the draft **Test**, then **Test Provider**.

- **Test** resolves settings and checks gateway/workspace access, template identity and policy-file readability without allocating a sandbox. It does not validate policy YAML or boot the image.
- **Test Provider** creates a fresh sandbox, checks readiness, runtime tools and workspace writes, then uses Paperclip's test cleanup flow. Creation failures attempt bounded cleanup and report the failing phase.

Select the tested environment for your Paperclip agent/workspace. Paperclip transfers workspace files using its tar/base64 fallback and executes commands inside the sandbox.

Saving validates explicit fields; required inherited settings and reference existence are checked during Test and Test Provider. Configuration remains scoped to the invoking company.

## Optional overrides and runtime profiles

An environment can override shared defaults, for example:

```json
{
  "template": "paperclip-large",
  "providers": ["model-provider", "github-provider"]
}
```

For several reusable configurations, add plugin `profiles`:

```json
{
  "defaults": {
    "configHome": "/paperclip/.config",
    "gateway": "homelab",
    "template": "paperclip"
  },
  "profiles": {
    "large": { "template": "paperclip-large" },
    "retained": { "reuseLease": true }
  }
}
```

Then use `{ "profile": "large" }` in the environment. Settings resolve in this order: plugin defaults, selected plugin profile, explicit environment overrides. Arrays replace inherited arrays; `false` overrides `true`. Selecting a template clears inherited image/resource settings; selecting an image clears an inherited template. Empty optional text inherits its previous value.

| Setting               | Use                                                                           |
| --------------------- | ----------------------------------------------------------------------------- |
| `gateway`             | Registered OpenShell gateway; required after merging                          |
| `workspace`           | OpenShell namespace; defaults to `default`                                    |
| `template` or `image` | Existing sandbox template or tested runtime image; one required after merging |
| `configHome`          | Absolute XDG config directory accessible to the worker                        |
| `executable`          | CLI path or executable name; defaults to `openshell`                          |
| `providers`           | Existing OpenShell credential-provider instance names; defaults to `[]`       |
| `cpu`, `memory`       | Image-mode resource limits; e.g. `"2"`, `"4Gi"`                               |
| `timeoutMs`           | Per-operation budget; defaults to 300000 ms, range 1000–86400000              |
| `reuseLease`          | Retain sandboxes for reuse; defaults to `false`                               |
| `profile`             | Environment-only reference to a plugin runtime profile                        |
| `policyFile`          | Plugin defaults/profile only; absolute worker-local policy path               |
| `policyPreset`        | Reference to optional plugin `policies` YAML map                              |

Inline policy presets remain supported: put a complete YAML document in plugin `policies`, e.g. `{ "policies": { "development": "version: 1\n..." } }`, and select `policyPreset` in defaults, a profile or the environment. Replace the ellipsis with valid policy YAML. Use one of `policyFile` or `policyPreset` per settings object. A later selection replaces the inherited policy source. There is no explicit policy-disable override. Preset/profile names are case-sensitive, up to 64 ASCII letters, digits, underscores or hyphens, and start with a letter or digit.

Existing direct environment runtime settings and plugin profiles continue to work. Move legacy environment `policy`/`policyFile` into plugin settings. Policy changes apply to new allocations; manage existing sandbox policies through OpenShell. Cleanup does not require a removed policy, image or template. Successful leases save their connection details so cleanup can continue after their profile/defaults are removed. Changing a lease's gateway/workspace still fails ownership checks. Older failed-create records without saved connection details may need a recovery entry.

## When a test fails

| Error                                         | Action                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway not registered / `HOME` missing       | Check `configHome`, mounts and worker-user access; repeat the scoped list command from step 1                                                                   |
| Authentication, TLS or connection failure     | Repair gateway login/certificates/network access in the worker's OpenShell installation                                                                         |
| Template lookup failed                        | Check the template exists in the selected gateway/workspace                                                                                                     |
| Policy file cannot be read                    | Use an absolute file path mounted into the worker container with readable permissions                                                                           |
| Policy YAML rejected before allocation        | Fix the file/preset using the v0.1.2 schema and retry; no cleanup record is needed for recognized local rejections                                              |
| Credential provider unavailable               | Create/authenticate the provider instance and import its OpenShell profile in the selected workspace                                                            |
| Missing runtime tool / workspace not writable | Fix the image, user or filesystem policy and run Test Provider again                                                                                            |
| Configuration rejected by gateway             | Inspect gateway logs for policy, provider-profile or workload requirements; the plugin does not forward arbitrary CLI output because it may contain credentials |
| Ownership mismatch                            | Inspect sandbox ID and `paperclip-*` labels; restore the original scope and investigate name reuse or replacement                                               |

Temporary cleanup failures are retried within the acquisition budget; 10%, capped at 30 seconds, is reserved for cleanup. Every control operation verifies allocation identity and ownership labels. Names are 19 characters (`pc-` plus a UUID hash); the full attempt UUID is retained in labels.

### Recover an environment locked by pending cleanup

Upgrade/reload the plugin first. Paperclip's saved `driver`, `pluginId`, `pluginKey`, `sandboxProviderPlugin`, `failedCreateCleanup` and `pendingCleanupAttemptId` fields no longer block runtime parsing or cleanup. They are bookkeeping, not settings you need to enter.

If cleanup still cannot access its original gateway registration, add this to **plugin settings**, alongside defaults/profiles, while the environment is locked:

```json
{
  "cleanupRecovery": [
    {
      "environmentId": "your-paperclip-environment-id",
      "gateway": "homelab",
      "workspace": "default",
      "configHome": "/paperclip/.config"
    }
  ]
}
```

Use the exact environment ID and original gateway/workspace. Recovery settings repair cleanup access without editing the locked environment. Wait for Paperclip's cleanup sweep to retry, then remove the recovery entry when cleanup succeeds.

If creation timed out, was interrupted, or returned an unrecognized failure without an allocation ID, absence from a list does not prove it was rejected. The plugin keeps the attempt pending rather than clearing a possible late allocation. If a matching sandbox appears, the next sweep returns its verified ID for Paperclip to persist; a subsequent sweep can delete that allocation.

If gateway logs prove the original create was rejected and cannot complete later, add its full UUID to the recovery entry's `rejectedAttemptIds`. For the attempt in the reported logs, that field would be:

```json
{ "rejectedAttemptIds": ["01c71f6f-4810-4a41-841d-e7bcf8a26e1b"] }
```

Add this field inside the matching recovery entry only after confirming rejection. The plugin still requires a successful, complete scoped list proving absence. The `pc-...` sandbox name is not the attempt UUID. Errors include the UUID when it is needed. Older `paperclip-<UUID>` names exceeded OpenShell's name limit and reconcile automatically after a successful absence check. No manual database deletion is required.

If an upgrade still displays the previous version/schema, restart Paperclip, reinstall the intended package version, then refresh the UI. Releases use a version-specific manifest to avoid Paperclip's module cache retaining an old schema.

## Runtime behavior and limits

Ordinary release deletes ephemeral sandboxes and confirms absence. With `reuseLease: true`, release retains the sandbox and resume verifies it, starting it if stopped. Explicit destruction deletes it. Stop and `stop_and_retain` confirm `Stopped` and preserve files even for ephemeral leases; a failed stop never becomes deletion.

Commands run without a local shell or TTY, with explicit arguments, cwd and environment and closed stdin. Input is limited to **4 MiB UTF-8** and combined output to **16 MiB**. Exec output is returned to its authorized caller; lifecycle logs use sanitized diagnostics. Exit 124 means timeout, but cannot distinguish a deliberate exit 124. A local execution timeout does not prove remote termination; confirmed stop/destroy receipts do. Provider-enforced lease expiry, native sync and persistent process sessions are unsupported.

For source installation, test coverage, live verification and publishing, see [Development and releases](docs/development.md).
