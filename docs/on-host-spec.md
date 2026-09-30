# `deploy --on-host` (PKG-187): specification

This is the vetted spec: Codex vet 3 said BUILD: yes with fixes, and all fixes are folded in here. Goal: **a release-layout deploy survives the death of its operator session.** Principle: on-host runs the same pipeline with the same semantics as ssh mode, only relocated; it must be no worse than ssh mode on any axis. Pre-existing weaknesses are out of scope: PKG-191 covers step-timeout descendants, PKG-192 covers age-only lock takeover.

## Invocation
`deploy-kit deploy --on-host --sha <40-hex> --no-auto-cut [--skip-build] [--skip-deps] [--skip-migrate] [--skip-pin-check]`
`deploy-kit attach <run-id>`
The operator config must have `layout.type === 'releases'`, `mode === 'ssh'`, `lock !== false`, and `stepTimeoutSeconds` a finite number > 0. `--dry-run`, `--no-lock`, `--steal-lock`, `--branch`, and a missing `--sha`/`--no-auto-cut` are refused with named errors. There's a new optional config key `onHost: { env: [names] }`, validated. The names `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PM2_HOME`, `XDG_RUNTIME_DIR`, `NODE_OPTIONS` and `INVOCATION_ID` are forbidden there.

## Run identity and layout on the host
- Run id: `<YYYYMMDDTHHMMSSZ>-<sha12>-<8 hex>`, matching `^\d{8}T\d{6}Z-[0-9a-f]{12}-[0-9a-f]{8}$`.
- Run dir: `$HOME/.deploy-kit/runs/<run-id>/`, mode 0700, created with a non-`-p` `mkdir` of the leaf.
- Unit: `deploy-kit-<lockId>-<run-id>` (lockId as in lock.js).
- Contents:
  - `kit/` holds this deploy-kit's `package.json`, `src/` (no `__tests__`), and `node_modules/js-yaml/`, all copied as real files with symlinks dereferenced. It includes `kit/src/on-host/record.sh`.
  - `config.json` is the resolved config with `mode: 'local'`, `host` deleted, and `localShell: <captured login shell>` set.
  - `meta.json` holds `{runId, sha, options: {skipBuild, skipDeps, skipMigrate, verifyPins}, operatorVersion, operatorConfigSha256, operatorGitHead, createdAt, capture: {path, umask, oomScoreAdj, shell, env: {…allowlisted}}}`.
  - `manifest.sha256` is in `sha256sum` format over every file in `kit/`, plus `config.json` and `meta.json`.
  - `log` is appended by systemd (stdout + stderr).
  - `started`, `outcome.json`, `result.json` and `result-unstarted.json` are written at runtime (see below).

## Operator flow (`src/on-host/operator.js`)
1. Validate flags and config (above).
2. **Preflight**: one bounded ssh call, read-only, printing KEY=VALUE lines that the operator parses. It fails with a named error for each of these:
   - `loginctl show-user $USER -p Linger` ≠ yes (`ONHOST_NO_LINGER`);
   - `systemctl --user show-environment` fails, with `XDG_RUNTIME_DIR` defaulted (`ONHOST_NO_USER_MANAGER`);
   - `command -v node` missing or node < 20 (`ONHOST_NODE`);
   - an active `deploy-kit-<lockId>-*` unit exists (`ONHOST_ALREADY_RUNNING`).
   It also captures:
   - the login shell from `getent passwd $USER | cut -d: -f7`;
   - `umask`;
   - `cat /proc/self/oom_score_adj`;
   - `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` and `PM2_HOME`;
   - the realpath of `node`;
   - every `onHost.env` name, with absent names recorded as absent;
   - whether `NODE_OPTIONS` is set, which only produces a warning.
3. Build the bundle in a local temp dir. Compute the manifest.
4. **Receipt before submission**: append `{app, host, unit, runId, runDir, sha, startedAt}` to `~/.deploy-kit/on-host-runs.jsonl` locally, and print `run: <id>  unit: <unit>  host: <host>`.
5. Upload: `ssh host 'mkdir -m 700 -p ~/.deploy-kit/runs && mkdir -m 700 <runDir> && tar -x -C <runDir>'`, with the tar on stdin. Then verify remotely with `cd <runDir> && sha256sum -c --quiet manifest.sha256`. A mismatch is `ONHOST_MANIFEST` and the run is not submitted.
6. Submit (one ssh):
   `systemd-run --user --unit=<unit> --property=Type=exec --property=KillMode=process --property=OOMPolicy=continue --property=TasksMax=infinity --property=UMask=<captured> --property=WorkingDirectory=<projectDir> --property=StandardOutput=append:<runDir>/log --property=StandardError=append:<runDir>/log --property=ExecStopPost=/bin/sh <runDir>/kit/src/on-host/record.sh <runDir> -- /usr/bin/env -i PATH=<captured PATH> HOME=… USER=… LOGNAME=… SHELL=<login shell> LANG=… PM2_HOME=… XDG_RUNTIME_DIR=/run/user/<uid> INVOCATION_ID=\${INVOCATION_ID} <each onHost.env name=value> <node realpath> <runDir>/kit/src/cli.js host-run <runDir>`
   - There is no `RuntimeMaxSec`, no `--collect` and no `--wait`.
   - If the submission's ssh fails or times out, the outcome is **unknown**. Print `submission outcome unknown — do NOT redeploy; run: deploy-kit attach <run-id>` and exit 75. Never resubmit.
7. Attach (the same code as `deploy-kit attach`).

