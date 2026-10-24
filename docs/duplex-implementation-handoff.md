# Duplex transport implementation handoff

Status: implementation plan; no duplex implementation is included in this change.
Prepared 2026-10-24. Baseline: Paperclip/plugin-sdk **2026.1005.0**, OpenShell
**0.1.2**, Node **>=24.11.0**, pnpm **10.33.2**.

## Outcome and scope

Implement Paperclip's existing duplex command-channel contract in this provider.
Use one persistent SSH command for a callback bridge, rather than launching an
OpenShell execution for each callback queue poll. Continue using the provider's
existing native execution-output streaming and ordinary execution path.

Expose an environment-specific **Enable duplex callback bridge** checkbox in
the OpenShell provider configuration. Default it to off. The checkbox remains
editable independently of Paperclip's instance setting. Its description must
explain that duplex activates only when an instance admin also enables
`enableSandboxDuplexBridge` through the existing API. The plugin must not modify
instance settings itself. All implementation changes stay in this repository;
no Paperclip source, UI, SDK, or API changes are in scope.

The incident motivating this work exhausted OpenShell's lifetime budget of
4,096 exec request identities in about ten minutes. See the
[incident analysis](exec-limit-incident-2026-10-24.md). Duplex plus disabled
log-tail polling removes the recurring traffic responsible for that incident.
It does **not** remove OpenShell's limit for legitimate setup, sync, or agent
executions. Do not advertise unlimited runtime lifetime or implement an automatic
restart, command replay, or an internal persistent command runner in this scope.

## Existing Paperclip prerequisite

Use the existing host feature gate and startup fallback without modifying them:

- The installed SDK exposes duplex hooks and notifications, but `PluginContext`
  has no instance-settings reader. Open requests carry identity and command
  arguments, not the effective instance setting or full environment config.
- The provider configuration schema is static. It cannot dynamically disable a
  checkbox based on the instance setting. This is an accepted UX limitation.
- In Paperclip v2026.1005.0 the instance setting exists in the API and validator,
  but `InstanceExperimentalSettings.tsx` does not render a duplex switch.

The host reads its effective instance flag for new runs and attempts duplex only
when the flag, provider capability, and worker methods permit it. The plugin
separately enforces its environment opt-in when opening a channel. When the
instance flag is off, the host retains its file bridge. When the plugin opt-in is
off but the host flag is on, the provider rejects the open before spawning SSH;
Paperclip's existing bounded startup fallback selects the file bridge. An opt-out
may therefore appear as a startup fallback in existing host diagnostics. Verify
this behavior against the pinned host; do not assume the host already understands
the new `enableDuplex` config field or can mask capabilities per environment.

Do not add schema extensions, admin UI controls, server-side config dependency
validation, or capability-normalization changes to Paperclip. The environment
option may be saved as true while the instance flag is false; this is valid but
inactive. Do not make the worker call Paperclip's admin API with operator
credentials or copy the global setting into plugin-owned state.

Changing the instance flag affects transport selection for new runs. Do not
imply that it immediately terminates established channels. Environment opt-in
changes also apply to new runs, after the next validated provider lifecycle or
execution call refreshes the in-memory lease config.

Read-only reference files include `server/src/routes/instance-settings.ts`,
instance-setting validators, and the adapter-utils execution-target transport
selection. No host files need editing and no new endpoint is needed.
The local Paperclip checkout is newer than v2026.1005.0; use the pinned tag to
review the baseline and repeat checks against the actual deployment revision.

## Configuration and explanatory copy

Add to the provider's environment config in `src/config.ts`:

- `enableDuplex: boolean`, default false; reject non-boolean supplied values.
- `sshExecutable: string`, default `ssh`; validate as an executable selector
  consistent with the existing `executable` field. Add it to the schema and docs.
- Existing configurations and persisted lease metadata remain valid. No
  instance-config migration or metadata format break is required.

Suggested checkbox description, always visible:

> Requires Paperclip's instance setting `enableSandboxDuplexBridge=true` as well
> as this option. An instance admin must enable it through the instance settings
> API; see the provider README for instructions. With either option off, runs use
> file polling. Existing runs keep their current transport.

