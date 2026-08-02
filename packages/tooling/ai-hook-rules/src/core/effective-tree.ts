import * as path from 'path';
import { spawnSync } from 'child_process';

import { WorktreeService, Worktree } from '@webpieces/rules-config';

import { CommandScanner } from './command-scan';
import { ShellSegmentScan } from './rules/shell-segment-scan';

/**
 * WHICH TREE does a Bash command actually act on? The ONE resolver every bash guard and the
 * force-to-root check share.
 *
 * WHY it has to exist at all: an agent's Bash tool does NOT persist `cd` between calls (verified —
 * a standalone `cd <worktree>` followed by `pwd` in the next call reports the primary clone again).
 * So an agent working in a linked worktree writes self-contained `cd <worktree> && …` commands, and
 * the shell cwd the PreToolUse hook is handed is ALWAYS the primary clone. Every guard that reasons
 * from that cwd judges the wrong tree on every single call. Three field sightings in one session:
 * an `ls` of a path outside every repo blocked as "this branch is merged"; a version-drift cure
 * (`pnpm install`) that could not be typed from the directory that needed it; and a command aimed at
 * `/private/tmp` blocked because the PRIMARY clone's main was behind — with a remedy (`git pull` in
 * the primary clone) the agent had been explicitly forbidden to run.
 *
 * Two separate copies of the cwd logic used to exist (the runner's foreign-repo/excludePaths check
 * and force-to-root). They are both this class now: two resolvers WILL disagree about which tree you
 * are in, and a guard that disagrees with the guard beside it is worse than either being wrong.
 *
 * Resolution, in order:
 *   1. `effectiveCwd` — the leading run of `cd`/`pushd` in the command itself, resolved left to right.
 *   2. If that sits under the governed root, the tree is the governed root unless git says the
 *      directory belongs to a DIFFERENT repo (a nested clone under `repositories/**`) → foreign.
 *   3. Otherwise ask git for the worktree list. A LINKED WORKTREE of the governed repo is MANAGED —
 *      it is the same project, just another checkout — so guards run, keyed on THAT tree's branch and
 *      its own `.webpieces/` cache. Before this, a linked worktree read as a different git toplevel
 *      and so as FOREIGN, which silently disabled every guard for `cd <worktree> && …` commands.
 *   4. Anything else that is a git repo → foreign (out of scope, hands-off, as before).
 *   5. Not a git repo at all (`cd /tmp && …`) → OUTSIDE. The guards still run — an absolute path back
 *      into the repo must still be judged — but nothing the command names relative to `/tmp` is
 *      workspace content, which is what ContentReadScan uses `effectiveCwd` for.
 */
// L1's K dimension. 'primary' and 'worktree' are never distinguished by a guard (a linked worktree is
// the same project) — GUARD_MATRIX.md at the repo root writes them as one value, `pw`.
//
// 'outside' is produced below (gitRoot === null) and consumed NOWHERE, so a command in no git repo is
// judged against governedRoot — a repo it is not in. GUARD_MATRIX.md's "Not done" section explains why
// exempting it must ship together with target-based jurisdiction, never alone.
export type TreeKind = 'primary' | 'worktree' | 'foreign' | 'outside';

/** Data-only (per CLAUDE.md, classes for data). */
export class EffectiveTree {
    /** The pre-`cd` cwd the hook was handed. For an agent in a worktree this is the primary clone. */
    readonly shellCwd: string;
    /** The directory the command really runs in, after its own leading `cd`/`pushd` run. */
    readonly effectiveCwd: string;
    /** The tree root to JUDGE: the owning worktree root, the foreign repo root, or the governed root. */
    readonly root: string;
    /** The root that owns webpieces.config.json — where config and excludePaths come from. */
    readonly governedRoot: string;
    readonly kind: TreeKind;
    /** The command acts on a tree other than the shell's own — messages must steer with `cd <root> &&`. */
    readonly redirected: boolean;

    constructor(shellCwd: string, effectiveCwd: string, root: string, governedRoot: string, kind: TreeKind) {
        this.shellCwd = shellCwd;
        this.effectiveCwd = effectiveCwd;
        this.root = root;
        this.governedRoot = governedRoot;
        this.kind = kind;
        this.redirected = path.resolve(root) !== path.resolve(shellCwd);
    }
}

export class EffectiveTreeResolver {
    private readonly worktrees = new WorktreeService();
    private readonly shell: ShellSegmentScan;

    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {
        this.shell = new ShellSegmentScan(scanner);
    }