## Attach (`deploy-kit attach <run-id>`)
- Looks the run up in the local receipts file to get the host and the run dir, then loops over ssh: `tail -c +<offset> <runDir>/log` (streamed to stdout), then reads `started`, `outcome.json`, `result.json`, `result-unstarted.json`, and `systemctl --user show -p ActiveState -p SubState <unit>`, polling every 3 s.
- Stops when `result.json` or `result-unstarted.json` exists, or when the unit is inactive or failed and 30 s have passed with no result.
- If an ssh poll fails, it retries up to 5 times with backoff. After that it prints `transport lost — the deploy continues on <host> as <unit>; reattach: deploy-kit attach <run-id>` and exits **75**.
- The exit code comes from `classify()` below.

## Outcome classification (`src/on-host/outcome.js`, pure and shared)
Each record is validated independently: valid JSON, the expected shape, and `runId` equal to the expected run id. An invalid or mismatched record counts as absent.
1. A valid result with `serviceResult/exitCode/exitStatus` other than `success/exited/0` → **1 (failed)**.
2. A valid outcome with `ok: false` → **1 (failed)**.
3. A valid result with `success/exited/0` **and** a valid outcome with `ok: true` → **0 (succeeded)**.
4. `result-unstarted.json` valid → **1 (failed to start)**. It is evidence that host-run never claimed the run.
5. Anything else → **70 (unknown)**, with the reason listed.
The truth-table tests cover: success; failure through the outcome; failure through the result (exit 3, SIGKILL `signal/KILL`, stop `success/killed/TERM`); a missing outcome with a failed result (→ 1); a missing outcome with a success result (→ 70); a wrong run id; malformed JSON; and no records at all.

## host-run (`deploy-kit host-run <runDir>`, `src/on-host/host-run.js`)
The steps run in this order; every refusal is named and happens before the lock:
1. `runDir` is a real directory, not a symlink, owned by the current uid, with mode 0700.
2. `INVOCATION_ID` env matches `^[0-9a-f]{32}$`.
3. Create `started` with `O_CREAT|O_EXCL`, containing the INVOCATION_ID. If it already exists, exit 1 (`ONHOST_REPLAY`) **without touching** outcome or result.
4. `sha256sum -c` equivalent in Node over `manifest.sha256`. Every listed file must match, and no file under `kit/` may be missing from the manifest.
5. Parse and validate `meta.json` (schema, a 40-hex sha, `runId` equal to the dir name) and `config.json` (`mode === 'local'`, no `host`, releases layout, `lock !== false`, finite `stepTimeoutSeconds > 0`, `localShell` an absolute path).
6. **OOM parity**: read `/proc/self/oom_score_adj`. If it is greater than `meta.capture.oomScoreAdj`, refuse (`ONHOST_OOM_SCORE`) and name the fix: a `user@.service` drop-in `OOMScoreAdjust=` plus `DefaultOOMScoreAdjust=` in `/etc/systemd/user.conf.d/`, with the value, as documented in the README.
7. Call `deployRelease(config, { skipBuild, skipDeps, skipMigrate, verifyPins, sha, autoCut: false, stealLock: false })`. Allowlisted options come first, enforced values last.
8. Write `outcome.json` (tmp + rename) as `{runId, ok, error?: message, finishedAt}`. Exit 0 or 1.
9. After a successful activation, if `$PM2_HOME/pm2.pid`'s PID ≠ `systemctl show -p MainPID --value pm2-$USER.service`, log a loud **warning** `PM2_DAEMON_NOT_SYSTEM_SERVICE`. This never fails the run.

## record.sh (POSIX sh, run as `ExecStopPost`)
Arguments: the run dir. It reads `$INVOCATION_ID`, `$SERVICE_RESULT`, `$EXIT_CODE` and `$EXIT_STATUS`, and the runId from the dir name.
- If `started` exists and contains exactly `$INVOCATION_ID`, and `result.json` doesn't exist: write `result.json` via tmp + `mv`, as `{"runId":…,"invocationId":…,"serviceResult":…,"exitCode":…,"exitStatus":…,"finishedAt":<epoch>}`.
- Else if `started` doesn't exist and `result-unstarted.json` doesn't exist: write `result-unstarted.json` with the same fields.
- Otherwise do nothing: a replayed invocation never overwrites evidence.
Values are JSON-escaped with a strict allowlist (`[A-Za-z0-9_-]`); anything else is replaced with `"invalid"`.

## exec.js change (minimal)
`buildTargetCommand` local mode uses `config.localShell` when it is set, otherwise `'sh'`. Nothing else in exec.js changes, and every existing invocation is unaffected. config.js validates `localShell` (an absolute path) and `onHost.env`.

## Proof (disposable harness `scripts/on-host-harness/`)
- (a) kill the operator mid-deploy → the deploy completes on the host;
- (b) reattach after completion;
- (c) a failing step → exit 1;
- (d) a concurrent on-host deploy, or an ssh deploy during an on-host one, is refused;
- (e) SIGKILL of host-run → exit 1 and the journal fails closed;
- (f) a disconnect right after submission → attach finds the run, nothing is resubmitted;
- (g) a replay of the same run dir is refused, with the evidence intact;
- (h) the PM2 daemon killed mid-deploy → apps survive the unit's end and the warning shows;
- (i) an OOM-killed step child → host-run survives and reaches normal recovery;
- (j) a bash-only hook (`[[ ]]`) works with a bash login shell;
- (k) the ssh umask is applied;
- (l) the OOM-score refusal fires when the unit's value is higher.
