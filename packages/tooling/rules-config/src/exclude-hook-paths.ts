// Top-level `excludePaths` block from webpieces.config.json: ONE glob list that suppresses hook
// enforcement for matching files (matched against the workspace-relative path). A path listed here is
// hands-off for everything — code-style rules AND file-scoped guards alike.
//
// It used to be TWO independently-varying lists, `rules` and `guards`. The split never earned its
// keep: every consumer set both to the same value, and the one case that would need them to differ
// (exclude a generated tree from style rules but keep the git guards on it) is already served better
// one level down, by a rule's OWN `excludePaths` inside its config block. A path is governed by
// webpieces or it is not, so the top-level block is a single list.
//
// The object form `{ "rules": [...], "guards": [...] }` is RETIRED, not accepted — validateExcludePaths
// rejects it with the union instruction. It was tolerated once, which is precisely why consumer configs
// (this repo's included) stayed on it: an accepted shape is never migrated. See retired-config-keys.ts.
// Data-only (per CLAUDE.md, classes for data). Built once by loadAndValidate after validation.
export class ExcludePaths {
    constructor(readonly paths: string[]) {}
}
