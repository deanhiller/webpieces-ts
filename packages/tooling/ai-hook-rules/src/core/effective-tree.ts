import * as fs from 'fs';
import * as path from 'path';

import { atRoot, dotWebpieces } from '@webpieces/rules-config';

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
 *   2. SAME REPO? `git rev-parse --git-common-dir` is identical for every checkout of one repo, so
 *      comparing it against the governed root's answer is the whole test. Different → FOREIGN (a
 *      nested clone under `repositories/**`), out of scope, hands-off. Not a git repo at all
 *      (`cd /tmp && …`) → OUTSIDE: the guards still run — an absolute path back into the repo must
 *      still be judged — but nothing the command names relative to `/tmp` is workspace content, which
 *      is what ContentReadScan uses `effectiveCwd` for.
 *   3. WHICH CHECKOUT? `--show-toplevel` from `effectiveCwd`. A LINKED WORKTREE of the governed repo is
 *      MANAGED — it is the same project, just another checkout — so guards run, keyed on THAT tree's
 *      branch and its own state.
 *   4. PRIMARY OR LINKED? `gitDir !== commonDir`, git's own canonical test. The governed root itself is
 *      always `primary`: it is home, whether the session was started in the clone or in a worktree.
 *
 * PLACEMENT IS NOT IDENTITY, and assuming it was is the bug this shape exists to prevent. classify()
 * used to short-circuit on "is `effectiveCwd` inside the governed root?" and never ask git anything
 * else — so an agent worktree, which Claude Code checks out INSIDE the repo at
 * `<repo>/.claude/worktrees/agent-XXXX`, took that path, disagreed with `--show-toplevel`, and read as
 * FOREIGN. `foreign` is ALLOW_EXEMPT in runner.ts: every bash guard silently off, and
 * CoordinatorWorktreeGuard (which requires `kind === 'worktree'`) dead code, for exactly the worktrees
 * the harness creates. A common-dir comparison answers the same for both placements, so there is no
 * inside/outside case left to get wrong.
 *
 * WHY THE GIT DIRS AND NOT ONE OF THE OTHER RESOLVERS — state-dir.ts's own header makes this argument
 * in full ("Why `--git-dir` / `--git-common-dir`, and not one of the existing services"); the short
 * version is that `WorktreeService` is a repo-wide ENUMERATION that fails SOFT to `[]` (i.e. fails open
 * into `foreign`, this bug) and `webpieces.config.json` walk-up is GOVERNANCE, not identity — it
 * deliberately climbs past a nested clone's `.git` to the outer config (repo-root.spec.ts pins that),
 * so identity built on it would hand the guards someone else's repo. This class asks DotWebpieces,
 * whose `rev-parse` pair is memoized per directory per process — it is on the hook's blocking path.
 */
