# Cleanup page API feasibility

Verified by source inspection against Paperclip `v2026.1005.0`, commit
`467125fafb47a8520856504fecc48d6e32055db1`, and the installed SDK
`2026.1005.0`. This is an API and authorization audit, not a live deployment
test. No cleanup operations were invoked.

## Conclusion

A plugin page can list environments, display pending leases, prefill recovery
entries, save those entries as an instance admin, and poll for the host's
automatic cleanup result. The complete proposed workflow needs Paperclip work:
there is no standalone pending-lease cleanup retry endpoint, no discovery API
for leases with a null environment ID, and no read-only inspection endpoint for
an existing provider allocation.

## Existing endpoints

All paths below include the `/api` prefix used by the application.

| Need                                | Endpoint                                                          | Authorization and limitations                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment names and configuration | `GET /companies/:companyId/environments`                          | Board user with organization access. Despite the URL, the implementation lists instance environments, not only this company's environments. Restricted users receive a reduced environment view.                                                                            |
| One environment                     | `GET /environments/:id`                                           | Same board read guard and environment presentation rules.                                                                                                                                                                                                                   |
| Pending leases for an environment   | `GET /environments/:id/leases?status=pending_cleanup`             | Same board read guard. Returns lease records including company, provider, provider lease ID, cleanup status, failure reason and metadata. The implementation filters by environment and status, not company. The page must select the intended company's OpenShell records. |
| Refresh a known lease               | `GET /environment-leases/:leaseId`                                | Same board read guard. Works for a known lease with a null environment ID, but does not discover those leases.                                                                                                                                                              |
| Read recovery configuration         | `GET /plugins/:pluginId/config?companyId=...`                     | Board organization access plus access to the specified company. Configuration is company scoped.                                                                                                                                                                            |
| Save recovery configuration         | `POST /plugins/:pluginId/config` with `{ companyId, configJson }` | Instance admin or local implicit board operator, company access, and plugin management must be visible. Replaces the complete config object; preserve unrelated entries. The host validates the schema and notifies/restarts the worker. Saving does not trigger cleanup.   |
| Plugin-owned inspection/action      | `POST /plugins/:pluginId/bridge/action`                           | Authenticated caller; host checks company access and supplies immutable actor context. The worker must implement and authorize the action. Authentication/company access alone does not establish instance-admin privileges.                                                |

Sources: [environment routes](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/routes/environments.ts),
[environment service](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/environments.ts),
[plugin routes](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/routes/plugins.ts),
[authorization guards](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/routes/authz.ts).

## How a plugin page accesses the APIs

Normal plugin page components are imported as JavaScript modules and rendered
inside the host React application. They can make same-origin browser requests
with session credentials. The normal REST guards authorize the signed-in user;
the plugin's capabilities do not elevate that user. This conclusion follows from
the module loader and session-based API implementation; it has not been checked
in a running browser here. An iframe launcher would require separate analysis.

Declare a UI bundle and `ui.page.register` capability (and
`ui.sidebar.register` if contributing navigation). The current OpenShell manifest
has neither. The SDK's `usePluginData` and `usePluginAction` connect to the
plugin worker, not to arbitrary environment REST endpoints.

The worker has no dedicated SDK environment/lease management client and does
not receive the browser's session credentials. `http.outbound` is not delegated
user access; its HTTP service also blocks private/loopback targets. Use the
browser's authorized REST requests for existing host APIs. Do not pass session
cookies to the worker or treat UI-supplied lease metadata as authoritative.

The action context contains principal type, user/agent/run IDs and authorized
company ID, but no instance-admin flag. A custom destructive action must have a
server-verifiable authorization design; hiding its button is insufficient.

Sources: [UI module loader](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/ui/src/plugins/slots.tsx),
[browser API client](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/ui/src/api/client.ts),
[SDK context](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/packages/plugins/sdk/src/types.ts),
[action protocol](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/packages/plugins/sdk/src/protocol.ts),
[host HTTP service](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/plugin-host-services.ts).

## Missing operations and unsuitable substitutes

- **Retry one pending lease:** no standalone HTTP route. The heartbeat service
  owns the sweep, claim fencing, retry scheduling and host-state reconciliation.
  Failed-run retry can invoke a run-scoped cleanup sweep, but also retries work;
  it is not a cleanup-only operation. Automatic retries continue with slower
  backoff after the escalation threshold.
- **Discover every pending lease:** per-environment listing cannot discover
  leases whose environment ID is null. Fetching a known lease ID is supported.
- **Inspect an existing allocation without mutation:** no host endpoint. The
  environment probe acquires a fresh sandbox for sandbox providers and is not
  an existing-allocation status check. A new plugin action could inspect via
  OpenShell, provided its authority and trusted connection/identity source are
  established.
- **Detailed diagnostics:** lease status, retry metadata and failure reason are
  available, but the host does not promise a complete last provider exception
  or a structured gateway diagnosis in the lease response.
- **Delete environment / change provider:** these operations explicitly reject
  pending sandbox cleanup. They cannot replace lease cleanup.
- **Declare rejection / mark cleaned:** no generic lease mutation endpoint.
  The plugin's existing recovery configuration can record an operator-verified
  rejected attempt. Absence after a timeout alone must not populate it.

Sources: [heartbeat cleanup sweep and failed-run retry](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/heartbeat.ts),
[environment runtime](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/environment-runtime.ts),
[environment probe](https://github.com/paperclipai/paperclip/blob/v2026.1005.0/server/src/services/environment-probe.ts).

## Recommended implementation boundary

A plugin-only first version can offer **Review pending cleanup**, a prefilled
recovery editor, **Save recovery settings**, and **Refresh status**. Clearly
state that saving waits for automatic cleanup; do not label it **Retry now**.

For the complete page, add a host API to discover pending leases by company and
provider (including orphan leases), and an instance-admin cleanup retry API for
a selected lease. These are proposed APIs, not existing routes. Retry should use
the existing cleanup claims and runtime reconciliation, respect stop-and-retain,
resolve immutable metadata on the server, and report pending/succeeded/failed
without deleting the environment. A read-only provider inspection contract would
support the richer diagnostic flow. Test both permitted admin requests and
rejected non-admin/cross-company requests before shipping.
