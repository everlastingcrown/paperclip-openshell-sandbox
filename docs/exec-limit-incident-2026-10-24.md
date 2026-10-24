# OpenShell execution limit incident, 2026-10-24

## Conclusion

The active runtime exhausted OpenShell 0.1.2's lifetime limit of 4,096 exec
request identities. Paperclip's callback queue and run-log polling consumed the
budget in approximately ten minutes. Existing processes kept running, while new
OpenShell executions stopped completing successfully.

This conclusion has high confidence: the transition in the complete supervisor
log occurs precisely between relay opens 4,096 and 4,097, matching the pinned
upstream implementation. Runtime memory was not inspected directly; the ledger
contents were inferred from source and the exact observed threshold.

## Live evidence

Sandbox: `pc-5a8374c6508304ff`, allocation
`0c1a2907-7ac9-4e34-8cf8-e54ff450c9b3`. CLI and gateway both reported 0.1.2.
Times below are UTC on 2026-10-24.

| Event                | Time         | Evidence                                                 |
| -------------------- | ------------ | -------------------------------------------------------- |
| First SSH relay open | 03:22:05.214 | Supervisor log begins with this runtime's startup        |
| Relay open 4,096     | 03:31:58.225 | Channel `6e32117a-7653-44f3-9109-73977f48fd0b`           |
| Relay 4,096 closes   | 03:31:58.234 | Completed in approximately 9 ms                          |
| Relay open 4,097     | 03:31:58.375 | Channel `f51944c8-698f-41d7-8953-396876ff6943`           |
| Relay 4,097 closes   | 03:32:13.378 | Approximately 15 seconds later                           |
| Relay open 4,098     | 03:31:58.440 | Channel `ce430866-a1ba-4988-8699-ef3df11c56c0`           |
| Relay 4,098 fails    | 03:32:13.444 | Broken pipe; gateway reports missing command exit status |

Of the first 4,096 relays, 4,095 had normal close records; the remaining relay
(number 65) corresponds to the still-running long-lived workload. The rate was
approximately 6.9 relay opens per second before exhaustion.

The retained gateway log covers only part of this interval. Before the threshold
it contains 2,275 exec starts: 1,442 callback queue polls, 832 log-tail polls, and
one other command. Poll classification uses command previews and lengths; the
full supervisor log supplies the lifetime relay count.

Live probes through OpenShell, using closed stdin, no TTY, no login shell, and
`/bin/echo` or `/bin/true`, produced no output before their deadlines. The
five-second remote-timeout probe returned exit 124. Kubernetes exec into the
same workload returned immediately.

Both workload and supervisor pods had zero restarts. The workload cgroup recorded
no OOM events, and PID usage was approximately 85 against a limit of 14,307.
OpenCode and its bridge process remained alive, and model API traffic continued.
The gateway's full failure message was:

```text
exec relay closed before the command reported an exit status
```

## Mechanism

In the pinned [boundary server implementation](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-sandbox/src/boundary_server.rs),
`MAX_REPLAY_LEDGER_ENTRIES` is 4,096. `reserve_exec_request` inserts every new exec
request ID into `exec_requests`, a set owned by the runtime generation. Once
full, it returns an unavailable error rather than admitting another execution.
Completed process retention is separate: removing an old process handle does
not reclaim an exec request ID. The upstream test
`exec_tombstones_outlive_retained_handles_and_fail_closed_at_capacity` explicitly
checks this behavior. This is a cumulative limit, not a concurrency limit.

The [SSH handler](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-supervisor-process/src/ssh.rs)
propagates a failed boundary exec from `start_exec_spec`. The gateway subsequently
observes a channel ending without a command exit status. The observed broken
pipe is the relay's failed write to its local SSH socket after closure; it does
not itself establish a network-policy denial. `SSH:OPEN ALLOWED` confirms the
relay was admitted, not that the workload command started.

Paperclip polls the callback queue every 100 ms and log files every 250 ms,
plus execution duration. Each poll uses another OpenShell exec. After the
threshold, the recurring 15-second pattern reflects failed polling attempts;
it does not show a single command making progress. The exact internal source of
that failure delay was not independently instrumented.

`Ready` remains true because the supervisor session and runtime admission remain
healthy. Listing does not test whether the generation can admit another exec.

## Recovery and prevention

- Resetting the workload runtime generation should reset its in-memory ledger.
  A controlled sandbox stop/start is the expected recovery path and preserves
  workspace files, but interrupts active processes. It was not performed during
  this investigation. A gateway-only restart does not reset the workload's set.
- Set Paperclip `streamRunLogs: false` when using this provider's native output
  forwarding. This removes the redundant log-tail polls, but callback polling
  still eventually exhausts the limit.
- The durable fix needs upstream exec-ledger handling that supports long-lived
  runtimes while preserving replay protection, or a persistent transport that
  removes per-poll execs. Simply evicting old request identities weakens the
  protection the ledger is designed to enforce.
- This provider currently does not implement duplex transport. Enabling a
  Paperclip duplex setting alone will not supply that capability. See the
  [existing transport proposal](exec-streaming-proposal.md).

No workload was restarted, stopped, deleted, or reconfigured. Validation consisted
of read-only inspection and bounded diagnostic commands; no code changed and no
test suite was required.
