import * as fs from 'fs';
import * as path from 'path';

import { EffectiveTree, EffectiveTreeResolver } from './effective-tree';

/**
 * WHICH TREE owns the FILE a Write/Edit/Read is aimed at? The file-path counterpart to
 * EffectiveTreeResolver, which answers the same question for a Bash command's effective cwd.
 *
 * WHY IT HAS TO EXIST (issue #851). The bash half of this question has been answered by git since
 * effective-tree.ts was written — `isLinkedWorktree` is `--git-dir !== --git-common-dir`, and its header
 * states the principle in capitals: *PLACEMENT IS NOT IDENTITY*. The FILE half never consumed that
 * answer. Every file-scoped guard judged `ctx.workspaceRoot`, which is the walk-up from the SESSION's
 * cwd to whichever `webpieces.config.json` governs it — the PRIMARY clone, for a main-session edit into
 * an agent worktree. Because Claude Code checks a worktree out INSIDE the repo at
 * `<repo>/.claude/worktrees/agent-XXXX`, that walk-up answers "primary" for a path that is manifestly
 * not the primary's, and nothing downstream re-examined it.
 *
 * Measured live on 2026-09-03: an Edit of one import line inside a worktree on a CLEAN branch was
 * refused, citing `pnpm-lock.yaml` and `pnpm-workspace.yaml` — the PRIMARY clone's branch's conflict
 * files. The main-sync cache is already keyed by branch and already held the correct, non-conflicting
 * entry for the worktree's branch, one key over. Only the lookup key was wrong. So this class exists to
 * make the lookup ask the same authority the bash half asks, rather than to introduce a second one.
 *
 * IT ASKS EffectiveTreeResolver, and adds NOTHING of its own beyond finding a directory to ask about.
 * That is deliberate and it is the whole design: two resolvers WILL disagree about which tree a path is
 * in, and this module exists precisely because two layers already did. There is no `.claude/worktrees`
 * string match here and there must never be one — matching on placement is the bug, not the fix.
 *
 * The only thing worth naming is the walk-up: a Write legitimately names a file, and directories, that
 * do not exist yet, and git cannot be asked about a directory that is not there. So we climb to the
 * nearest EXISTING ancestor and ask about that. A parent directory is in the same worktree as the child
 * it is about to contain — that is a property of the filesystem, not a guess.
 */
export class TargetTreeResolver {
    constructor(private readonly trees: EffectiveTreeResolver = new EffectiveTreeResolver()) {}

    /**
     * The tree that owns `targetPath`, classified exactly as a Bash command's cwd would be.
     *
     * `governedRoot` is the fallback for every case with no better answer — an empty path, a path with
     * no existing ancestor at all — and is also what `EffectiveTree.governedRoot` keeps meaning: whose
     * config and excludePaths apply. It is NOT the tree to judge; `EffectiveTree.root` is.
     */
    resolve(targetPath: string, governedRoot: string): EffectiveTree {
        // REAL paths on BOTH sides, or git's answers cannot be compared with each other. Identity here
        // is `commonDir(target) === commonDir(governed)`, and git prints an ABSOLUTE, symlink-resolved
        // path from a linked worktree while printing a bare relative `.git` from the primary clone. So
        // on any repo reached through a symlink — `/var/folders/...` on macOS, which is `/private/var`,
        // and every `os.tmpdir()` path under it — the two strings differ for the same `.git` and the
        // repo's OWN worktree classifies as `foreign`, i.e. every guard silently off. Resolving both
        // sides first is what makes the comparison an answer about git rather than about spelling.
        const governed = this.realDir(governedRoot);
        return this.trees.resolve('', this.nearestExistingDir(targetPath, governed), governed);
    }

    /**
     * The two relative spellings of one target path, resolved together so a caller cannot accidentally
     * use the wrong one. See GovernedPath for why there are two.
     */
    governedPath(targetPath: string, governedRoot: string): GovernedPath {
        const absolute = this.realAbsolute(targetPath);
        const tree = this.resolve(targetPath, governedRoot);
        // `tree.root` and `tree.governedRoot` are already resolved by resolve() above, so both
        // subtractions are real-against-real. Mixing one resolved side with one unresolved one produces
        // a `../../../..` climb out of the filesystem — which reads as "outside the workspace" and
        // would quietly hand every path the wrong verdict on a symlinked checkout.
        return new GovernedPath(
            path.relative(tree.governedRoot, absolute),
            path.relative(tree.root, absolute),
        );
    }

    // The nearest ancestor directory of `targetPath` that EXISTS — the deepest directory git can be
    // asked about — with symlinks resolved. Bounded by the filesystem root (path.dirname is its own
    // fixed point at `/`), so the loop terminates without a counter.
    private nearestExistingDir(targetPath: string, governedRoot: string): string {
        if (targetPath === '') return governedRoot;
        let dir = path.dirname(path.resolve(targetPath));
        for (;;) {
            if (fs.existsSync(dir)) return fs.realpathSync(dir);
            const parent = path.dirname(dir);
            if (parent === dir) return governedRoot;
            dir = parent;
        }
    }

    /**
     * `targetPath` made absolute AND symlink-resolved, including when it does not exist yet.
     *
     * `fs.realpathSync` throws on a missing path, and a Write's target is missing by definition, so the
     * resolvable HEAD of the path (its nearest existing ancestor) is resolved and the not-yet-existing
     * TAIL is re-appended verbatim. That keeps it comparable with `tree.root`, which is git's answer and
     * always real.
     */
    private realAbsolute(targetPath: string): string {
        const absolute = path.resolve(targetPath);
        const tail: string[] = [];
        let dir = absolute;
        for (;;) {
            if (fs.existsSync(dir)) return path.join(fs.realpathSync(dir), ...tail);
            const parent = path.dirname(dir);
            if (parent === dir) return absolute;
            tail.unshift(path.basename(dir));
            dir = parent;
        }
    }

    // A directory made real when it is there, and merely absolute when it is not.
    private realDir(dir: string): string {
        return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
    }
}

/**
 * One target path, in the TWO relative spellings the hook path needs — data-only, per CLAUDE.md.
 *
 * They are different questions and conflating them is issue #851's secondary defect:
 *
 *   `relativePath`     — relative to the GOVERNED root. What `excludePaths`' globs are written against,
 *                        and what the violation report prints.
 *   `treeRelativePath` — relative to the tree that OWNS the file. What `isWebpiecesStateDir` must be
 *                        asked about, because `.webpieces/` is the tooling's state dir *of a tree*, and
 *                        a worktree has its own. Governed-root-relative, a reviewer subagent's
 *                        `<primary>/.claude/worktrees/agent-X/.webpieces/pr-review/<branch>/review.json`
 *                        reads as `.claude/...` and was NOT exempt — while
 *                        `<primary>/.webpieces/worktrees/agent-X/pr-review/.../review-1.json`, the same
 *                        kind of file one directory over, was. `wp-review-upsert-pr` REQUIRES that file
 *                        before `wp-finish-upsert-pr` will open a PR, so the guard could forbid a file
 *                        the gate demands.
 *
 * In the primary clone the two strings are identical, which is why the gap was invisible for so long.
 */
export class GovernedPath {
    readonly relativePath: string;
    readonly treeRelativePath: string;

    constructor(relativePath: string, treeRelativePath: string) {
        this.relativePath = relativePath;
        this.treeRelativePath = treeRelativePath;
    }
}
