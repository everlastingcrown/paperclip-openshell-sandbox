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

Installing development dependencies enables Husky Git hooks. Before each commit, lint-staged runs ESLint with automatic fixes followed by Prettier on staged JavaScript and TypeScript files. Prettier also formats staged JSON, Markdown, YAML, CSS, SCSS, and HTML files. The hook stages the fixes. Before each push, the hook runs `pnpm test` (unit and contract tests; no live sandbox required). You can also run `pnpm lint:fix` to apply lint fixes across the project.

Install OpenShell v0.1.2 on the same host and under the same operating-system user as the Paperclip worker. Authenticate and configure a gateway before enabling the provider. Verify access under that user:

```sh
openshell --version
openshell gateway list --output json
openshell --gateway my-gateway --workspace default sandbox list --output json
```

The worker needs access to the CLI executable, its stored gateway metadata/authentication, and any policy file. Containerized Paperclip installations need those resources inside the host container. A gateway name is mandatory; every command supplies both gateway and workspace. The worker removes `OPENSHELL_GATEWAY_ENDPOINT` from subprocess environments so a host environment variable cannot override the named scope. Keep the gateway name bound to the same gateway while leases exist.

## Environment configuration

Select a sandbox environment with provider `openshell`, implemented by this plugin. Supply the following provider configuration (Paperclip may also store its own provider-selection fields):