    resolve(command: string, shellCwd: string, governedRoot: string): EffectiveTree {
        const effectiveCwd = this.effectiveCwd(command, shellCwd);
        const kindAndRoot = this.classify(effectiveCwd, governedRoot);
        return new EffectiveTree(shellCwd, effectiveCwd, kindAndRoot.root, governedRoot, kindAndRoot.kind);
    }

    /**
     * The cwd a command actually runs from, resolving a LEADING run of `cd`/`pushd` in the command.
     *
     * ONLY a leading run counts. Once a non-cd command appears it has ALREADY run in the current dir,
     * so a later `cd` must not retroactively pull it out of scope — otherwise a trailing
     * `… && cd <exempt-tree>` would exempt the WHOLE line, smuggling a root-level `git push` past the
     * guards. `cd a && cd b && git …` resolves left to right, matching the shell.
     *
     * Segmentation is ShellSegmentScan's (over CommandScanner), so quoting is handled exactly as the
     * guards handle it: `echo "cd sub && git push"` is ONE opaque segment whose first word is `echo`,
     * so the quoted `cd` is never picked up and cannot be weaponised into a scope escape.
     */
    effectiveCwd(command: string, shellCwd: string): string {
        let effective = shellCwd;
        for (const segment of this.scanner.commandSegments(command)) {
            const words = this.shell.effectiveWords(segment);
            if (words[0] !== 'cd' && words[0] !== 'pushd') break;
            if (words[1] !== undefined) effective = path.resolve(effective, words[1]);
        }
        return effective;
    }

    private classify(effectiveCwd: string, governedRoot: string): TreeClassification {
        // Fast path — no `cd`, or a `cd` within the governed tree. No worktree enumeration needed, and
        // the nested-clone check keeps its exact previous behaviour.
        if (this.isInside(effectiveCwd, governedRoot)) {
            const gitRoot = gitToplevel(effectiveCwd);
            if (gitRoot === null) return new TreeClassification('primary', governedRoot);
            if (path.resolve(gitRoot) === path.resolve(governedRoot)) return new TreeClassification('primary', governedRoot);
            return new TreeClassification('foreign', gitRoot);
        }

        // Outside the governed tree: is it a linked worktree of the SAME repo? Longest match wins, so a
        // worktree nested under another resolves to the innermost one.
        const owner = this.owningWorktree(effectiveCwd, governedRoot);
        if (owner !== null) {
            return new TreeClassification(owner.isMain ? 'primary' : 'worktree', owner.path);
        }

        const gitRoot = gitToplevel(effectiveCwd);
        if (gitRoot === null) return new TreeClassification('outside', governedRoot);
        if (path.resolve(gitRoot) === path.resolve(governedRoot)) return new TreeClassification('primary', governedRoot);
        return new TreeClassification('foreign', gitRoot);
    }

    private owningWorktree(dir: string, governedRoot: string): Worktree | null {
        let best: Worktree | null = null;
        for (const tree of this.worktrees.listWorktrees(governedRoot)) {
            if (!this.isInside(dir, tree.path)) continue;
            if (best === null || tree.path.length > best.path.length) best = tree;
        }
        return best;
    }

    /** Is `dir` the directory `root` itself, or somewhere beneath it? Pure path math, no filesystem. */
    private isInside(dir: string, root: string): boolean {
        const relative = path.relative(path.resolve(root), path.resolve(dir));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }
}

/** Data-only carrier for the two values classify() decides together. */
class TreeClassification {
    readonly kind: TreeKind;
    readonly root: string;

    constructor(kind: TreeKind, root: string) {
        this.kind = kind;
        this.root = root;
    }
}

/** The steering prefix every remedy needs: `cd` does not persist between tool calls, so a bare
 *  remedy runs in whatever directory the NEXT call starts in — which is never the tree we judged. */
// webpieces-disable no-function-outside-class -- one-line path/string formatter shared by the guards' message builders; a class around it would be ceremony
export function atRoot(root: string, command: string): string {
    return `cd ${root} && ${command}`;
}

// The git repo root of `dir`, or null when it is not in a git repo / git is unavailable. `status !== 0`
// IS the expected "not a repo" answer (spawnSync does not throw on a non-zero exit), so no try/catch.
// webpieces-disable no-function-outside-class -- sibling of atRoot(); this module is the resolver plus its two pure helpers
function gitToplevel(dir: string): string | null {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const root = (r.stdout ?? '').trim();
    return root !== '' ? root : null;
}
