# Security Policy

## Supported versions

Security fixes are made on the default branch and included in the next tagged
release. Older releases are not maintained separately.

## Threat model

deploy-kit runs arbitrary commands over SSH against production hosts, so its
threat model is worth stating explicitly rather than leaving it implicit.

**Fully trusted: the config file.** `.deploy-kit.config.json` already runs
arbitrary shell — `hooks.install`/`hooks.backup`/`hooks.migrate`/`hooks.build`/
`hooks.restart`/`hooks.restore`, every `preDeployChecks`/`postDeployChecks`/
`preRestartChecks`/`layout.releaseChecks` command, and `monitor.checks`/
`monitor.alert.command`/`deliveryEvent.command` are all shell commands the kit
runs verbatim. Anyone who can edit the config can run anything on the target;
deploy-kit does not sandbox any of it. `ssh.options` is a deliberate escape
hatch for the same reason: a bastion/jump-host `ProxyCommand` is a legitimate,
intentionally-supported use, so entries are only shape-validated (must be a
literal `Key=Value` string), never restricted in content.

**Not trusted: branch input.** An explicit config `branch` or CLI
`deploy --branch NAME` value passes through the same strict git-ref allowlist.
When neither is set, deploy-kit resolves the target's `origin/HEAD` at deploy
time and uses that name as the branch — a value chosen by whoever can rename
the remote's default branch, not by the config author. Before this was
hardened, that resolved name reached `git pull --ff-only <remote> <branch>`
on the target unescaped: git's own ref-name rules (`git check-ref-format`)
still permit shell metacharacters such as `` ` ``, `$()`, `;`, `&`, and `|` in
a branch name (they only ban control characters, space, `~^:?*[`, `..`,
leading/trailing `/`, a trailing `.`, and a few other sequences), so a
renamed default branch was a real remote-shell-injection path, not a
theoretical one.

The **legacy (in-place) deploy pipeline** (`src/deploy.js`) closes this with
two independent layers: an explicit `branch`/`remote` in the config file or
CLI override is
charset-validated at load time against that same git-refname allowlist
(`src/config.js` `isValidRefName`), AND every branch/remote value — whether
taken from config or resolved from `origin/HEAD` at runtime — is
single-quoted at the call site (`shQuote` in `src/deploy.js`) before it
reaches the remote shell, so a value that slipped past validation (e.g. via
`loadConfig({ validate: false })`) still can't inject.

Both pipelines are covered. `shQuote` lives in `src/exec.js` and is applied
at every call site that interpolates a runtime-resolved branch or remote
into a target command — the legacy `git fetch`/`git pull`, the release
layout's `git fetch` and both `rev-parse` SHA lookups, and the
`rev-parse --abbrev-ref <remote>/HEAD` in `src/branch.js` that resolves the
default branch in the first place.

**Host-key posture.** `ssh.strictHostKeyChecking` defaults to `accept-new`: it
pins whatever host key it sees on first connection (so a later MITM attempt
presents a mismatched key and is rejected) without the interactive prompt
that would hang an unattended cron/CI deploy. `ssh.batchMode` defaults to
`yes`, so any prompt ssh would otherwise show becomes a fast failure instead
of a hang. Residual risk, stated plainly: the *first* connection to a
not-yet-known host still trusts whatever key it is shown at that moment — if
that matters for your target, pre-seed `known_hosts` out of band rather than
relying on `accept-new` alone.

**Secrets.** Webhook URLs and API keys (`DISCORD_ALERT_WEBHOOK`,
`DISCORD_RELEASE_WEBHOOK`, `HOST_OPERATIONS_API_KEY`, etc.) are read from
environment variables, never written to disk by deploy-kit, and never
logged. Alert batches and delivery-event payloads are passed to sink/event
commands via **stdin**, not interpolated into a command string. One
exception: health-probe headers (`healthHeaders`, `monitor.publicProbes[].headers`)
are embedded directly into the `curl`/ssh command string that runs the probe,
so they are visible in `ps` output on both the controller and the target for
the life of that command. Do not put a secret in a health-probe header.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
reporting flow at <https://github.com/andrewpopov/deploy-kit/security/advisories/new>.
Include the package version, a minimal reproduction, impact, and any suggested
mitigation. Please allow a reasonable period for investigation and a coordinated
fix before public disclosure.

## Scope

Report flaws in this package's source, published artifacts, or release process.
For a consuming application's credentials, deployment, or configuration, report
the issue to that application separately.
