# Development and releases

Use Node 24.15.0 and pnpm 10.33.2. From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
```

Unit and contract tests need no gateway. The packed-consumer check installs the built tarball in a temporary project, checks exports and TypeScript declarations, starts the real SDK worker, and verifies package/manifest versions. It may need registry access.

Husky formats and lints staged files, checks Conventional Commits, and runs tests before pushes. Keep changes on a focused branch and open a PR; CI repeats validation.

For live verification, use an authenticated gateway and a clean, installed Paperclip checkout at `v2026.1005.0`:

```sh
OPENSHELL_SMOKE_CONFIG=/absolute/path/to/environment-config.json \
PAPERCLIP_SOURCE=/absolute/path/to/paperclip \
pnpm test:live
```

This creates and destroys a real sandbox and exercises Paperclip's tar/base64 workspace fallback, including a multi-chunk binary transfer. The JSON file uses direct environment settings (gateway, image or template, and optional configHome). Without both variables, the script reports `SKIP`. Report live coverage separately.

## Releases and npm publisher setup

Conventional commits drive semantic-release: `fix:` makes patch releases, `feat:` makes minor releases, and `feat!:` (or another type with `!`, such as `fix(cli)!:`) makes major releases. Mark breaking changes with `!` immediately before the colon; no `BREAKING CHANGE:` footer is required. Commit analysis and release notes both use the Conventional Commits preset. `main` publishes stable versions; `canary` publishes `-canary` prereleases on the `canary` npm tag. GitHub releases contain generated release notes. Publishing and npm/GitHub account configuration are separate operator actions.

Husky's `commit-msg` hook enforces Conventional Commits for every new commit, including messages that commitlint normally ignores (such as merge and fixup messages). Use messages such as `feat: add a provider option`, `feat!: change the configuration format`, `fix(cli): handle timeouts`, or `chore: update dependencies`. Pull-request CI also checks every commit in the PR. To check a commit range manually, run `pnpm commitlint --from <base-sha> --to HEAD --verbose`.

Configure the package's npm trusted publisher for GitHub Actions with owner `everlastingcrown`, repository `paperclip-openshell-sandbox`, and workflow filename **`release.yml`** (without `.github/workflows/`). Leave the environment field empty because this workflow does not use a GitHub environment. Permit direct publication and dist-tag management where npm presents those options. Use GitHub-hosted runners and keep the repository URL in `package.json` aligned with this repository. The workflow grants OIDC permission only to the release job. See [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/).

For a new package that does not yet have package settings, an authorized maintainer must first publish a bootstrap version using their normal npm authentication and any required 2FA. Use a valid unique package version, build and check the tarball, then publish publicly. Configure trusted publishing after the package exists, and ensure semantic-release's release tags reflect any bootstrap version so it does not republish it. Future automated releases use OIDC; do not store a bootstrap token in this workflow. No publication or external account configuration is performed by the development checks.
