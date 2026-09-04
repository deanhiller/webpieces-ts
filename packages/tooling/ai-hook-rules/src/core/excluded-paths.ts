import * as path from 'path';

import { ExcludePaths, isWebpiecesStateDir } from '@webpieces/rules-config';

import { EffectiveTree } from './effective-tree';
import { globMatches } from './load-rules';
import { GovernedPath } from './target-tree';
import type { Rule } from './types';

/**
 * L1's FILTER — which rules have jurisdiction over one path — and the one helper that builds its
 * argument for the bash surface.
 *
 * Lifted out of runner.ts, which the file-size rule had outgrown. It is a natural seam rather than a
 * page-count fix: this is the only place `excludePaths` and the hard-coded `.webpieces/` skip are
 * consulted, and runner.ts is otherwise the four tool ENTRY POINTS and their L0/L1 preamble.
 */

// Drop every rule excluded for this path (webpieces.config.json → excludePaths). ONE glob list: a path
// listed there is hands-off for code-style rules and file-scoped guards alike, because webpieces either
// governs a path or it does not. Per-rule carve-outs live in the rule's own `excludePaths`.
// This is L1's FILTER (not a table row) — see guards/L1-location.md.
//
// It takes a GovernedPath and not a bare string because the two questions below are asked against
// DIFFERENT roots, and answering both from the governed-root spelling is issue #851's secondary defect:
// the excludePaths globs are authored against the governed root, while `.webpieces/` is the state dir OF
// A TREE and a linked worktree has its own. One argument carrying both spellings is what stops a caller
// picking the wrong one; see GovernedPath.
// webpieces-disable no-function-outside-class -- L1's filter, a pure predicate over one path and one glob list; it is called from four module-scope entry points in runner.ts and a class here would be a namespace with no state
export function filterByExcludedPaths(rules: readonly Rule[], governed: GovernedPath, ex: ExcludePaths): readonly Rule[] {
    // webpieces' OWN gitignored state dir is never governed, config or no config. Ahead of the list on
    // purpose — see isWebpiecesStateDir for why it is code and not a seeded glob. Asked about the
    // OWNING tree's spelling, so `<primary>/.claude/worktrees/agent-X/.webpieces/...` is exempt for the
    // identical reason `<primary>/.webpieces/...` is: nothing under it is tracked, reviewable or
    // revertable in the tree it belongs to.
    if (isWebpiecesStateDir(governed.treeRelativePath)) return [];
    if (ex.paths.some((p: string): boolean => globMatches(p, governed.relativePath))) return [];
    return rules;
}

/**
 * The bash surface's GovernedPath, built from the tree EffectiveTreeResolver has already classified —
 * so it costs no extra git call on the hook's blocking path.
 *
 * Both spellings of the command's effective cwd: relative to the governed root for the excludePaths
 * globs, and relative to the OWNING tree for the `.webpieces/` skip — which for
 * `cd <worktree>/.webpieces && …` is the worktree's state dir, not the primary's. Both are '' for a
 * command with no leading `cd`, which matches no glob and is not the state dir.
 */
// webpieces-disable no-function-outside-class -- the bash-side constructor for the value above, beside it
export function bashGovernedPath(tree: EffectiveTree, workspaceRoot: string): GovernedPath {
    return new GovernedPath(
        path.relative(workspaceRoot, tree.effectiveCwd),
        path.relative(tree.root, tree.effectiveCwd),
    );
}
