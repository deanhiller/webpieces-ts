import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, OnOffMode, ON_OFF_MODES } from './rule-configs';

/**
 * The four guards driven by the SHARED main-sync cache (`.webpieces/main-sync-status.json`, written
 * by the detached refresher): two file-scoped and two bash-scoped, covering the same two states.
 *
 *                     | on stale `main` (state A)  | on an already-merged branch (state B)
 *   Write/Edit        | feature-branch-guard       | feature-branch-guard
 *   Read              | read-stale-guard           | read-stale-guard
 *   Bash              | stale-main-bash-guard      | merged-branch-bash-guard
 *
 * They live together, apart from the code-rule configs, because they share that cache, the
 * `hangTimeoutMinutes` knob that tunes its refresher, and the fail-open discipline that goes with
 * acting on asynchronously-computed data.
 */

// Comprehensive "are you on a proper feature branch?" guard. Replaces the old no-edit-on-main:
//  - on main (synchronous check)                  → block, create a feature branch
//  - branch already merged into main (merged PR)  → block, branch off fresh main
//  - no fork point with origin/main               → block, squash onto a new branch
//  - origin/main moved & touches your files       → block, merge main first
// branchNamingConvention is surfaced in the on-main message; hangTimeoutMinutes tunes the detached
// refresher's stale-lock reclaim window.
export class FeatureBranchGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    branchNamingConvention?: string;
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<FeatureBranchGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        branchNamingConvention: FieldDef.optional('string'),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}

// Blocks Read while the checked-out branch is stale to read FROM — either main is behind origin/main,
// or the feature branch's PR is already merged (a pre-merge snapshot). Both mean the AI reads stale
// FILES, which is the actual damage. Deliberately scoped to Read only: every cure (`git pull origin
// main`, `git checkout -b <new> origin/main`, `pnpm install`, any upgrade) is a Bash command, and Bash
// is never touched by this guard, so there is no allowlist to maintain and no way to wedge.
// (Named main-stale-guard through 0.4.x; the old config key still loads via DEPRECATED_RULE_ALIASES.)
// hangTimeoutMinutes tunes the detached refresher's stale-lock reclaim window (as on
// feature-branch-guard, whose cache this guard shares).
export class ReadStaleGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<ReadStaleGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}

// The BASH-side half of the merged-branch protection. feature-branch-guard blocks Write/Edit and
// read-stale-guard blocks the Read tool when the checked-out branch's PR is already merged — but
// NOTHING blocked ordinary Bash, so an agent that only ran shell (booting servers, `cat`-ing files,
// git) sailed through a whole session on a merged branch (the incident this guard closes). It is a
// bash-scope hookGuard that DEFAULT-DENIES Bash on a merged branch, allowlisting only the recovery /
// cleanup / read-only-inspection commands that get the agent OFF the branch. Shares the same
// precomputed cache (main-sync-status.json / branchAlreadyMerged) the two file guards read.
// hangTimeoutMinutes tunes the detached refresher's stale-lock reclaim window, as on those guards.
export class MergedBranchBashGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<MergedBranchBashGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}

// The BASH-side half of the STALE-MAIN protection (read-stale-guard's State A). read-stale-guard
// blocks the Read tool when local main is behind origin/main, but deliberately never looks at Bash —
// so `cat`/`grep`/`ls` walked the same stale tree through the side door, for a whole session, while
// the logs read "handled" (the incident this guard closes: a main 18 commits behind, an agent
// describing a workflow set missing a workflow that existed upstream). Unlike merged-branch-bash-guard
// this one does NOT default-deny Bash: builds, tests, installs, the `git pull` cure and all git
// METADATA stay open, and only CONTENT reads of workspace files are blocked. Shares the same
// precomputed cache (main-sync-status.json → localMain vs originMain) the file guards read;
// hangTimeoutMinutes tunes the detached refresher's stale-lock reclaim window, as on those guards.
//
// It also carries the PREVENTIVE half of the same protection — blocking a bare `git checkout main`
// unless the pull rides along in the same command — under this one key rather than a second guard,
// because it is the same failure being stopped one step earlier and one on/off switch should govern
// both. That half needs no cache and no timeout, so the config shape is unchanged.
export class StaleMainBashGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<StaleMainBashGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}
