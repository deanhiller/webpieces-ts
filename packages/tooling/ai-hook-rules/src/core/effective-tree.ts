import * as path from 'path';
import { spawnSync } from 'child_process';

import { WorktreeService, Worktree } from '@webpieces/rules-config';

import { CommandScanner } from './command-scan';
import { ShellSegmentScan } from './rules/shell-segment-scan';

/**
 * WHICH TREE does a Bash command actually act on? The ONE resolver every bash guard and the
 * force-to-root check share.
 *
 * WHY it has to exist at all: the shell cwd a PreToolUse hook is handed does not tell you which tree
 * the command acts on. `cd` behaves TWO different ways, and both break a cwd-based guard:
 *
 *   - A `cd` that stays INSIDE the session's working directory PERSISTS to later calls. So the cwd
 *     can be a subdirectory of the governed root, left there by an unrelated command several turns
 *     earlier — a relative path then resolves somewhere other than the root while still being in the
 *     governed tree.
 *   - A `cd` that LEAVES it is reset by the harness, which says so (`Shell cwd was reset to <root>`).
 *     So an agent working in a linked worktree is back in the primary clone by the next call and must
 *     write self-contained `cd <worktree> && …` commands — and the cwd the hook sees is the primary
 *     clone, not the worktree the command targets.
 *
 * (Measured on 2026-08-02: `cd backlog && pwd` → `…/backlog`, then a bare `pwd` in a FRESH call →
 * still `…/backlog`. But `cd ../<linked-worktree> && pwd` → the worktree, then a bare `pwd` → back at
 * the primary clone. An earlier version of this comment asserted `cd` never persists; that was the
 * worktree case generalized. The conclusion below is unchanged — only the reason was wrong.)
 *
 * Either way a guard that reasons from the raw cwd judges the wrong tree. Three field sightings in
 * one session:
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
// L1's K dimension. 'primary' and 'worktree' are the same PROJECT, so every rule-scoped guard treats
// them alike — guards/L1-location.md writes them as one value, `pw`. Exactly ONE guard separates them,
// and on a dimension that is not the tree at all: CoordinatorWorktreeGuard blocks the COORDINATOR
// (never a subagent) from working inside a linked worktree, because the coordinator's governance is
// anchored at session start and does not follow a `cd`.
//
// 'outside' is produced below (gitRoot === null) and consumed NOWHERE, so a command in no git repo is
// judged against governedRoot — a repo it is not in. guards/L1-location.md's "Not done" section explains why
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

    /**
     * Is this command's location UNAMBIGUOUS — or should it be rejected outright? Returns the reason a
     * `cd` in it cannot be resolved, or null when there is nothing wrong.
     *
     * `cd <literal path> && <work>` is the ONE shape that moves where a command is judged, because it
     * is the one shape effectiveCwd() can resolve. Everything else fell back to the shell cwd, which
     * is SAFE (fails closed, nothing smuggled) but silent, and silent is what cost the time:
     *
     *   `cd "$DIR" && git push`          — `path.resolve(cwd, '$DIR')` is a directory that does not
     *                                      exist, not the tree that was meant.
     *   `D=/x; cd "$D"; git push`        — a bare `VAR=value` segment tokenizes to NO words, so the
     *                                      leading run ends before the `cd` is reached.
     *   `git fetch && cd /x && git push` — bash really does run the push in /x; the guard judged it
     *                                      from the shell cwd and blocked it.
     *   `git push && cd /x`              — the push already ran at the root, whatever the trailing
     *                                      `cd` says.
     *
     * Naming these in the block MESSAGE (the previous two PRs) helped, but left the agent to notice a
     * paragraph on an otherwise-normal block. Rejecting is the simpler contract and the one the human
     * asked for: ONE legal shape, everything else refused with the fix spelled out. No verdict changes
     * — every command this rejects was already being judged from the shell cwd — so this trades a
     * silent misdirect for a loud one-line rule, and deletes the near-miss taxonomy entirely.
     *
     * Expanding `$VAR` here is still the fix NOT taken. The resolver decides ONE location for a whole
     * line, so a `cd` that counts retroactively is exactly the `… && cd <exempt-tree>` scope escape.
     *
     * A command containing a HEREDOC (`<<`) is exempt: CommandScanner does not model heredoc bodies,
     * so a commit message or doc that merely CONTAINS `cd /x && …` tokenizes as if it were code, and
     * rejecting that would block ordinary writing. Skipping the rejection cannot open a hole — the
     * location still falls back to the shell cwd exactly as before.
     */
    misplacedCd(command: string): string | null {
        if (HEREDOC.test(command)) return null;

        const segments = this.scanner.commandSegments(command).map(
            (segment: string): readonly string[] => this.shell.effectiveWords(segment));

        // The leading run effectiveCwd() actually consumed — a `cd` at or after this index did not count.
        let consumed = 0;
        while (consumed < segments.length && isCd(segments[consumed])) consumed++;

        for (let i = 0; i < segments.length; i++) {
            if (!isCd(segments[i])) continue;
            if (i >= consumed) {
                return segments.slice(0, i).some(isRealCommand)
                    ? 'it comes after another command — a `cd` only counts at the FRONT of the line'
                    : 'a `VAR=…` assignment precedes it, which ends the scan';
            }
            const target = segments[i][1];
            if (target !== undefined && VARIABLE_TARGET.test(target)) {
                return 'its target is not a literal path (a `$VAR`, `~` or `$(…)` the guard cannot expand)';
            }
        }
        return null;
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

// The two segment shapes unresolvedCd() sorts by. A segment with NO words at all is a bare `VAR=value`
// assignment (CommandScanner strips assignments as command prefixes), which is neither.
// webpieces-disable no-function-outside-class -- pure predicates over one segment's words, siblings of the module-scope helpers below
function isCd(words: readonly string[]): boolean {
    return words[0] === 'cd' || words[0] === 'pushd';
}

// webpieces-disable no-function-outside-class -- sibling of isCd()
function isRealCommand(words: readonly string[]): boolean {
    return words.length > 0 && !isCd(words);
}

// `<<EOF` / `<<'EOF'` / `<<-EOF`. NOT `<` or `<<<` alone — a herestring has no multi-line body, so it
// cannot carry prose that tokenizes as commands.
const HEREDOC = /<<-?\s*['"]?[A-Za-z_]/;

// A `cd` target that is not a literal path: `$DIR`, `${DIR}`, `~`, or a `$(…)`/backtick substitution.
// `~` is here because path.resolve() does not expand it either — the shell does, and the hook never
// sees a shell.
const VARIABLE_TARGET = /[$`]|^~/;

/** Data-only carrier for the two values classify() decides together. */
class TreeClassification {
    readonly kind: TreeKind;
    readonly root: string;

    constructor(kind: TreeKind, root: string) {
        this.kind = kind;
        this.root = root;
    }
}

/**
 * The steering prefix every remedy needs, re-exported from @webpieces/rules-config so the guards, the
 * message builders and pr-gate's worktree notices all emit the IDENTICAL string — including the single
 * quotes that keep it runnable when the repo path contains a space. See atRoot's own header for why the
 * quotes are single and never double.
 */
export { atRoot } from '@webpieces/rules-config';

// The git repo root of `dir`, or null when it is not in a git repo / git is unavailable. `status !== 0`
// IS the expected "not a repo" answer (spawnSync does not throw on a non-zero exit), so no try/catch.
// webpieces-disable no-function-outside-class -- sibling of atRoot(); this module is the resolver plus its two pure helpers
function gitToplevel(dir: string): string | null {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const root = (r.stdout ?? '').trim();
    return root !== '' ? root : null;
}
