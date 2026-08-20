import { WEBPIECES_TMP_DIR } from './constants';

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

/**
 * webpieces' OWN state directory is NEVER governed, whatever `excludePaths` says.
 *
 * `.webpieces/` is gitignored in every consumer, so nothing under it can reach a branch, be reviewed,
 * be reverted, or be lost to a checkout — every justification the branch-state guard prints about
 * protecting `main` is vacuous there. Leaving that to config made the exemption OPTIONAL, and the
 * tooling writes into the directory itself: `wp-review-upsert-pr` asks a reviewer subagent to write its
 * verdict to `<primary>/.webpieces/worktrees/agent-<id>/pr-review/<branch>/`, feature-branch-guard
 * resolved that write to the PRIMARY clone and judged the primary's live branch — a tree the subagent
 * is not standing in — so the reviewer was blocked with "You should not be working on main" whenever an
 * unrelated session happened to leave the primary there. Hard-coding the skip makes that whole class
 * unreachable, and fixes existing consumer repos the moment they upgrade the pin.
 *
 * THIS IS THE ONLY SPELLING. There is deliberately no companion `.webpieces/**` glob seeded into
 * `excludePaths` — a config entry that changed nothing would be a second spelling of a decision that
 * already has one, and a strictly WEAKER one at that: the repo's glob matcher compiles `.webpieces/**`
 * to an anchored regex whose `/` is literal, so it misses the bare directory `.webpieces` that this
 * predicate matches. A consumer reading such a glob would also conclude the exemption is config-driven
 * and therefore removable, which is exactly the belief this predicate exists to destroy.
 *
 * FIRST SEGMENT ONLY, deliberately: this is the tooling's own directory at the workspace root, not any
 * path that merely contains the name. A `relativePath` that escapes the workspace ('../x'), or that is
 * '' (the Bash path with no `cd`), has a first segment of '..'/'' and does not match.
 */
// webpieces-disable no-function-outside-class -- leaf predicate over one path string, beside the constant it tests; a class here would be a namespace with no state
export function isWebpiecesStateDir(relativePath: string): boolean {
    return relativePath.replace(/\\/g, '/').split('/')[0] === WEBPIECES_TMP_DIR;
}