Document this operator setup in README (no duplex UI switch is assumed):

1. As an authenticated instance admin, read
   `GET /api/instance/settings/experimental` and record the current value.
2. Patch only this field through the existing API:

```http
PATCH /api/instance/settings/experimental
Content-Type: application/json

{"enableSandboxDuplexBridge":true}
```

3. Read the endpoint again and verify the effective returned value is true.
4. Enable the environment checkbox, disable redundant log polling as below, and
   start a new run. Confirm actual transport readiness in diagnostics.
5. Roll back globally with the same PATCH and a false value, or disable only the
   environment checkbox. Do not overwrite unrelated instance settings.

Provide a same-origin browser `fetch` example or an authenticated HTTP-client
example that uses the operator's existing login. Do not request credential
values or prescribe an invented CLI subcommand. A CLI may be documented only
after verifying that the deployed version exposes an equivalent settings command.
An API rejection or managed-off setting must be explained as such; this endpoint
does not bypass instance policy. The instance flag and environment opt-in are
separate settings, not one shared JSON object.

Example to document for an instance admin, run in the browser console while
signed in to their Paperclip instance (this plan does not execute it):

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
if (effectiveSettings.enableSandboxDuplexBridge !== true) {
  throw new Error('Instance duplex setting is not effectively enabled');
}
console.log(
  'Instance duplex setting enabled; enable the environment option next.',
);
```

For an opted-in environment, recommend turning **Stream run logs** off in the
environment editor (`streamRunLogs: false`). Explain that this provider's native
streaming still delivers live output. The current generic host hint says output
will only appear on completion; clarify in the provider README that this generic
hint does not describe this provider's native streaming. Leave the host UI
unchanged. Do not silently alter the saved log setting. Explain that leaving it
on retains additional polling traffic.

## Provider implementation

### Lease resolution and ownership

Add a validated in-memory lease registry, keyed by company, environment, driver,
and provider lease ID. Populate only after successful acquisition, resume, or
execution with verified identity. Store the effective scoped connection config
and validated identity needed to open a channel; do not retain arbitrary input
metadata or command secrets.

Open requests contain no lease metadata. Resolve them from this registry,
require `enableDuplex`, and perform a fresh scoped lookup with complete
pagination and ownership verification. Require the recorded allocation ID and
`Ready` phase. Preserve existing gateway/workspace/configHome isolation; never
fall back to the CLI's active gateway. After a worker restart, an unknown lease
must be resumed or otherwise verified before opening. An error must produce a
clear unavailable result, not a guessed sandbox name.

Capture a lease lifecycle generation before asynchronous opening. Release,
stop, destroy, or worker shutdown invalidates it, prevents further opens, and
closes associated channels, including opens still in progress. Recheck the
generation after subprocess startup. A stale open must not recreate a channel
after teardown has finished. Invalidate stale entries after failed resume or
identity mismatch. Refresh the saved provider opt-in through each successful
validated lifecycle/execution call, rather than requiring the host to interpret
the plugin-specific config field. Missing opt-in means off.

### SSH transport

Implement a new module such as `src/duplex.ts`, with an injectable subprocess
launcher and clock for deterministic testing. Use a dedicated streaming child
implementation, not the existing buffered `Runner`, which closes stdin.

Use the scoped OpenShell SSH proxy mechanism with a noninteractive SSH client.
Before coding, verify `openshell ssh-proxy --help`, scoped `sandbox ssh-config`
behavior, and the pinned CLI implementation. Establish the exact supported proxy
invocation and credential lifecycle; never guess flags or assume that SSH
connection reuse itself bypasses the exec ledger. Launching the bridge command
consumes an exec identity; subsequent bytes on that command do not.

Use argument arrays and `shell: false`, disable inherited SSH config (`-F
/dev/null`), PTY allocation, interactive authentication, and login/profile startup
effects. Independently quote each remote argv element and any ProxyCommand shell
arguments. Match OpenShell's tunnel-specific host-key/authentication mechanism;
document the authenticated gateway relay trust boundary and do not change global
SSH files. Scope both SSH helper discovery and proxy execution with gateway,
workspace, and `XDG_CONFIG_HOME`; strip inherited endpoint overrides just as the
existing runner does. Ensure process/proxy cleanup does not leave child helpers.

Keep stdin open for delayed writes. Forward stdout as raw bytes, with no UTF-8
decoding, line processing, or shell banners. Keep SSH stderr out of the protocol;
capture only bounded diagnostics and sanitize lifecycle errors. Do not log the
command, env, callback payload, tokens, raw proxy arguments, or output bytes.

Define explicit open, graceful-close, and forced-termination budgets. Respect
stdin backpressure and serialize writes for each route. Bound individual wire
frames, queued input, pending pre-bind output, and diagnostics; enforce a
documented bound for every queue the plugin controls. SDK notifications return
void, so they do not imply host-side backpressure: inspect existing host stream
limits and test a slow consumer before promising end-to-end bounded memory.
Do not accumulate lifetime channel output or apply the ordinary 16 MiB total
execution limit to a healthy long-lived protocol stream. Retain existing 4 MiB
stdin and 16 MiB output limits for ordinary executions.

### SDK hooks and routing

Wire `onDuplexChannelOpen`, `onDuplexChannelWrite`, `onDuplexChannelStop`, and
`onDuplexChannelClose` in `src/plugin.ts`. Use `ctx.duplexChannel.data` and
`.exit` for notifications. Advertise `duplexCommandStream: true` in
`src/manifest.ts` only with all four hooks implemented. Keep persistent process
sessions, native sync, and unrelated capability flags unchanged.

Implement the exact installed SDK contract:

- Open registers `hostRouteId` before async work, returns that ID and a fresh
  worker session ID, and rejects duplicate live routes. Do not treat SSH spawn
  as bridge readiness; Paperclip's existing protocol handshake establishes that.
- Write and stop require the exact live `(hostRouteId, workerSessionId)` pair.
  Decode writes with the SDK's strict byte decoder and reject malformed frames.
- Close is keyed by `hostRouteId`; its optional session ID is non-authoritative.
  Handle route-only close, lost open replies, early child exit, and close-during-
  open. Acknowledgements must echo the actual registered identifiers.
- Emit data and exit with both identifiers. Deliver exit at most once and
  preserve data/exit ordering. Report transport loss distinctly from a known
  remote exit; a killed local SSH process does not prove remote termination.
- Make close idempotent. Retain bounded cancellation state as needed so late
  startup completion cannot resurrect a closed route, and release resources on
  every startup/error path. Teardown must not close another company's route.

Register shutdown cleanup using the supported SDK lifecycle for the installed
version. Preserve current stop/delete/reconciliation semantics: channel cleanup
must not authorize sandbox deletion or substitute for confirmation of stop.

## Selection, failure, and observability

Expected selection matrix:

| Instance gate | Environment opt-in | Provider hooks/capability | New run                                                      |
| ------------- | ------------------ | ------------------------- | ------------------------------------------------------------ |
| Off/unknown   | Either             | Either                    | File bridge; checkbox editable, prerequisite explained       |
| On            | Off/missing        | Present                   | Provider declines open; host startup fallback to file bridge |
| On            | On                 | Missing                   | File bridge with capability-unavailable diagnostic           |
| On            | On                 | Present                   | Attempt duplex and validate protocol readiness               |

Keep Paperclip's bounded startup fallback before a bridge is established.
Report fallback prominently because file polling can still exhaust this runtime.
Do not replay callback requests after an established channel fails or silently
switch a live session to the queue transport. Reuse the host's established
failure behavior and distinguish normal remote exit from transport loss.

Emit sanitized provider opt-in state, open duration, and channel termination
reason. Reuse existing host readiness, selection, and fallback diagnostics; do
not claim the worker knows the instance flag or full handshake state. Document
how operators correlate the host and worker diagnostics. Keep command data out
of logs. Turning the environment toggle off is the rollback for new runs; leave
the SDK hooks and manifest support installed rather than mutating the manifest
per environment. Neither rollback nor enabling duplex repairs a runtime whose
exec ledger is already exhausted; that runtime requires a controlled generation
reset with active-work interruption explained separately.

## Tests and acceptance criteria

Provider tests:

- Config defaults/type errors; old metadata and exports remain compatible.
- Scoped lease lookup, cross-company/environment rejection, ownership mismatch,
  allocation replacement, pagination failure, unknown lease after worker restart,
  and opt-in off all fail safely before channel execution.
- Binary round trips including NUL and non-UTF-8 bytes; delayed stdin without EOF;
  quoting of remote argv and proxy paths; no PTY/login-shell output contamination.
- Wrong route/session pairs, malformed base64, duplicate opens, input
  backpressure, queue overflow, early child exit, spawn/SSH failure, and timeouts.
- Lost open reply followed by route-only close; close during lookup/spawn;
  stop/destroy/shutdown during open; duplicate close; stale lifecycle generation;
  exit exactly once; no leftover local subprocesses or handles.
- Real SDK worker RPC contract tests cover method discovery, byte notifications,
  exit notifications, close acknowledgements, and unchanged ordinary execution.

Compatibility checks against unchanged Paperclip:

- Standard schema form exposes an editable default-off checkbox with prerequisite
  copy. Saving true while the instance flag is off remains valid and inactive.
- An environment with opt-in off does not spawn an SSH bridge even if the
  instance flag is on; another opted-in environment can use duplex independently.
- Every selection-matrix row; gate refresh on new runs; current run unaffected
  by a settings edit; startup fallback observable; established failure not replayed.
- Use existing host tests or an external integration harness; do not modify
  Paperclip source or tests to make the plugin work.

Opt-in live verification:

1. Start from a fresh, non-exhausted sandbox. Verify the worker has the SSH CLI.
2. Enable the instance setting and environment option; disable Stream run logs.
3. Exercise the real OpenCode callback workflow and live output, including a
   callback after an idle interval. Confirm duplex readiness and successful calls.
4. Run longer than the incident's ten-minute threshold (target at least 20
   minutes). Count exec starts, not every SSH relay: after setup, a quiet run
   must produce no recurring callback-queue or log-tail execs. Exercise repeated
   callback requests without an exec count proportional to callback count.
5. Observe gateway traffic, first-output/callback latency, cleanup, and transport
   loss behavior. Compare with the same workload before activation.
6. Stop/start only a designated test sandbox to verify retained files and channel
   cleanup; do not interrupt the operator's active sandbox for acceptance tests.

Use `OPENSHELL_SMOKE_CONFIG` and `PAPERCLIP_SOURCE` per the repository guide.
Extend `scripts/live-smoke.ts` with an explicit duplex mode and report skipped
live coverage separately. Do not describe mocked tests as live validation.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and
`pnpm check:package`. Exercise existing host transport tests if the clean
Paperclip checkout supports them and use the plugin's contract/integration tests
for opt-in behavior. Include the deployment's actual Paperclip revision in the
validation record; no host build or deployment change is required.

## Delivery sequence

1. Confirm the pinned SSH proxy contract and existing host startup fallback,
   including provider opt-out. Record any SDK/API mismatch before coding; do not
   silently upgrade dependencies or broaden scope to host changes.
2. Implement provider configuration, lease registry, channel lifecycle, SSH
   transport, hooks, and contract tests. Default remains off.
3. Document API setup, the editable checkbox's prerequisite, output-streaming
   hint, diagnostics, fallback, and rollback in README.
4. Deploy only the provider. Keep its environment option off until controlled
   live acceptance succeeds; use the existing Paperclip deployment unchanged.
5. Have an instance admin enable the host flag through the API, enable the
   environment option, and disable log polling for the selected environment.
   Record the selected transport and measured exec reduction.
6. Update README and the older transport proposal to reference this design and
   report measured results. Keep the incident analysis as historical evidence.

Suggested provider commit: `feat: support opt-in duplex callback transport`.
The handoff is complete when the documented two-setting activation works on
unchanged Paperclip, protocol/lifecycle tests pass, and live verification
demonstrates removal of periodic exec traffic. If live
access is unavailable, deliver the implementation with that acceptance item
explicitly outstanding and keep rollout disabled.
