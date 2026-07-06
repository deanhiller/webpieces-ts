# Responsibilities — pr-gate

Standalone CLIs for the gated PR workflow — start/finish-upsert-pr, update-from-main, gather-info, merge start/end, build-affected — plus the red/yellow/green PR dashboard that computes merge-gate results and counts newly added rule disables.

## In Scope

- Bin commands shipped from `src/scripts/*`: `wp-start-upsert-pr`, `wp-finish-upsert-pr`, `wp-update-start` (update from main; clean → finalizes, conflict → hand off), `wp-update-end` (finalize after resolving conflicts), `wp-git-gather` (gather info), `wp-build-affected`. The full-update composition (`runUpdateFromMain`) is an internal `workflow/` function, not a bin.
- The 3-point squash-merge / merge-validation gate workflow (`src/scripts/workflow`).
- The red/yellow/green PR dashboard (`src/dashboard/dashboard.ts`): `computeGateResults`, `countAddedDisables`, `renderDashboard`, and its `GateResult`/`DisableCounts`/`DashboardInput` data classes.

## Out of Scope

- The actual code-quality gates being counted/rendered — implemented as ESLint rules in `eslint-rules` and Nx `validate-*` executors in `nx-webpieces-rules`.
- Architecture/DI/runtime graph generation — owned by `nx-webpieces-rules`.
- Rule mode/disable config schema — owned by `@webpieces/rules-config`; the dashboard only tallies disables it reads.

## Notes (optional)

Deliberately standalone — no Nx dependency required — so the PR/merge scripts run in CI and locally on their own. Published to npm via the release workflow (OIDC trusted publishing); the public library surface is intentionally small (dashboard gate computation) and mostly backs the bin commands.
