Verdict: the design has a good core shape, but it is not implementation-ready. The largest gaps are durable check identity, cross-run debouncing, concurrent cron safety, and reliable alert delivery. As written, it can lose alerts permanently, generate duplicate fleet-wide alerts, and misrepresent transient check failures as recoveries.

## V1 blockers

1. **Per-check state needs stable, unique identities**

`name` is not sufficient. There may be multiple apps, probes, disks, and custom checks with the same name.

Use stable IDs such as:

- `pm2:<appName>`
- `restart:<appName>`
- `public:<configured-id>`
- `custom:<configured-id>`
- `disk:<resolved-mount-or-configured-id>`
- `backup:<configured-id>`
- `tunnel:<processName>`

Require explicit unique `id` values for public probes and custom checks. Display names can change without losing history.

Define what happens when:

- A configured check is removed or disabled.
- An app disappears from `appNames`.
- A URL or command changes while its ID stays the same.
- Old state contains checks no longer configured.

Removed checks should normally be retired silently, not emit a misleading recovery.

2. **The state machine needs `unknown`, debounce, and explicit semantics**

The current model conflates three different things:

- The resource is unhealthy.
- The monitor could not determine its health.
- The resource is healthy.

For example, malformed `pm2 jlist`, an SSH timeout, unavailable `df`, or a killed `curl` must not produce `ok` or trigger recovery.

Use at least:

```text
observed status: ok | warn | crit | unknown
notification state: healthy | pending-failure | alerted | pending-recovery
```

Configurable cross-run thresholds are more useful than `attempts` alone:

- `failAfterRuns`, commonly 2 for noisy network probes.
- `recoverAfterRuns`, commonly 2 to prevent recovery flapping.
- `reAlertEveryRuns` or preferably a time duration.
- Possibly `unknownAfterRuns` before alerting on monitor/check failure.

Escalation is not “warn↔crit”: `warn → crit` is escalation, while `crit → warn` is de-escalation. Decide whether de-escalation alerts immediately, waits for stability, or remains quiet until full recovery.

3. **Alert delivery and state persistence are not safely ordered**

The design says to fire alerts and persist state, but the order is critical:

- Persist “alerted” before running the sink: sink failure loses the alert forever.
- Run sink before persisting: a crash after delivery causes duplicate delivery next run.

Use a small pending-delivery/outbox record in the state file:

1. Atomically persist the observed transition and pending notification.
2. Invoke the sink.
3. On success, mark the notification delivered.
4. On failure, retain it for bounded retry and return non-zero.

Include a stable event ID so capable sinks can deduplicate retries.

Also decide whether monitor failure is distinguishable from detected critical health. An exit code such as `0=healthy/warn`, `1=critical condition`, `2=monitor/config/execution failure` would help wrappers.

4. **Concurrent cron executions need locking**

A slow probe can overlap the next cron invocation. Two processes can read identical old state, emit duplicate alerts, overwrite restart baselines, and corrupt counters.

V1 needs:

- An exclusive lock around the entire read/check/transition/write cycle.
- A documented lock timeout or “another run is active” behavior.
- Atomic state writes using same-directory temporary file, `fsync` where appropriate, then rename.
- State schema versioning and corrupt-state handling.
- Restrictive permissions, symlink protection, and a state path outside release-managed directories.

`<projectDir>/.deploy-kit-monitor-state.json` may be replaced, deleted, or become read-only during release swaps. A stable application data directory is safer.

5. **The alert transport is circular**

Running the alert command “on the target” means it cannot report SSH failure or total host failure. More immediately, sending Smart Home alerts through the same app being monitored means a PM2/app failure may also disable its alert sink.

Support an explicit execution location:

```js
alert: {
  command,
  run: 'controller' | 'target'
}
```

For on-host cron, a target-local independent sink such as `ntfy` may work, but an endpoint served by the monitored app is not robust. Sink failure must appear prominently in output and exit status.

## Alert-storm risks

“In-run attempts” do not prevent cron-to-cron flapping. A public endpoint that alternates success and failure will alert and recover every run.

There are also correlated duplicates:

- PM2 app down.
- Custom readiness check fails.
- Public probe fails.
- Possibly tunnel check fails.

That can generate several alerts for one incident. Across five apps, disk pressure or a shared tunnel failure can generate five nearly identical alerts.

For v1, either:

- Send one batched incident summary per run, containing all transitions; or
- Add correlation/suppression rules, such as suppressing an app’s public/custom failures while its PM2 process is confirmed down.

Batching is the smaller and more policy-free v1 solution. The sink contract should accept one structured event containing all transitions, rather than invoking a command once per check.

`reAlertEveryRuns` is coupled to cron frequency. Prefer `reAlertAfterMinutes`; otherwise changing cron from 15 minutes to 1 minute changes alert policy drastically.

## Check-specific correctness gaps

### PM2

- Treat PM2 command failure or invalid JSON as `unknown/monitor-error`, not “all apps missing.”
- Define cluster-mode semantics: does one online instance satisfy the app, or must all instances be online?
- Match an exact stable PM2 name, not ambiguous process fields.
- Put each app in a separate result so recovery and escalation are correctly attributed.

### Restart storm

Persisting only `restart_time` is fragile:

- PM2 counters reset after delete/recreate.
- Deploys intentionally restart processes.
- A negative delta needs to establish a new baseline, not recover an incident.
- Process identity can change while keeping the same name.
- “`> maxDelta`” means `maxDelta: 3` permits three and alerts on four; make that explicit.
- The meaning depends on cron cadence.

