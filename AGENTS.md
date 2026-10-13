# Repository guide

## Architecture and layout

This ESM TypeScript package registers Paperclip's `openshell` sandbox driver. It targets Paperclip/plugin-sdk **2026.1005.0**, OpenShell CLI **0.1.2**, and Node **>=24.11.0**. The worker invokes an installed CLI; operators supply runtime images and authenticated credential providers.

- `src/plugin.ts`: SDK hooks; `src/worker.ts`: worker startup; `src/index.ts`: public exports.
- `src/provider.ts`: SDK orchestration, reuse, stop/destroy/reconciliation, workspace realization, and execution.
- `src/acquisition.ts`: creation outcomes, runtime admission, and cleanup evidence.
- `src/identity.ts`: response parsing, ownership, and persisted lease/recovery identities.
- `src/sandbox-client.ts`: scoped commands, paginated lookup, polling, shared cleanup retries, and execution.
- `src/config.ts`: direct configuration/schema; no profiles, defaults or policy generation.
- `src/recovery.ts`: optional operator cleanup recovery; `src/logging.ts`: non-throwing diagnostics; `src/deadline.ts`: budgets and injectable clock.
- `src/cli.ts`: scoped CLI arguments, subprocess deadlines, I/O limits, JSON parsing, and sanitized lifecycle errors.
- `src/manifest.ts`: identity and advertised capabilities.
- `test/*.test.ts`: suites for configuration/policy, acquisition, CLI/processes, lease lifecycle, recovery, and hardening regressions. `test/helpers.ts` supplies a typed fake CLI that dispatches by the scoped operation; `test/contract.test.ts` checks the manifest schema and real SDK worker RPC contract.
- `scripts/`: build, packed-consumer validation, release preparation, and opt-in live smoke test.
- `.github/workflows/`: PR validation and semantic-release; `README.md`: detailed operator configuration and troubleshooting.

`dist/` is generated and ignored. Build regenerates `src/version.ts` from `package.json`; do not edit it manually. Use `.js` suffixes in TypeScript relative imports (NodeNext).

## Development workflow

Use pnpm **10.33.2**; CI runs Node **24.15.0**. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
```

Ordinary tests need no gateway. Build before `check:package`, which installs the packed tarball into a temporary consumer using `--prefer-offline` (missing registry metadata/packages may require network access) and checks exports, types, worker startup, and version consistency. Typechecking covers `src/`; tests execute through `tsx`.

Live verification requires `OPENSHELL_SMOKE_CONFIG` (absolute JSON config path) and `PAPERCLIP_SOURCE` (installed clean Paperclip checkout at `v2026.1005.0`), then `pnpm test:live`. It creates and destroys a real sandbox and exercises host sync fallbacks. Missing variables produce `SKIP`; report live coverage separately.

Use a dedicated branch and PR for changes; include behavior changes and validation evidence. PR and release validation both run ESLint. Husky formats/fixes staged files before commits, enforces Conventional Commits, and runs tests before pushes. `fix:`/`feat:`/breaking changes drive releases. `main` publishes stable versions; `canary` publishes prereleases. Release preparation rebuilds and validates after version assignment.

## Key gotchas

- Keep gateway/workspace scope explicit. Workers have minimal environments: custom gateway registration needs `configHome`, the parent of the `openshell` config directory. CLI subprocesses remove `OPENSHELL_GATEWAY_ENDPOINT`.
- Creation outcome is tracked independently of errors. Only the create invocation can establish definitive rejection; readiness/runtime failures after creation must clean up or return structured reconciliation evidence. Persist verified IDs and keep cleanup independent of current runtime configuration.
- Reject exhausted deadlines before any runner call. Keep a fresh bounded cleanup budget after acquisition failure. Tests can inject the internal client clock without changing the public provider constructor.
- Complete and validate every list page before returning a match or confirming absence. Duplicate matches, repeated tokens, malformed later pages, and pagination-limit exhaustion fail closed.
- Verify allocation ID and ownership labels before control operations. Preserve structured creation-cleanup errors and reconciliation behavior; uncertain allocation absence must not silently count as successful cleanup.
- Stop and `stop_and_retain` must confirm `Stopped` and preserve files, including ephemeral leases. Never substitute deletion for a failed stop. Provider-enforced lease expiry is unsupported and rejected before allocation.
- Sandbox names must fit OpenShell's 19-character limit. The remote workspace is `/sandbox/paperclip-workspace`; images need the tools declared in `src/config.ts` and a persistent main process. `curlimages/curl` is unsuitable.
- Exec uses argument arrays with `shell: false`, noninteractive remote execution, and closed stdin. Preserve 4 MiB UTF-8 stdin and 16 MiB combined-output limits. Exit 124 indicates timeout ambiguously; execution timeout alone does not confirm remote termination.
- Native sync and persistent sessions are disabled; Paperclip supplies tar/base64 sync fallback. Keep manifest capabilities aligned with implementation and contract tests.
- Keep valid persisted metadata and public exports compatible. Construct validated ownership envelopes; never spread untrusted failed-create metadata into SDK errors. Attempt UUIDs use the canonical lowercase 8-4-4-4-12 shape and observed IDs must be nonempty.
- Lifecycle errors/logs must sanitize CLI output and exclude credentials; exec output is returned to its authorized caller.