```json
{
  "executable": "openshell",
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

| Field           | Default / behavior                                 |
| --------------- | -------------------------------------------------- |
| `executable`    | `openshell`; executable path or PATH name          |
| `gateway`       | Required stable gateway name                       |
| `workspace`     | `default`; OpenShell resource namespace            |
| `image`         | Required prebuilt runtime image reference          |
| `policyFile`    | Optional absolute host path to policy YAML         |
| `providers`     | Existing credential-provider names; default `[]`   |
| `cpu`, `memory` | Optional OpenShell resource quantities             |
| `timeoutMs`     | Operation budget, 300000 ms; range 1000–86400000   |
| `reuseLease`    | `false`; opt in to host lease retention and resume |

The remote workspace is `/sandbox/paperclip-workspace`. It is created before admission and returned as `remoteCwd`, with `bash` as the host shell. Sandbox identity and retention policy are recorded in lease metadata; credentials and command environments are never recorded there.

The runtime image must keep its canonical main process alive, support noninteractive exec, and permit its sandbox user to create and write the remote workspace. Include `sh`, `bash`, `node`, `git`, `tar`, `base64`, `cat`, `mkdir`, `rm`, `mv`, `chmod`, `find`, `dd`, `wc`, `basename`, `awk`, `sed`, `head`, `tail`, `touch`, `cp`, `ln`, and `sleep`. Acquisition checks tool availability and workspace writability. Include the agent CLI and language runtimes required by your Paperclip adapter and workload; those workload-specific tools are the operator's responsibility.

The policy must permit these tools, workspace writes, agent execution, and the required outbound endpoints. Creation explicitly uses `--approval-mode manual` and `--no-auto-providers`. Create and authenticate credential providers separately; attach their names with `providers`. Credentials remain managed by OpenShell. An omitted policy file uses OpenShell's configured/default policy. Review agent-authored policy proposals using OpenShell's normal manual approval process.

## Lease and execution behavior

Sandboxes get UUID-based names and provider/company/environment/attempt ownership labels. Acquisition waits for readiness and checks runtime prerequisites. Inspection validates OpenShell JSON, including paginated lists. A successful list that omits the sandbox expires a reusable lease; failed authentication, transport, malformed JSON, or ownership changes remain errors.

Ephemeral release and explicit destruction delete the verified allocation and poll until it is absent. Retained release leaves the sandbox running. A retained stopped sandbox is started and verified ready on resume. A cancellation stops and retains a reusable lease, or destroys an ephemeral lease, and returns a confirmed termination receipt. Disabling `reuseLease` expires retained leases on resume and destroys them on release. Normal destruction is idempotent when the verified allocation is already absent.

The separate stop hook, and release with `resourceDisposition: "stop_and_retain"`, call OpenShell's stop operation and require confirmation of `Stopped`. They preserve files even for ephemeral leases. Failed or unconfirmed stops throw and never substitute deletion. Sandboxes are created with OpenShell's default keep behavior; no automatic deletion is configured.

The declared [capability contract](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/doc/plugins/SANDBOX_PROVIDER_CAPABILITIES.md) enables reusable leases and independent control commands. Native sync, persistent process sessions, and incremental session output are explicitly disabled. Paperclip uses its existing tar/base64 exec fallback in both directions, including bounded 4 MiB base64 input chunks.

Each command uses argument arrays with `shell: false`, `sandbox exec --no-tty --no-login-shell`, explicit cwd, environment, stdin, and a remote timeout. The plugin closes stdin even when empty, captures stdout/stderr and exit status, bounds combined output at 16 MiB, and terminates the local CLI process group on deadline (TERM followed by KILL). Input over **4 MiB in UTF-8 bytes** is rejected before execution. Output overflow throws instead of silently truncating. Concurrent control commands use separate CLI subprocesses.

OpenShell v0.1.2 reports remote timeouts as exit 124 with no separate timeout flag; `timedOut` is true for exit 124 and local timeout. A command deliberately returning 124 is therefore indistinguishable. The remote CLI timeout rounds up to whole seconds; a locally timed-out command may take that additional fraction of a second to reach its remote deadline. A timeout does not attest remote termination; only confirmed stop/destroy receipts do. CLI transport failures and remote nonzero exit codes share an exit-status interface for exec, so exec preserves the CLI's stdout/stderr/status for the caller. Lifecycle errors use sanitized messages.

Requested provider-enforced expiry is rejected **before allocation**: this CLI integration cannot guarantee a sandbox lifetime deadline. Operation timeouts are not lease expiry.

Failed acquisition attempts clean up owned allocations within the acquisition budget (10%, capped at 30 seconds, is reserved for cleanup). If allocation or cleanup remains uncertain, the worker returns the SDK's structured creation-cleanup error with nonsecret ownership evidence. Paperclip persists that record and retries destruction. An unobserved allocation is first matched by scope/name/labels and returned as an updated structured error containing its observed ID; a subsequent retry uses the durably recorded ID. An unobserved allocation that remains absent stays pending because a late creation cannot be ruled out. Operators must reconcile permanently uncertain attempts rather than deleting by an unverified name.

## Testing and troubleshooting

Unit tests cover configuration, CLI flags, execution, malformed JSON, subprocess failures/limits, ownership, missing leases, failed creation cleanup, reuse, and stop-only preservation. Contract tests validate the manifest with the pinned shared schema and initialize a real SDK worker to inspect its advertised RPC methods. `check:package` packs and installs the tarball into an offline temporary consumer, imports every public entrypoint, compiles a TypeScript consumer, and checks manifest/package version equality.

The live test is opt-in and uses the **actual v2026.1005.0 host fallback**, including workspace sync in/out and a multi-chunk binary transfer. It creates and destroys one sandbox. Use an installed, clean Paperclip checkout at tag `v2026.1005.0`, an authenticated available gateway, and a suitable image:

```sh
OPENSHELL_SMOKE_CONFIG=/absolute/path/to/provider-config.json \
PAPERCLIP_SOURCE=/absolute/path/to/paperclip \
pnpm test:live
```

Without both variables it reports `SKIP`. Ordinary tests require no gateway. Live coverage must be reported separately from unit/contract validation.

For lifecycle failures, run the scoped list/get commands under the Paperclip worker's OS user, verify authentication and gateway access, and inspect the named sandbox's phase and labels. Runtime setup failures usually indicate a missing tool, an exited main process, unwritable workspace, or policy denial. Ownership mismatches require operator investigation; the plugin refuses to control a replacement sandbox. Avoid gateway rebinding or manual name reuse while leases or pending cleanup records exist.

## Releases and npm publisher setup

Conventional commits drive semantic-release: `fix:` makes patch releases, `feat:` makes minor releases, and breaking-change commits make major releases. `main` publishes stable versions; `canary` publishes `-canary` prereleases on the `canary` npm tag. GitHub releases contain generated release notes. Publishing and npm/GitHub account configuration are separate operator actions.

Compared with the [Slack plugin template](https://github.com/everlastingcrown/paperclip-slack-plugin), this repository adds:

- Read-only pull-request checks for types, tests, build, and installed tarball validation, to catch broken public exports before merge.
- Separate validation and release jobs; only release receives repository write permissions and `id-token: write`.
- Actions pinned to immutable commit SHAs, Node 24.15.0, pnpm 10.33.2, and a frozen lockfile.
- A publication queue shared across both branches to serialize stable and prerelease publication.
- A preparation hook **after** the npm plugin sets the package version. It rebuilds the manifest from `package.json` and repeats packed-consumer validation before publication. This avoids shipping the development manifest version.
- npm trusted publishing and provenance with npm 11.6.2, pinned as a development dependency and pnpm override so semantic-release uses the same OIDC-capable CLI. No npm token is configured in release CI.

Configure the package's npm trusted publisher for GitHub Actions with owner `everlastingcrown`, repository `paperclip-openshell-sandbox`, and workflow filename **`release.yml`** (without `.github/workflows/`). Leave the environment field empty because this workflow does not use a GitHub environment. Permit direct publication and dist-tag management where npm presents those options. Use GitHub-hosted runners and keep the repository URL in `package.json` aligned with this repository. The workflow grants OIDC permission only to the release job. See [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/).

For a new package that does not yet have package settings, an authorized maintainer must first publish a bootstrap version using their normal npm authentication and any required 2FA. Use a valid unique package version, build and check the tarball, then publish publicly. Configure trusted publishing after the package exists, and ensure semantic-release's release tags reflect any bootstrap version so it does not republish it. Future automated releases use OIDC; do not store a bootstrap token in this workflow. No publication or external account configuration is performed by the development checks.
