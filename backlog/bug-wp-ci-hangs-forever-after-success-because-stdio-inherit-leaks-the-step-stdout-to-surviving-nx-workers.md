# BUG: `wp-ci` hangs a CI step FOREVER after every command has succeeded, because `stdio: 'inherit'` leaks the step's stdout to nx workers that outlive it

**Package:** `@webpieces/code-rules` (`wp-ci`)
**Version seen:** `@webpieces/nx-webpieces-rules@0.4.636`
**Severity:** Critical — a GitHub Actions job runs to the **360-minute default timeout** producing zero
output and **no readable log**, on a repo whose historical range for that job is 4–14 minutes. It reads
as "CI is broken" and is unfalsifiable from the outside, because GitHub refuses to serve logs for an
in-progress job, so the run must be cancelled BY HAND before anything can be read at all.

**Source (this repo — the `.js` seen in a consumer's `node_modules` is build output of these):**
- `packages/tooling/code-rules/src/wp-ci.ts` — `runNx()`: `spawnSync(nxBin(root), args, { stdio: 'inherit', cwd: root })`
- `packages/tooling/code-rules/src/wp-ci.ts` — `runNx(root, ['affected', '--target=ci', ...passthrough])`

Observed 2026-08-11 in `mealco-internal/monorepo-nx` on PR #900. Burned roughly three hours of
investigation across **eleven CI runs**.

## Symptom

```
=== [F] wp-ci itself ===
+ pnpm exec wp-ci
… all nine ci targets run and pass …
=== [G] wp-ci RETURNED ===        ← printed. wp-ci exited. Nothing left to run.
<24 minutes of absolute silence>
##[error]The operation was canceled.
Terminate orphan process: pid (2206) (node)
Terminate orphan process: pid (2218) (sh)
Terminate orphan process: pid (19424) (node)
Terminate orphan process: pid (20034) (node)   … 8 node + 2 sh, EVERY time,
Terminate orphan process: pid (20051) (node)   … same topology, PIDs offset by ~100
```

Step timings from the real job: step 10 ran `16:41:16 → 17:05:45`, killed by `timeout-minutes`. Every
subsequent step `skipped`.

## Leading hypothesis — NOT yet confirmed

**Nothing is stuck computing. Something is stuck existing.**

GitHub Actions ends a step when the step's **stdout reaches EOF**, not when the shell exits.
`runNx` passed `stdio: 'inherit'`, which hands the spawned `nx` process — and transitively every
worker `nx` spawns — the step's **real stdout file descriptor**. If any grandchild survives `nx`'s exit,
it still holds that fd open, so the pipe never closes and the step hangs forever with all work finished
and a zero exit code already in hand.

`spawnSync` returning successfully is therefore **not sufficient** for the step to end.

## Why this was so expensive to diagnose

Three properties conspire, and each one sent the investigation somewhere wrong:

1. **The last log line is always a task that SUCCEEDED.** Every instinct says "it hung at X" where X is
   the last thing printed. It didn't. Across runs the last line was variously
   `architecture:validate-complete [cache hit]`, `validate-api-relations ✅`, and
   `terraform:validate-no-file-import-cycles ✅` — all completed, none causal. Three separate wrong
   diagnoses came from reading the log tail as a stack pointer.
2. **nx interleaves worker output**, so with default parallelism the log tail isn't even chronological.
   Only after forcing `NX_PARALLEL=1` did the log become sequential enough to trust — and only then did
   it become obvious that the "last" task had *finished*.
3. **The orphan list is printed at cancellation, i.e. after you give up**, and looks like evidence of a
   deadlock doing work rather than the actual smoking gun.

## What was ruled out (each its own CI run)

Every one of these ran GREEN in isolation while the composed `webpieces:ci` hung:

| Ruled out | Evidence |
|---|---|
| `build` | green alone |
| `lint`, `validate-browser-safe`, `validate-no-file-import-cycles`, `validate-di-graph-unchanged`, `architecture:validate-complete` | all five green together in **under 4 minutes** |
| `terraform:validate-metric-audit-names`, `terraform:validate-project-names`, `terraform:validate-no-file-import-cycles` | green together |
| `test` | green |
| `check-schema-infra-isolated.sh`, `record-image-sha.test.sh`, `check-no-nested-node-modules.js` | green |
| `wp-ci` itself | **returned successfully** — then the step hung |
| nx daemon (`NX_DAEMON=false`) | tested directly, no effect |
| parallelism (`NX_PARALLEL=2`) | tested directly, no effect |
| build size / fan-out | ~2 min cold on a dev box for all 73 tasks; `architecture:validate-complete` 20s, `platform-sdk:ci` 32s, `mealco-api-auth:ci` 26s |
| per-project fan-out of `architecture:validate-complete` | counted in a real log: **1** invocation, itself a cache hit |

## Suggested fixes

1. **Do not share the step's fd.** Use `stdio: ['inherit', 'pipe', 'pipe']` and forward output, so a
   surviving grandchild cannot hold the step's stdout open.
2. **Exit explicitly.** `process.exit(code)` after `spawnSync` returns, so node does not linger on open
   handles either.
3. **Reap survivors.** Spawn into a process group and kill the group once the child exits.
4. **Fail loudly instead of silently.** If `wp-ci` finished and the process is still alive after a grace
   period, print the surviving PIDs and command lines. That single log line would have replaced this
   entire investigation.

### What shipped (fixes 3 + 4)

`wp-ci` no longer uses `spawnSync`. `NxStepRunner` (`packages/tooling/code-rules/src/wp-ci-nx-runner.ts`)
spawns each nx step **detached**, so the child is a process-group leader and the group id is a reliable
handle on every worker it spawns — orphans get re-parented away from the process tree, so the group is the
only thing that still identifies them. Once the step's child exits, `SurvivorWatchdog`
(`wp-ci-survivors.ts`) polls `ps -A -o pid=,pgid=,args=` (identical spelling on macOS and Linux) until the
group drains. If anything is still alive when the grace period expires, `SurvivorReporter` writes a banner
with **every surviving pid and its full command line** straight to fd 2 with `fs.writeSync` — synchronous,
because the failure being diagnosed is entangled stdio and a buffered `console.error` can be lost — then
`ProcessGroupKiller` SIGKILLs the group (so the step's stdout finally reaches EOF instead of hanging) and
`wp-ci` exits **75**, distinct from an ordinary red build.

Grace period: **25 minutes** by default, one budget for the whole `wp-ci` process rather than per step,
measured from `wp-ci` start. The client repo's CI step timeout is 30 minutes, so firing at 25 leaves
headroom for the diagnostic to be printed and flushed before the outer timeout kills everything. Override
with the env var `WP_CI_SURVIVOR_GRACE_MINUTES=<minutes>`. It is an env var and not a
`webpieces.config.json` key on purpose: the config validator running against this repo is one release
behind the source, so a brand-new config key is rejected as unknown and deadlocks the session — an env var
ships in the same PR as its reader. A config key can be added in a follow-up PR after this release.

If `ps` cannot be run at all, the scan degrades to a one-line warning and the real build result is passed
through — the diagnostic must never replace the failure it is describing.

Fixes 1 and 2 were **not** taken. Piping and forwarding output changes nx's TTY behaviour and colour
handling for every consumer, and it hides rather than reports the leak; the group kill makes the step end
anyway. `process.exit(code)` was already there.

## Secondary findings

- **`wp-ci`'s own docstring and downstream comments are stale.** It documents `nx affected -t lint -t build`;
  it actually runs `nx affected --target=ci`, i.e. the full nine-target chain **including `test`**.
  `monorepo-nx`'s workflow comment (ONE-2077) repeats the stale claim.
  *Checked in ts40 source: `wp-ci.ts`'s docstring already says `nx affected --target=ci` and is correct.
  The stale text is downstream, in `monorepo-nx`'s workflow comment — fix it there.*
- **Validators run twice.** `wp-ci` runs the standalone validators itself and then `--target=ci`, which
  depends on `architecture:validate-complete` again. The second is a cache hit so it is cheap, but
  `Validating API Relations` genuinely appears twice per run.
- **`no-file-import-cycles` runs madge over the `terraform` project and traverses 0 files**, then warns
  that its `excludeRegExp` matched nothing. Harmless, but pure noise in every log.

## Status

**Fixed in this repo (webpieces-ts) by the PR that adds this file** — the loud diagnostic + group reap
described above. That fix reaches consumers on the NEXT `@webpieces/nx-webpieces-rules` release; until
they bump, `monorepo-nx`'s workaround stays.

Everything below is the original report, kept because the mechanism is still a *hypothesis*: the shipped
fix makes the failure **self-describing** rather than proving what the survivors are. The next time it
fires, the banner names the pids and command lines, which is the evidence the probe below was going to
collect.

### The confirming probe has NOT run

The probe (`ps -eo pid,ppid,etimes,stat,args`, an fd scan for whoever holds the step's stdout, and a
process tree, all immediately after `wp-ci` returns) was queued on `monorepo-nx` PR #900 but **never
reached**. A concurrent push created a new run and `concurrency: cancel-in-progress: true` killed it at
5m11s. So the fd-leak mechanism above is the best-supported explanation, **not a demonstrated one**.

That truncated run also left one thing unexplained: it sat **4m41s inside `kami:build`'s
`tsc -p tsconfig.json`** when killed. That may be normal for a large schema library, or it may indicate
something also stalls mid-build. Insufficient data — and this investigation already produced three
confident wrong answers by reading a single log line as causal, so it is recorded rather than theorised
about.

To confirm, re-run the probe on a branch with no competing pushes.

Downstream, `monorepo-nx` is landing a temporary workaround: call `nx affected --target=ci` directly
instead of via `wp-ci`, with full coverage preserved, so product work can ship. That workaround should be
reverted once this is fixed.