// L1's K dimension. 'primary' and 'worktree' are the same PROJECT, so every rule-scoped guard treats
// them alike — guards/L1-location.md writes them as one value, `pw`. Exactly ONE guard separates them,
// and on a dimension that is not the tree at all: CoordinatorWorktreeGuard blocks the COORDINATOR
// (never a subagent) from working inside a linked worktree, because the coordinator's governance is
// anchored at session start and does not follow a `cd`.
//
// 'outside' is produced below (git has no answer for the directory) and consumed NOWHERE, so a command in no git repo is
// judged against governedRoot — a repo it is not in. guards/L1-location.md's "Not done" section explains why
// exempting it must ship together with target-based jurisdiction, never alone.
//
// 'missing' is the directory that is NOT THERE — the worktree reaped out from under a live shell. It is
// separate from 'outside' because the two used to be one `null` from git, and conflating them produced
// the worst message this layer has emitted: "you are in a subdirectory", with a remedy that `cd`s back
// into the deleted path. See MissingDirectoryGuard.
export type TreeKind = 'primary' | 'worktree' | 'foreign' | 'outside' | 'missing';

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

    /**
     * The remedy for a command judged in the wrong directory — `cd '<root>' && <the work>`, with the
     * command's OWN leading `cd` run REPLACED rather than prefixed.
     *
     * A block's remedy must not leave the block's condition true. `atRoot()` alone prefixes, and
     * `effectiveCwd()` resolves the leading run of `cd`s LEFT TO RIGHT — so prefixing `cd '<root>' &&`
     * onto `cd <elsewhere> && git status` still lands in `<elsewhere>`, the identical block fires on
     * the remedy, and the retry prints it with the prefix doubled, then tripled. Structurally
     * non-convergent, and observed in the field against an agent worktree.
     *
     * Only the LEADING run is dropped, because only the leading run moved where the command was judged.
     * A mid-line `cd` is part of the work and is carried through untouched (it is separately rejected by
     * `misplacedCd`).
     */
    remedyAtRoot(root: string, command: string): string {
        return atRoot(root, this.withoutLeadingCds(command));
    }

    private withoutLeadingCds(command: string): string {
        let rest = command;
        for (const segment of this.scanner.commandSegments(command)) {
            const words = this.shell.effectiveWords(segment);
            if (words[0] !== 'cd' && words[0] !== 'pushd') break;
            const at = rest.indexOf(segment);
            if (at < 0) break;
            rest = rest.slice(at + segment.length).replace(LEADING_SEPARATOR, '');
        }
        // A line that is NOTHING but `cd`s has no work to steer; hand it back whole rather than emit an
        // empty remedy.
        return rest.trim() === '' ? command : rest.trim();
    }

    private classify(effectiveCwd: string, governedRoot: string): TreeClassification {
        // GONE, not merely un-gitted. git answers `null` for both "not a repo" and "no such directory",
        // and collapsing the two is what made a reaped worktree read as an ordinary subdirectory of the
        // governed root — with a remedy that `cd`s straight back into the deleted path. One statSync,
        // ahead of the git calls, keeps them apart. The root is the GOVERNED root because that is the
        // only tree left to steer anyone to.
        if (!fs.existsSync(effectiveCwd)) return new TreeClassification('missing', governedRoot);

        const dirs = dotWebpieces.gitDirs(effectiveCwd);
        // Not a git repo at all. Inside the governed tree that can only be a directory git declined to
        // answer for, so it stays `primary` exactly as before; outside it is the `cd /tmp && …` case.
        if (dirs === null) {
            return this.isInside(effectiveCwd, governedRoot)
                ? new TreeClassification('primary', governedRoot)
                : new TreeClassification('outside', governedRoot);
        }

        const treeRoot = dotWebpieces.treeRoot(effectiveCwd) ?? governedRoot;
        const ours = dotWebpieces.gitDirs(governedRoot);
        // ONE test for "is this our repo": the shared git dir. It is identical for every checkout of one
        // repo and different for a nested clone, wherever either happens to sit on disk.
        if (ours === null || !sameDir(dirs.commonDir, ours.commonDir)) {
            return new TreeClassification('foreign', treeRoot);
        }

        // Home is `primary` whether the session was started in the clone or in a worktree — the split
        // CoordinatorWorktreeGuard exists to catch is standing in a tree OTHER than the one that governs
        // you, and there is no split when they are the same directory.
        if (!dirs.isLinkedWorktree || sameDir(treeRoot, governedRoot)) {
            return new TreeClassification('primary', treeRoot);
        }
        return new TreeClassification('worktree', treeRoot);
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

// The separator joining a leading `cd` to what follows it, stripped when withoutLeadingCds() drops the
// `cd`. `&&`, `||`, `;` and a bare newline are the shapes CommandScanner splits a leading run on.
const LEADING_SEPARATOR = /^\s*(?:&&|\|\||;|\n)\s*/;

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

// Two absolute paths naming the same directory. There is no filesystem access here — both sides are
// already git's own answers or a resolved root.
// webpieces-disable no-function-outside-class -- sibling of atRoot(); this module is the resolver plus its pure helpers
function sameDir(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}
