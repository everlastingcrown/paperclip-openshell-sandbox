# Verified upstream contracts

This implementation was reviewed against the pinned versions, not inferred from current Paperclip behavior.

- [Paperclip environment probe, v2026.1005.0](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/environment-probe.ts): Test Provider sets `reuseLease: false` and `archiveOnRelease: true`, acquires through the environment runtime, and releases in `finally`. The non-allocating draft probe uses the plugin probe hook.
- [Paperclip plugin environment driver](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/plugin-environment-driver.ts): validation returns `normalizedConfig` or preserves the input; sandbox routing passes provider settings to the plugin.
- [Paperclip environment runtime](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/environment-runtime.ts): failed teardown enters `pending_cleanup`; the host records structured failed-create evidence, persists a newly observed identity before destructive reconciliation, and retries cleanup. The provider must throw on unconfirmed deletion. It cannot truthfully reset host state during a gateway outage.
- The installed `@paperclipai/plugin-sdk@2026.1005.0` protocol, cleanup-error serializer, and worker RPC host were inspected locally. Tests validate the manifest against `@paperclipai/shared` and initialize the real SDK worker.
- [OpenShell CLI arguments, v0.1.2](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/main.rs): `--template` conflicts with inline workload flags; policy/provider flags remain separate. Noninteractive create/exec, explicit workspace and gateway, labels, structured output and manual approval mode are supported.
- [OpenShell create implementation](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/run.rs): templates resolve workload shape in the gateway; the CLI loads policy and resolves providers before `CreateSandbox`. The structured provisioning marker occurs after allocation. A timeout or lost response does not prove rejection.

Ownership, pagination completeness, process I/O limits and stop preservation remain enforced. Simplification removes provider configuration layers and local policy authoring, rather than removing the checks that prevent deleting another sandbox or losing track of an uncertain allocation.
