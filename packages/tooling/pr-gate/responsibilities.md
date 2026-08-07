# Responsibilities — pr-gate

Standalone CLIs for the gated PR workflow — start/finish-upsert-pr, start/finish-update (update from main), merge start/end — plus the red/yellow/green PR dashboard that computes merge-gate results and counts newly added rule disables.

## In Scope

- Bin commands shipped from `src/scripts/*`: `wp-start-upsert-pr`, `wp-finish-upsert-pr`, `wp-start-update` (update from main; clean → finalizes, conflict → hand off), `wp-finish-update` (finalize after resolving conflicts). The full-update composition (`runUpdateFromMain`), the build gate (`runBuildAffected`), and 3-point merge-info gathering (`gatherInfo`) are internal `workflow/` functions, not bins.
- The 3-point squash-merge / merge-validation gate workflow (`src/scripts/workflow`).
- The red/yellow/green PR dashboard (`src/dashboard/dashboard.ts`): `computeGateResults`, `countAddedDisables`, and its `GateResult`/`DisableCounts`/`DashboardInput` data classes. THREE renderings, one per surface: `renderPrBody` (the PR description, which is byte-identical to the squash-merge commit body — see `pr-body-is-merge-body.spec.ts`), `renderDetailComment` (the 1st PR comment: full dashboard, all rows, hash points), and `ChecklistCommentRenderer.render` in its own file (the 2nd comment: per-reviewer output). Both comments are upserted by hidden marker via `PrCommentUpserter`. `SquashSettingsEnforcer` keeps GitHub's `squash_merge_commit_title`/`squash_merge_commit_message` pinned to `PR_TITLE`/`PR_BODY` so a UI merge copies the description into `git log` — server-side settings no config key can express, repaired on every stage ③ run.

## Out of Scope

- The actual code-quality gates being counted/rendered — implemented as ESLint rules in `eslint-rules` and Nx `validate-*` executors in `nx-webpieces-rules`.
- Architecture/DI/runtime graph generation — owned by `nx-webpieces-rules`.
- Rule mode/disable config schema — owned by `@webpieces/rules-config`; the dashboard only tallies disables it reads.

## Notes (optional)

Deliberately standalone — no Nx dependency required — so the PR/merge scripts run in CI and locally on their own. Published to npm via the release workflow (OIDC trusted publishing); the public library surface is intentionally small (dashboard gate computation) and mostly backs the bin commands.
