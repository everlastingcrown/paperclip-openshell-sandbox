# Paperclip OpenShell sandbox provider

`@everlastingcrown/paperclip-openshell-sandbox` registers driver `openshell` as plugin `paperclip.openshell-sandbox-provider`. It targets **Paperclip / plugin-sdk v2026.1005.0**, **OpenShell v0.1.2**, and **Node ≥24.11.0** on the Paperclip host.

This is a standalone worker plugin using an installed OpenShell CLI. Operators supply a prebuilt runtime image; the plugin does not build images or create credential providers.

## Installation and host prerequisites

Install the published npm package through Paperclip's plugin management UI, then enable its `environment.drivers.register` capability. For a local development installation, run the commands below and install this directory through Paperclip's local plugin installer. Package metadata points Paperclip to `dist/manifest.js` and `dist/worker.js`.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
```

Installing development dependencies enables Husky Git hooks. Before each commit, lint-staged runs ESLint with automatic fixes followed by Prettier on staged JavaScript and TypeScript files. Prettier also formats staged JSON, Markdown, YAML, CSS, SCSS, and HTML files. The hook stages the fixes. Before each push, the hook runs `pnpm test` (unit and contract tests; no live sandbox required). You can also run `pnpm lint:fix` to apply lint fixes across the project or `pnpm format` to format the project with Prettier.

Install OpenShell v0.1.2 on the same host and under the same operating-system user as the Paperclip worker. Authenticate and configure a gateway before enabling the provider. Verify access under that user:

```sh
openshell --version
openshell gateway list --output json
openshell --gateway my-gateway --workspace default sandbox list --output json
```

The worker needs access to the CLI executable, its stored gateway metadata/authentication, and any configured policy file. Alternatively, supply the complete policy inline in the Environment provider configuration. Containerized Paperclip installations need those resources inside the host container. A gateway name is mandatory; every command supplies both gateway and workspace. The worker removes `OPENSHELL_GATEWAY_ENDPOINT` from subprocess environments so a host environment variable cannot override the named scope. Keep the gateway name bound to the same gateway while leases exist.

Paperclip starts plugin workers with a minimal environment that does not inherit the server's `HOME` or `XDG_CONFIG_HOME`. If gateway registration uses a custom XDG configuration directory, set `configHome` explicitly in the Environment provider configuration. For example, gateways stored under `/paperclip/.config/openshell/gateways` require `"configHome": "/paperclip/.config"`. This sets `XDG_CONFIG_HOME` for every OpenShell subprocess; the path is the parent of the `openshell` directory. The directory and its gateway authentication files must be accessible to the worker's OS user.

## Environment configuration

Select a sandbox environment with provider `openshell`, implemented by this plugin. Supply the following provider configuration (Paperclip may also store its own provider-selection fields):

```json
{
  "executable": "openshell",
  "configHome": "/paperclip/.config",
  "gateway": "my-gateway",
  "workspace": "default",
  "image": "registry.example.com/paperclip-runtime:tested",
  "policyFile": "/etc/paperclip/openshell-policy.yaml",
  "providers": ["existing-model-provider"],
  "cpu": "2",
  "memory": "4Gi",
  "timeoutMs": 300000,
  "reuseLease": false
}
```

| Field           | Default / behavior                                          |
| --------------- | ----------------------------------------------------------- |
| `executable`    | `openshell`; executable path or PATH name                   |
| `configHome`    | Optional absolute XDG configuration directory               |
| `gateway`       | Required stable gateway name                                |
| `workspace`     | `default`; OpenShell resource namespace                     |
| `image`         | Required prebuilt runtime image reference                   |
| `policy`        | Optional complete policy YAML string; excludes `policyFile` |
| `policyFile`    | Optional absolute host path to policy YAML                  |
| `providers`     | Existing credential-provider names; default `[]`            |
| `cpu`, `memory` | Optional OpenShell resource quantities                      |
| `timeoutMs`     | Operation budget, 300000 ms; range 1000–86400000            |
| `reuseLease`    | `false`; opt in to host lease retention and resume          |

To supply the entire policy in the environment configuration, replace `policyFile` with `policy`, containing your complete OpenShell YAML as a JSON string (encode line breaks as `\n`). For example, a YAML document beginning with `version: 1` starts as `"policy": "version: 1\n..."`; replace the ellipsis with the rest of your policy. The worker writes the exact text to a private temporary file for sandbox creation and removes it when the create command finishes, including on failure. No policy file needs to be provisioned in the Paperclip instance. OpenShell validates the policy contents. Supplying both nonempty `policy` and `policyFile` is rejected; empty or whitespace-only values are treated as omitted.

The remote workspace is `/sandbox/paperclip-workspace`. It is created before admission and returned as `remoteCwd`, with `bash` as the host shell. Sandbox identity and retention policy are recorded in lease metadata; credentials and command environments are never recorded there.

The runtime image must support noninteractive exec and permit its sandbox user to create and write the remote workspace. The plugin starts a persistent `/bin/sh` sleep loop as the canonical main process; it does not rely on a detached login shell remaining alive after stdin closes. Include `sh`, `bash`, `node`, `git`, `tar`, `base64`, `cat`, `mkdir`, `rm`, `mv`, `chmod`, `find`, `dd`, `wc`, `basename`, `awk`, `sed`, `head`, `tail`, `touch`, `cp`, `ln`, and `sleep`. Acquisition checks tool availability and workspace writability and reports the first missing tool. Include the agent CLI and language runtimes required by your Paperclip adapter and workload; those workload-specific tools are the operator's responsibility. `curlimages/curl` is rejected during validation and admission because it lacks the required runtime tools; changing CPU or memory cannot make it a Paperclip runtime.

For a provider smoke test, `node:22-bookworm` passed live allocation, all required tool/workspace checks, Node execution and confirmed deletion on the `homelab` gateway with `cpu: "1"`, `memory: "512Mi"` and `configHome: "/paperclip/.config"`. This verifies the provider prerequisites; build in your adapter's agent CLI and workload dependencies before running agents. Pin your production image to a tested digest.

The policy must permit these tools, workspace writes, agent execution, and the required outbound endpoints. Creation explicitly uses `--approval-mode manual` and `--no-auto-providers`. Create and authenticate credential providers separately; attach their names with `providers`. Credentials remain managed by OpenShell. Omitting both `policy` and `policyFile` uses OpenShell's configured/default policy. Review agent-authored policy proposals using OpenShell's normal manual approval process.

## Lease and execution behavior

Sandboxes get 19-character names (`pc-` plus a hash of a random UUID) and provider/company/environment/attempt ownership labels. The full UUID stays in the attempt label. OpenShell v0.1.2 rejects sandbox names longer than 19 characters before allocation. Acquisition checks scoped gateway access before creating a sandbox, waits for readiness and checks runtime prerequisites. Inspection validates OpenShell JSON, including paginated lists. A successful list that omits the sandbox expires a reusable lease; failed authentication, transport, malformed JSON, or ownership changes remain errors.

Ephemeral release and explicit destruction delete the verified allocation and poll until it is absent. Retained release leaves the sandbox running. A retained stopped sandbox is started and verified ready on resume. A cancellation stops and retains a reusable lease, or destroys an ephemeral lease, and returns a confirmed termination receipt. Disabling `reuseLease` expires retained leases on resume and destroys them on release. Normal destruction is idempotent when the verified allocation is already absent.

The separate stop hook, and release with `resourceDisposition: "stop_and_retain"`, call OpenShell's stop operation and require confirmation of `Stopped`. They preserve files even for ephemeral leases. Failed or unconfirmed stops throw and never substitute deletion. Sandboxes are created with OpenShell's default keep behavior; no automatic deletion is configured.

The declared [capability contract](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/doc/plugins/SANDBOX_PROVIDER_CAPABILITIES.md) enables reusable leases and independent control commands. Native sync, persistent process sessions, and incremental session output are explicitly disabled. Paperclip uses its existing tar/base64 exec fallback in both directions, including bounded 4 MiB base64 input chunks.

Each command uses argument arrays with `shell: false`, `sandbox exec --no-tty --no-login-shell`, explicit cwd, environment, stdin, and a remote timeout. The plugin closes stdin even when empty, captures stdout/stderr and exit status, bounds combined output at 16 MiB, and terminates the local CLI process group on deadline (TERM followed by KILL). Input over **4 MiB in UTF-8 bytes** is rejected before execution. Output overflow throws instead of silently truncating. Concurrent control commands use separate CLI subprocesses.

OpenShell v0.1.2 reports remote timeouts as exit 124 with no separate timeout flag; `timedOut` is true for exit 124 and local timeout. A command deliberately returning 124 is therefore indistinguishable. The remote CLI timeout rounds up to whole seconds; a locally timed-out command may take that additional fraction of a second to reach its remote deadline. A timeout does not attest remote termination; only confirmed stop/destroy receipts do. CLI transport failures and remote nonzero exit codes share an exit-status interface for exec, so exec preserves the CLI's stdout/stderr/status for the caller. Lifecycle errors use sanitized messages.

Requested provider-enforced expiry is rejected **before allocation**: this CLI integration cannot guarantee a sandbox lifetime deadline. Operation timeouts are not lease expiry.

Failed acquisition attempts clean up owned allocations within the acquisition budget (10%, capped at 30 seconds, is reserved for cleanup). Failures before create and recognized rejections that prove no allocation was possible do not create cleanup records. If allocation or cleanup remains uncertain, the worker returns the SDK's structured creation-cleanup error with nonsecret ownership evidence. Paperclip persists that record and retries destruction. An unobserved allocation is first matched by scope/name/labels and returned as an updated structured error containing its observed ID; a subsequent retry uses the durably recorded ID. An unobserved allocation that remains absent stays pending because a late creation cannot be ruled out. The exception is legacy `paperclip-<UUID>` names: those 46-character requests were rejected by v0.1.2's name validation and cannot appear later. After a successful scoped list confirms absence, the cleanup hook returns a destruction receipt, allowing Paperclip's sweep to clear those old records. Gateway/list failures and ownership mismatches still block reconciliation.

## Testing and troubleshooting

Unit tests cover configuration, CLI flags, execution, malformed JSON, subprocess failures/limits, ownership, missing leases, failed creation cleanup, reuse, and stop-only preservation. Contract tests validate the manifest with the pinned shared schema and initialize a real SDK worker to inspect its advertised RPC methods. `check:package` packs and installs the tarball into an offline temporary consumer, imports every public entrypoint, compiles a TypeScript consumer, and checks manifest/package version equality.

The live test is opt-in and uses the **actual v2026.1005.0 host fallback**, including workspace sync in/out and a multi-chunk binary transfer. It creates and destroys one sandbox. Use an installed, clean Paperclip checkout at tag `v2026.1005.0`, an authenticated available gateway, and a suitable image:

```sh
OPENSHELL_SMOKE_CONFIG=/absolute/path/to/provider-config.json \
PAPERCLIP_SOURCE=/absolute/path/to/paperclip \
pnpm test:live
```

Without both variables it reports `SKIP`. Ordinary tests require no gateway. Live coverage must be reported separately from unit/contract validation.

Draft **Test** calls the plugin's probe hook. It validates configuration and checks scoped gateway access without creating a sandbox, returning diagnostics rather than throwing an internal server error. A successful draft test does not prove image boot or runtime tools; **Test Provider** performs fresh allocation and runtime checks.

For lifecycle failures, the error identifies the operation, exit status, gateway, workspace and config directory, with recognized hints for missing registration, TLS, network and permission failures. Acquisition failures include the original failure and, when applicable, the separate cleanup failure and sandbox name. Structured logs in Paperclip's plugin health dashboard record the phase and ownership scope. Arbitrary CLI stdout/stderr is not copied into lifecycle errors or logs because it can contain credentials. Exec still returns its stdout/stderr to the authorized caller.

Run the scoped list/get commands under the Paperclip worker's OS user, verify authentication and gateway access, and inspect the named sandbox's phase and labels. Runtime setup failures usually indicate a missing tool, an exited main process, unwritable workspace, or policy denial. Ownership mismatches require operator investigation; the plugin refuses to control a replacement sandbox. Avoid gateway rebinding or manual name reuse while leases or pending cleanup records exist.

If an older plugin failed with these settings (`cpu: 1`, `memory: 512Mi`, `image: curlimages/curl:8.21.0`, `gateway: homelab`, `configHome: /paperclip/.config`), upgrade/reload the plugin first. The missing probe hook caused draft Test's internal error, and the oversized generated name caused allocation rejection and permanently pending cleanup. After upgrade, leave the provider scope unchanged while Paperclip's cleanup sweep reconciles the legacy attempts. Then replace the curl image with a runtime image containing the required tools and your agent CLI, save, run Test, and run Test Provider. No manual database deletion is needed for those rejected legacy names. CPU accepts a positive number or a string quantity; `1` and `"1"` both normalize to `"1"`.

If manual CLI access works but a gateway preflight fails, check whether the worker can find the registered gateway. A custom server `XDG_CONFIG_HOME` is not inherited by plugin workers; configure `configHome` as described above.

If installing a newer plugin reports the previous version and the Environment form still has the previous fields, restart the Paperclip server and reinstall the intended version, then refresh the UI. Paperclip 2026.1005.0 caches manifest modules by path and modification time; npm tarballs normalize modification times, and imported schema/version modules also remain cached across uninstall/reinstall. Releases built with the version-specific, self-contained manifest entrypoint avoid this stale cache. Restarting alone may leave the previously saved manifest in the database, so reinstall after restarting.

### Recover cleanup while environment settings are locked

Paperclip can prevent saving an Environment while its lease is pending cleanup. Old leases also use their recorded provider configuration, so changing the Environment does not necessarily repair their CLI config directory. Configure `cleanupRecovery` in the **OpenShell plugin settings**, independently of the Environment:

```json
{
  "cleanupRecovery": [
    {
      "environmentId": "52e7ba17-a1aa-46ea-bbf4-007c41a00c70",
      "gateway": "gateway",
      "workspace": "default",
      "configHome": "/paperclip/.config"
    }
  ]
}
```

The worker reads these settings for the invoking company on every destroy or stop attempt. Matching requires the exact Environment ID, gateway and workspace. Only the cleanup config directory is overridden; sandbox identity and ownership labels still have to match. This also applies to `stop_and_retain`, which still stops and preserves the sandbox. Recovery settings do not change acquisition or execution configuration. Once cleanup completes, save the corrected Environment settings and remove the recovery entry.

If a failed creation never returned an allocation ID and scoped lists keep showing no sandbox, automatic cleanup remains pending: a generic CLI exit 1 cannot prove that the gateway rejected creation. After verifying the original creation was rejected and cannot create a sandbox later, add its **full attempt UUID** to `rejectedAttemptIds` in the matching recovery entry. Obtain that UUID from the lease's `failedCreateCleanup.attemptId` or the updated destroy error; the `pc-...` name is a hash, not the UUID. For example:

```json
{
  "cleanupRecovery": [
    {
      "environmentId": "c2346834-7ad0-4044-8c95-03ed42b7b9fb",
      "gateway": "gateway",
      "workspace": "default",
      "configHome": "/paperclip/.config",
      "rejectedAttemptIds": ["00000000-0000-0000-0000-000000000000"]
    }
  ]
}
```

Replace the example UUID with the actual attempt UUID. Reconciliation requires a successful, complete scoped list confirming absence and logs the operator confirmation. List failures, malformed responses and ownership mismatches remain pending. If a matching sandbox appears, the provider returns its observed ID for Paperclip to persist before a subsequent retry deletes it, even if the attempt was marked rejected. There is no age-based automatic clearance of uncertain allocations. Remove the attempt confirmation after reconciliation.

## Releases and npm publisher setup

Conventional commits drive semantic-release: `fix:` makes patch releases, `feat:` makes minor releases, and breaking-change commits make major releases. `main` publishes stable versions; `canary` publishes `-canary` prereleases on the `canary` npm tag. GitHub releases contain generated release notes. Publishing and npm/GitHub account configuration are separate operator actions.

Husky's `commit-msg` hook enforces Conventional Commits for every new commit, including messages that commitlint normally ignores (such as merge and fixup messages). Use messages such as `feat: add a provider option`, `fix(cli): handle timeouts`, or `chore: update dependencies`. Pull-request CI also checks every commit in the PR. To check a commit range manually, run `pnpm commitlint --from <base-sha> --to HEAD --verbose`.

Compared with the [Slack plugin template](https://github.com/everlastingcrown/paperclip-slack-plugin), this repository adds:

- Read-only pull-request checks for types, tests, build, and installed tarball validation, to catch broken public exports before merge.
- Separate validation and release jobs; only release receives repository write permissions and `id-token: write`.
- Actions pinned to immutable commit SHAs, Node 24.15.0, pnpm 10.33.2, and a frozen lockfile.
- A publication queue shared across both branches to serialize stable and prerelease publication.
- A preparation hook **after** the npm plugin sets the package version. It rebuilds the manifest from `package.json` and repeats packed-consumer validation before publication. This avoids shipping the development manifest version.
- npm trusted publishing and provenance with npm 11.6.2, pinned as a development dependency and pnpm override so semantic-release uses the same OIDC-capable CLI. No npm token is configured in release CI.

Configure the package's npm trusted publisher for GitHub Actions with owner `everlastingcrown`, repository `paperclip-openshell-sandbox`, and workflow filename **`release.yml`** (without `.github/workflows/`). Leave the environment field empty because this workflow does not use a GitHub environment. Permit direct publication and dist-tag management where npm presents those options. Use GitHub-hosted runners and keep the repository URL in `package.json` aligned with this repository. The workflow grants OIDC permission only to the release job. See [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/).

For a new package that does not yet have package settings, an authorized maintainer must first publish a bootstrap version using their normal npm authentication and any required 2FA. Use a valid unique package version, build and check the tarball, then publish publicly. Configure trusted publishing after the package exists, and ensure semantic-release's release tags reflect any bootstrap version so it does not republish it. Future automated releases use OIDC; do not store a bootstrap token in this workflow. No publication or external account configuration is performed by the development checks.