Store process identity, count, and observation timestamp. Define reset behavior. Consider a time-normalized policy such as restarts per observation window.

A continuing low-rate crash loop may remain below the per-run delta forever. Decide whether that is acceptable or retain a rolling window.

### Disk

- Alert if either free bytes **or** free inodes violates its threshold; the current “and” wording is ambiguous.
- Use machine-readable output and force a stable locale.
- Handle paths with spaces and non-existent `projectDir`.
- Resolve and report the actual filesystem.
- Some filesystems may not provide meaningful inode values; distinguish unsupported from healthy.
- A single disk check per app will duplicate alerts on shared hosts.

Disk thresholds described as “sane defaults” conflict somewhat with the stated policy-free model. Operational defaults are acceptable, but they should be documented and visible in `--dry-run`/configuration output.

### Backup

A stamp file proves only that something touched a file. The contract must state that the backup job updates it only after:

- Backup creation succeeds.
- The resulting artifact exists and is non-empty.
- Any required upload/verification completes.

Reject or alert on timestamps materially in the future. Report permission/stat errors as unknown or monitor failure, not “missing backup.”

The proposed off-host remote-store check is not actually the same check: local filesystem `stat` and remote object freshness require different adapters.

### Tunnel

“`config.tunnelName` (or `ensureApps`)” is underspecified. Define one authoritative source and validation rules.

An online cloudflared PM2 process only proves the process exists. The public probe is what proves DNS, ingress, TLS, and routing. Keeping both is useful, but alerts should explain their different meanings and avoid redundant incident noise.

### Public probes

V1 needs explicit:

- Connect and total timeouts.
- Response body size cap.
- Redirect policy.
- TLS verification behavior.
- Exact accepted status behavior, possibly a status range rather than one integer.
- Per-attempt delay/backoff.
- URL scheme restriction to `https:`/explicitly permitted `http:`.
- Stable probe ID.
- Redaction of URLs, headers, and response content.

On-host public probing can also fail because of DNS, internet routing, or hairpin behavior unrelated to the application. That is useful evidence, but requires cross-run debounce.

### Custom checks

Custom commands are arbitrary code execution by design. That can be acceptable because the deploy configuration is already trusted, but it must be stated as a trust boundary.

Require:

- Timeout and forced termination.
- Output byte cap.
- Defined working directory and user.
- No implicit shell interpolation of dynamic monitor data.
- Sanitized, bounded stdout/stderr used as the alert message.
- Validation preventing duplicate IDs.
- Clear treatment of signal termination, timeout, and command-not-found.

A custom check returning non-zero does not provide enough information to distinguish warn/crit dynamically. If that is intentional, document that severity is statically configured.

## Command and secret security

The alert environment variables must be passed through the process API’s environment option. Never construct:

```sh
DEPLOY_KIT_ALERT_MESSAGE='<message>' <command>
```

Messages and check names can contain quotes, newlines, shell substitutions, or terminal control characters.

Likewise, URLs and headers must not be concatenated into shell command strings. Prefer argv-based execution. If `runOnTarget` only accepts one shell string, the existing seam is not sufficient for safely passing arbitrary URLs, headers, and messages; add a structured execution form or pass structured JSON over stdin.

Secrets in probe headers must never appear in:

- Printed command lines.
- The summary table.
- State files.
- Alert details.
- Error messages.
- Debug logs.
- Process arguments, where avoidable.

Environment variables are somewhat safer than argv, while stdin or protected files are better for payloads. Redaction should include URL userinfo and sensitive query parameters, not only headers.

## Scope judgment

Appropriate for v1:

- PM2, restart deltas, disk, backup stamp, tunnel process, public probes, and custom checks.
- Stable state with transitions and recoveries.
- A policy-free external alert sink.
- No automatic remediation.
- Fake-runtime unit tests.

Under-scoped for v1 and should be added before implementation:

- Stable check IDs.
- `unknown`/execution-error semantics.
- Cross-run failure and recovery debounce.
- Locking and corrupt/versioned state handling.
- Reliable alert-delivery retry semantics.
- Timeouts and output caps for every external command.
- Structured safe argument/environment handling and secret redaction.
- Batch alerting or minimal correlated-failure suppression.
- Clear controller-versus-target execution for the sink.

Over-scoped or misleading for v1:

- `--once` is redundant if `monitor` itself runs once and cron schedules it.
- Designing the off-host runner around “this exact configuration” is premature. PM2 being always enabled makes a public-probe-only off-host run impossible, and local stamp checks do not map directly to remote object stores.
- `--dry-run` is ambiguous: does it execute checks but suppress alerts/state changes, or merely print configuration? Define it or defer it.
- Folding a general smoke-test framework into continuous monitoring can grow quickly. Keep v1 public probes deliberately narrow.

## Recommended v1 contract

The cleanest v1 would:

- Run once per invocation.
- Acquire an exclusive lock.
- Execute enabled checks with hard timeouts and bounded output.
- Produce stable-ID results with `ok|warn|crit|unknown`.
- Apply configurable failure/recovery debounce.
- Atomically persist versioned state and a pending notification.
- Send one structured, batched transition event through a controller- or target-selected sink.
- Retry pending delivery safely using an event ID.
- Print a redacted summary.
- Exit distinctly for detected critical health versus monitor execution failure.

With those additions, the architecture remains small and reusable. Without them, the first five-app rollout is likely to expose duplicate alerts, silent alert loss, state races, and unsafe shell construction.