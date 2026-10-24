# Duplex validation record

Implementation prepared 2026-10-24. Rollout remains disabled by default.

- SDK/shared: **2026.1005.0**, unchanged dependencies.
- OpenShell: installed CLI reports **0.1.2**. Inspected `ssh-proxy --help`,
  `sandbox ssh-config --help`, and the pinned CLI
  [SSH implementation](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/ssh.rs).
  Name mode creates a fresh authenticated SSH relay session scoped by gateway and
  workspace. The supervisor's non-login signal is `OPENSHELL_NO_LOGIN_SHELL=1`.
- Paperclip baseline: tag **v2026.1005.0**, Git object
  `467125fafb47a8520856504fecc48d6e32055db1`. Reviewed baseline
  adapter-utils transport selection, bounded readiness fallback and established
  loss behavior with `git show`, without modifying host source.
- Available local Paperclip checkout: revision
  `07c48fe10fd810f54100b55571dd02ba7ab08d8b` (newer than baseline).
  This is a reference checkout, not verified as the deployment's actual revision.
  Record the actual deployed revision during live acceptance.
- The pinned SDK exposes hook types through public `protocol` and `types`
  subpaths; they are not all re-exported from its root. No SDK upgrade was needed.

Validation uses Node **24.15.0** and pnpm **10.33.2** outside the restricted
subprocess sandbox, which otherwise produces empty child-process pipes/EPERM.
Lint, source typechecking, all 115 tests, build and packed-consumer validation pass.
The suite includes real SDK worker RPC method discovery, binary notifications,
exit/close acknowledgements and unchanged ordinary execution. Transport tests
exercise slow stdin, queue bounds, startup cancellation, lookup timeout, stale
lifecycle validation and process-group cleanup. These are local tests with fake
gateway responses and local subprocesses, not live OpenShell validation.

Attempted unchanged host tests:

```sh
# from the available Paperclip server directory
./node_modules/.bin/vitest run \
  src/__tests__/environment-execution-target-duplex-kill-switch.test.ts \
  src/__tests__/environment-execution-target-duplex.test.ts \
  src/__tests__/plugin-worker-manager-duplex.test.ts
```

Not executed: the installed command shim points to a missing
`server/node_modules/vitest/vitest.mjs` (`MODULE_NOT_FOUND`). No Paperclip source,
tests, dependencies, settings or deployment were changed. Full host selection,
UI/schema rendering and slow host-consumer integration remain acceptance items.
Provider opt-out, independent environment scope, unknown leases, config refresh,
startup failures and teardown behavior are covered in this repository.

`pnpm test:live -- --duplex` reports **SKIP** without `OPENSHELL_SMOKE_CONFIG`
and `PAPERCLIP_SOURCE`. The explicit duplex mode checks the worker's SSH client,
binary round trips, idle stdin and route-only cleanup on a fresh designated smoke
sandbox, then runs the existing retention/sync checks. It does not replace the
real OpenCode callback acceptance workflow.

Before rollout, complete the handoff's two-setting activation against the actual
unchanged deployment, observe host readiness/fallback, test established loss
without replay, and compare exec starts over at least 20 minutes with Stream run
logs off. Verify callbacks after idle and retained files after a designated test
sandbox stop/start. Record exec reduction, gateway traffic and latency here.
No live exec counts or latency measurements are claimed yet.
