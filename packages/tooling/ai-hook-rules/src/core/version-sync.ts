import { spawnSync } from 'child_process';
import * as path from 'path';

import { WORKSPACE_MANIFEST } from '../bin/l0-allowlist';
import { EffectiveTree } from './effective-tree';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import { UMBRELLA_PACKAGE, VersionQuartet, WebpiecesVersions } from './webpieces-versions';

/**
 * L1 row 8 — a tree may not be worked in while its `@webpieces` version disagrees with the MAIN tree's.
 *
 * ─── WHY THIS EXISTS, and what it replaces ─────────────────────────────────────────────────────────
 * The guard hooks are registered ABSOLUTE (`$CLAUDE_PROJECT_DIR/...`), so the MAIN tree governs every
 * tree. That is not a new imposition — it is what was always happening, because a linked worktree has no
 * `node_modules` and ai-hook.sh's upward walk already executed the main tree's binary. The design now
 * says so out loud, which makes ONE case newly important: a worktree whose branch pins a DIFFERENT
 * release is being linted, validated and built by a release it never asked for.
 *
 * This guard makes that case LOUD instead of silent. It replaces `CoordinatorWorktreeGuard`, and the
 * replacement is strictly better on the axis that matters: the old guard keyed off WHO was asking
 * (coordinator vs subagent), and agent identity was measured untrustworthy — a worktree-isolated agent
 * whose tree is auto-reaped at a turn boundary silently resumes with its cwd on the primary clone
 * (reproduced twice, 2026-08-10). This guard keys off the PATH the command acts on, which cannot lie.
 *
 * ─── IT EXISTS TO STOP A LOOP, not to enforce tidiness ─────────────────────────────────────────────
 * A main/worktree manifest mismatch is exactly the shape that produced the founding incident: an agent
 * is shown a fault measured against one tree, runs the prescribed cure in another, the cure succeeds,
 * nothing the guard measures changes, and the guard re-denies. Five identical no-op `pnpm install`s and
 * a fabricated theory about the harness later, a human had to untangle it. Firing EARLY, with a message
 * that names all the versions and all their files, is the whole point. Any future proposal to soften
 * this to a warning must answer: what stops the five-install loop instead?
 *
 * ─── Never a deadlock ──────────────────────────────────────────────────────────────────────────────
 * Two structurally independent escapes, and neither depends on an allowlist regex staying in step:
 *   1. WORK IN THE MAIN TREE — a main-tree-targeted command cannot classify as `worktree`, so it never
 *      reaches this guard at all. No allowlist entry can break it because none is involved.
 *   2. EDIT THE MANIFESTS — `pnpm-workspace.yaml` / `package.json` edits are carved out in the runner
 *      (`runInternal`, beside the `webpieces.config.json` pass) and on the L0 allowlist
 *      (`MANIFEST_FILENAMES` / `isAllowed`), so the cure is typable from inside the block.
 * Reads and read-only inspection are never blocked either, so an agent can always look before it fixes.
 *
 * THAT SECOND ESCAPE WAS FICTION UNTIL 2026-08-20, and this docblock asserted it anyway. Only
 * `CONFIG_FILENAME` was ever carved out, so the one cure the report told a blocked agent to perform —
 * raise this tree's pin — was itself blocked. It is real now, and the `main-ahead` branch of `fixLines`
 * is what spends it. A future edit that narrows either carve-out has to change this text too.
 *
 * ─── The MAIN tree is `tree.mainRoot`, never `tree.governedRoot` ───────────────────────────────────
 * The two differ for exactly the reader this guard is for. `governedRoot` is walked up from the payload
 * cwd to the nearest `webpieces.config.json`, and that file is TRACKED — a linked worktree has its own.
 * So for an agent resident in a worktree `governedRoot` IS the worktree, and comparing it against
 * `tree.root` compared the tree with ITSELF: trivially in sync, guard silent. `mainRoot` is git's
 * `<git-common-dir>/..`, i.e. the clone whose `node_modules` actually supplies the judging binary, and
 * it is the same answer from every checkout. Measured 2026-08-10: a worktree on 0.4.624 with its own
 * install, a main clone on 0.4.616, and not one word from this guard.
 */
/** One version reduced to what an order compare needs. Data-only → a class, per CLAUDE.md. */
class VersionParts {
    constructor(
        /** The numeric core, most-significant first. */
        readonly core: readonly number[],
        /** The pre-release suffix INCLUDING its leading `-`, or '' for a plain release. */
        readonly pre: string,
    ) {}
}

/**
 * WHICH of the five states this skew is. The whole point of naming them is that they do NOT share a
 * cure, and printing the wrong one is what walked a real agent backwards through a downgrade:
 *
 *   `main-inconsistent` — the MAIN tree disagrees with ITSELF (its pin ≠ its own node_modules). Nothing
 *                         about this worktree is wrong; only the main agent can fix it, with one install.
 *   `bump`              — this branch RAISED the pin on purpose. The deliverable is the pin, so every
 *                         ordinary cure would revert it. Main has to come up to meet it.
 *   `main-ahead`        — the governing tree already RUNS a newer release than this tree's pin asks for.
 *                         This is the common case, and it is the ONE case the worktree fixes ITSELF, by
 *                         raising its own pin. No escalation, nobody to ask, nothing to wait for.
 *   `worktree-stale`    — every PIN agrees and so does main's install; only this tree's OWN node_modules
 *                         lags. The one state where a bare `pnpm install` HERE is exactly right.
 *   `main-behind`       — main is genuinely older and must move forward. Only the main agent can pull it.
 */
type SkewCase = 'main-inconsistent' | 'bump' | 'main-ahead' | 'worktree-stale' | 'main-behind';

export class VersionSyncGuard {
    private readonly inspection = new ReadOnlyInspectionScan();
    private readonly versions = new WebpiecesVersions();

    /**
     * True when this tree is a linked worktree whose webpieces version disagrees with the main tree's.
     * This is the `V` dimension of the L1 matrix; the runner asks it for EVERY Bash call so the answer
     * lands in the audit log even when nothing blocks.
     */
    skewed(tree: EffectiveTree): boolean {
        if (!this.applies(tree)) return false;
        return !this.quartetFor(tree).inSync;
    }

    /** The deny report, or null to allow. */
    block(command: string, tree: EffectiveTree): string | null {
        if (!this.applies(tree)) return null;
        if (this.inspection.isReadOnlyInspection(command)) return null;
        if (this.isCureOrLook(command)) return null;
        const quartet = this.quartetFor(tree);
        if (quartet.inSync) return null;
        return this.report(tree, quartet);
    }

    /**
     * Commands that must pass EVEN WHILE THIS GUARD IS BLOCKING, because they are how you get unblocked
     * — or how you look at the tree first.
     *
     * `ReadOnlyInspectionScan` deliberately excludes git and gh OUTRIGHT ("the guards exist to police
     * git, and read-only git is not a line worth drawing while flying blind"), which is right for the
     * guards that police git but WRONG here: this guard's own prescribed cure is `git pull` in both
     * trees. Without this carve-out the guard would deny the exact command it tells the reader to run —
     * the single failure shape this repo has been burned by most often, and the reason the deny text is
     * allowed to promise "STILL ALLOWED HERE: ... pnpm install, git pull/fetch".
     *
     * Deliberately NARROW: fetching, pulling and installing cannot make a skew worse, and every one of
     * them moves the tree toward agreement. Anything that BUILDS, TESTS or COMMITS is still blocked,
     * because those are the operations that would be judged by the wrong release.
     */
    private isCureOrLook(command: string): boolean {
        const words = command.trim().split(/\s+/);
        const head = words[0] ?? '';
        const sub = words[1] ?? '';
        if (head === 'git' || head === 'gh') {
            // `git -C <dir> <sub>` names its own directory; take the first non-flag word after it.
            const subcommand = sub === '-C' ? (words[3] ?? '') : sub;
            return ['pull', 'fetch', 'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'worktree'].includes(subcommand);
        }
        return (head === 'pnpm' || head === 'npm') && (sub === 'install' || sub === 'i');
    }

    /**
     * Is there a cross-tree comparison to make at all? TWO cheap conditions, no file read behind either:
     *
     *   • K is `worktree` — git's `--git-dir ≠ --git-common-dir`, so a repo with no linked worktrees can
     *     never reach the manifests. (In the primary clone this is also structural escape #1: "do the
     *     work in the main tree" needs no allowlist entry to keep working.)
     *   • the two roots are DIFFERENT directories — a tree compared with itself is not a skew, it is the
     *     single-tree pin-vs-install question the L0 drift guard already owns.
     */
    private applies(tree: EffectiveTree): boolean {
        return tree.kind === 'worktree'
            && path.resolve(tree.mainRoot) !== path.resolve(tree.root);
    }

    /** Public so the runner can log all four versions on ALLOW as well as on BLOCK (audit, not just deny). */
    quartetFor(tree: EffectiveTree): VersionQuartet {
        return this.versions.quartet(tree.mainRoot, tree.root);
    }

    // Short on purpose — L0 ran a deliberate message diet and these blocks regress into a wall of text
    // if each one argues its case. State the skew, show every version WITH its file, give the git cure
    // first, then the two structural escapes, then what is still allowed.
    private report(tree: EffectiveTree, quartet: VersionQuartet): string {
        const skew = this.classify(tree, quartet);
        // The two SELF-SERVE cases print NO escalation, and that omission is the deliverable rather than
        // a saving: an escalation block on a cure the reader can perform HERE teaches it to stop and wait
        // for a main agent who has nothing to do. The other three genuinely need the main tree to move.
        const selfServe = skew === 'main-ahead' || skew === 'worktree-stale';
        const escalation = selfServe ? [] : ['', ...this.escalationLines(tree, quartet, skew)];
        return [
            `❌ @webpieces version SKEW — this worktree and the main tree disagree, so work here is blocked.`,
            '',
            ...this.versionLines(tree, quartet),
            '',
            `   Whichever tree's hooks are live, one of these two releases lints, validates and builds`,
            `   this worktree — and it may be the one this manifest does not ask for.`,
            '',
            ...this.fixLines(tree, quartet, skew),
            ...escalation,
            '',
            `   STILL ALLOWED HERE: every Read, read-only inspection, \`pnpm install\`, \`git pull\`/\`fetch\`,`,
            `   and edits to pnpm-workspace.yaml / package.json / webpieces.config.json.`,
            `   Do NOT lower the MAIN tree's pin to match — that downgrades every tree, including this`,
            `   session's own governor.`,
        ].join('\n');
    }

    /**
     * WHICH of the five states this is — asked ONCE, so the FIX block and the escalation block can never
     * describe two different diagnoses of the same skew.
     *
     * Order is not arbitrary. `main-inconsistent` is asked FIRST because it is a fault in the governing
     * tree itself: comparing this worktree against a tree that disagrees with itself picks a direction
     * out of two numbers that are not yet one answer. `bump` next, because a deliberate raise is the one
     * shape where the direction is real but every ordinary cure is harmful.
     */
    private classify(tree: EffectiveTree, quartet: VersionQuartet): SkewCase {
        const mainPin = quartet.main.pinned;
        const mainInstalled = quartet.main.installed;
        if (mainPin !== null && mainInstalled !== null && mainPin !== mainInstalled) return 'main-inconsistent';
        if (this.isDeliberateBump(tree, quartet)) return 'bump';
        const wtPin = quartet.worktree.pinned;
        if (mainInstalled !== null && wtPin === mainInstalled && quartet.worktree.installed !== null) return 'worktree-stale';
        return this.compare(mainInstalled, wtPin) > 0 ? 'main-ahead' : 'main-behind';
    }

    /**
     * SEMVER ORDER of two versions: 1 when `a` is newer, -1 when older, 0 when equal OR undecidable.
     *
     * 0 is the FAIL-SAFE answer and every caller must read it as "no opinion": an unreadable leg, a
     * dist-tag, two different pre-releases, or build metadata (which carries no precedence) all land
     * there, and `classify` then falls to `main-behind`, the branch that ASKS rather than acts. Guessing
     * a direction is how a downgrade gets prescribed, and this repo has already paid for that once.
     *
     * The same rules the shim's awk compare uses, so L0 and L1 cannot order one pair two ways: build
     * metadata stripped, numeric cores compared component-wise, and a pre-release sorting BELOW its
     * release.
     */
    private compare(a: string | null, b: string | null): number {
        if (a === null || b === null || a === b) return 0;
        const aParts = this.parts(a);
        const bParts = this.parts(b);
        if (aParts === null || bParts === null) return 0;
        const width = Math.max(aParts.core.length, bParts.core.length);
        for (let i = 0; i < width; i++) {
            const av = aParts.core[i] ?? 0;
            const bv = bParts.core[i] ?? 0;
            if (av !== bv) return av < bv ? -1 : 1;
        }
        if (aParts.pre === bParts.pre) return 0;
        if (aParts.pre !== '' && bParts.pre === '') return -1;
        if (aParts.pre === '' && bParts.pre !== '') return 1;
        return 0;
    }

    /** One version split into its numeric core and its pre-release suffix, or null if it is not numeric. */
    private parts(version: string): VersionParts | null {
        const noBuild = version.replace(/\+.*$/, '');
        const core = noBuild.replace(/-.*$/, '');
        if (!/^[0-9]+(\.[0-9]+)*$/.test(core)) return null;
        return new VersionParts(
            core.split('.').map((n: string): number => Number(n)),
            noBuild.slice(core.length),
        );
    }

    /**
     * The cure list, which is NOT the same list in both directions — but which, in BOTH directions, is a
     * list of things the reader ASKS FOR rather than runs.
     *
     * The ordinary skew is two trees sitting on different commits of main. The pin is tracked, so putting
     * both trees on the same commit and installing genuinely converges them. That cure is WRONG, and worse
     * than useless, when the branch bumped the pin ON PURPOSE: pulling would revert the deliverable, and
     * an install cannot move a pin in either tree. Printing the git cure first in that case is what sent a
     * real upgrade agent round the loop below.
     *
     * WHAT THIS BLOCK IS NOT ALLOWED TO SAY, in either branch: `git -C <the main tree> pull`. Two defects
     * rode on that one line, and it was printed ABOVE the escalation block, so it was the first thing read.
     *   (a) A worktree-isolated SUBAGENT — the overwhelmingly common reader of this deny — CANNOT run
     *       cross-tree git at all; the harness refuses it (shim-deny-reason.ts records the same
     *       measurement). The one printed cure was the one thing the reader could not perform.
     *   (b) A bare `git pull` acts on whatever branch that tree currently has checked out, and the primary
     *       clone is normally sitting on a feature branch. It pulls the feature branch, the manifest never
     *       moves, the pin never converges, and this guard fires again. The cure has to NAME main:
     *       `cd <main> && git checkout main && git pull`.
     * So every step is prefixed `Tell main agent:` — INDIVIDUALLY, not under one shared header. That
     * repetition is deliberate and is the deliverable: a reader who skims exactly one of these lines must
     * still see it is not their own action. Do not factor it out.
     *
     * The FIX block still prints ABOVE the escalation block, on purpose. Moving it below would split the
     * numbered steps from the versions they refer to, and the one place caps are spent on ENDING the turn
     * (STOP WORKING NOW / RETRYING IS THE BUG) has to stay last and stay unique — a second STOP beat
     * competing with it is exactly the wall-of-text regression the L0 message diet exists to prevent.
     * Labelling carries the "not yours to run" fact instead, which is what the caps header does.
     */
    private fixLines(tree: EffectiveTree, quartet: VersionQuartet, skew: SkewCase): readonly string[] {
        if (skew === 'main-inconsistent') return this.mainInconsistentFix(tree, quartet);
        if (skew === 'main-ahead') return this.mainAheadFix(tree, quartet);
        if (skew === 'worktree-stale') {
            // Every PIN agrees, and so does main's install. The ONLY disagreeing leg is this tree's own
            // node_modules — so this is the one state where a bare `pnpm install` HERE is not a guess,
            // is not a downgrade, and needs nobody's permission. Saying so plainly matters because the
            // other cases all warn AGAINST reaching for it.
            return [
                `   FIX — THIS ONE IS YOURS, AND IT IS ONE COMMAND. Every pin already agrees; only this`,
                `   tree's own node_modules lags at ${this.show(quartet.worktree.installed).trim()}.`,
                `     1. Run \`pnpm install\` HERE, in ${tree.root}.`,
                `   Nothing needs to move in the main tree and there is nobody to ask.`,
            ];
        }
        if (skew === 'bump') {
            return [
                `   THIS BRANCH BUMPED THE PIN ON PURPOSE (${this.show(quartet.main.pinned).trim()} → ${this.show(quartet.worktree.pinned).trim()}), so the usual cures do NOT apply:`,
                `     • \`pnpm install\` cannot help in EITHER tree — an install materializes a pin, never moves one.`,
                `     • \`git pull\` here would revert the bump, which is the whole deliverable.`,
                `     • Wiping this tree's node_modules does NOT help — the two PINS still disagree, and the`,
                `       L0 drift guard blocks in this guard's place.`,
                `   FIX — YOU CANNOT DO THIS FROM HERE. BOTH ways out need the MAIN tree, and cross-tree`,
                `   git is REFUSED to a subagent, so every step below is something you ASK FOR, not run:`,
                `     1. Tell main agent: this task has to be redone in the MAIN tree ${tree.mainRoot}`,
                `        — a version bump cannot be done in a worktree at all.`,
                `     2. Tell main agent: OR raise the MAIN tree's pin to ${this.show(quartet.worktree.pinned).trim()} in`,
                `        ${tree.mainRoot}/${WORKSPACE_MANIFEST} and run \`pnpm install\` there.`,
                `     3. Tell main agent: to tell you when that is complete.`,
                `   THEN AND ONLY THEN will this worktree — and every other subagent — work again.`,
            ];
        }
        return [
            `   FIX — YOU CANNOT DO THIS FROM HERE. Cross-tree git is REFUSED to a subagent, and a bare`,
            `   \`git pull\` moves whatever branch that tree is on — so the cure must NAME main, in main:`,
            `     1. Tell main agent: \`cd ${tree.mainRoot} && git checkout main && git pull\``,
            `     2. Tell main agent: then run \`pnpm install\` in ${tree.mainRoot}`,
            `     3. Tell main agent: then report back what \`ls ${tree.mainRoot}/node_modules/@webpieces\``,
            `        shows, so we know whether the hook shim needs re-upgrading too.`,
            `     4. Tell main agent: to tell you when ALL of that is complete.`,
            `   THEN AND ONLY THEN will this worktree — and every other subagent — work again.`,
            `   The two structural escapes, if converging the trees is not what the coordinator wants:`,
            `     • Do the work in the MAIN tree instead — it is never blocked by this guard.`,
            `     • Or use a separate CLONE, not a worktree, if this tree genuinely needs a DIFFERENT`,
            `       version: a clone gets its own governance. A worktree MAY have its own node_modules, so`,
            `       installing here is fine; what it may not have is a DIFFERENT @webpieces version.`,
        ];
    }

    /**
     * CASE A — the MAIN tree disagrees with ITSELF: its `node_modules` is on one version while its own
     * `pnpm-workspace.yaml` pins another. Nothing in this worktree is wrong, and nothing this worktree
     * does can help.
     *
     * The cure is deliberately the SMALL one. The generic branch prints `git checkout main && git pull`
     * first, and that is over-prescribed here: both halves of the disagreement are already in that tree,
     * so an install materializes the pin it already has and the skew is gone. Printing the pull as well
     * invites a main agent to move main's commit for a fault that is not about main's commit at all.
     */
    private mainInconsistentFix(tree: EffectiveTree, quartet: VersionQuartet): readonly string[] {
        return [
            `   THE MAIN TREE IS INTERNALLY INCONSISTENT — its node_modules is on ${this.show(quartet.main.installed).trim()} but its own`,
            `   pin says ${this.show(quartet.main.pinned).trim()}. That is not this worktree's fault and not this worktree's to fix.`,
            `   FIX — YOU CANNOT DO THIS FROM HERE. Cross-tree git is REFUSED to a subagent:`,
            `     1. Tell main agent: run \`pnpm install\` in ${tree.mainRoot} — no pull is needed, both`,
            `        halves are already in that tree.`,
            `     2. Tell main agent: to tell you when that is complete.`,
            `   THEN AND ONLY THEN will this worktree — and every other subagent — work again.`,
        ];
    }

    /**
     * CASE B — the MAIN tree already RUNS a newer release than this tree's pin asks for. This is the
     * common case, and it is the one the old message got exactly backwards.
     *
     * It is the ONLY case a worktree fixes ITSELF. Nothing needs to move in the main tree — the version
     * the guards will judge this tree by is already installed there — so the entire fix is to raise this
     * tree's own pin to match, which is a one-line edit to a TRACKED file this tree owns. Printing an
     * escalation here (as every earlier revision did) tells an agent to stop and wait for a main agent
     * who has nothing to do, which is how a five-minute edit became a stalled turn.
     *
     * The edit is typable from inside the block because pnpm-workspace.yaml is on the L0 allowlist and
     * carved out in the runner's edit path. That carve-out and this text ship together on purpose: a
     * message prescribing a blocked call is the failure shape this repo has been burned by most often.
     *
     * ON A DETACHED HEAD the edit has no branch to belong to, so it is not offered — an edit that
     * survives nothing is worse than no edit. Get onto a branch, then read this message again.
     */
    private mainAheadFix(tree: EffectiveTree, quartet: VersionQuartet): readonly string[] {
        const target = this.show(quartet.main.installed).trim();
        if (this.isDetachedHead(tree.root)) {
            return [
                `   FIX — GET ONTO A BRANCH FIRST. \`git branch --show-current\` is empty in ${tree.root}, so`,
                `   HEAD is DETACHED and the one-line pin edit below would belong to no branch at all.`,
                `     1. Check out a branch here, then re-run this command.`,
                `     2. The fix is then yours alone: set ${WORKSPACE_MANIFEST}'s catalog pin to ${target}.`,
                `   Nothing needs to move in the main tree — it already runs ${target}.`,
            ];
        }
        const install = quartet.worktree.installed !== null
            ? [`     2. Then run \`pnpm install\` HERE — this tree has its own node_modules, so it must be`,
                `        materialized at ${target} too.`]
            : [`     2. Nothing else. This tree has no node_modules of its own, so there is nothing to install.`];
        return [
            `   FIX — THIS ONE IS YOURS, AND YOU CAN DO IT RIGHT HERE. The main tree is AHEAD: it already`,
            `   runs ${target}, so nothing has to move there and there is nobody to ask.`,
            `     1. Edit ${tree.root}/${WORKSPACE_MANIFEST} — the catalog line for`,
            `        ${UMBRELLA_PACKAGE} — and set it to ${target}. That edit is ALLOWED`,
            `        right now, from inside this block.`,
            ...install,
            `   Do NOT run a bare \`pnpm install\` first: this tree's pin is the STALE side, so installing`,
            `   before the edit materializes the OLD release and this guard fires again.`,
        ];
    }

    /**
     * Is HEAD DETACHED in this tree — i.e. is there no branch for a pin edit to belong to?
     *
     * `branch --show-current`, NOT `rev-parse --abbrev-ref HEAD`: it answers on an UNBORN branch (which
     * every freshly-created worktree is until its first commit, and where `rev-parse` fatals) and prints
     * EMPTY on a detached HEAD, which is exactly the distinction case B needs.
     *
     * A git FAILURE is NOT detached, and the difference is load-bearing: `--show-current` prints nothing
     * in both situations, so keying off the output alone would tell anyone whose tree git cannot read
     * (no repo, a broken index, git absent) that their HEAD is detached — a confident diagnosis of a
     * state nobody measured. Only an exit-0-with-empty-output is detached; anything else falls back to
     * the ordinary branch wording, whose worst case is prescribing an edit that turns out to be moot.
     */
    private isDetachedHead(root: string): boolean {
        const result = spawnSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' });
        return result.status === 0 && (result.stdout ?? '').trim() === '';
    }

    /**
     * THE SUBAGENT CANNOT REACH THE MAIN TREE, so the message it is handed has to be the message it
     * FORWARDS. This used to be one sentence — "report to your coordinator that one of you must move to
     * the other's version" — with no command, no direction and nothing pasteable, and the result was a
     * subagent that correctly diagnosed the block, correctly escalated, and handed its coordinator a
     * request too vague to act on. Worse, the obvious guess ("ask the coordinator to run `pnpm install`
     * in main") is a NO-OP on a bump: it reinstalls main's own pin and nothing moves.
     *
     * So the escalation is rendered as literal text to forward, with the versions and the direction
     * already filled in. A human cannot sit with every agent; the deny has to carry the whole ask.
     *
     * The ask is ROUTED THROUGH THE MAIN AGENT rather than phrased as a command, and that distinction is
     * the whole point of this block. `git -C <mainRoot> pull` reads like something you run from wherever
     * you are standing — so a subagent reads it, tries it, and only then discovers that CROSS-TREE GIT IS
     * REFUSED to a worktree-isolated agent (same measurement shim-deny-reason.ts records: the harness
     * blocks `git -C <other tree>`, and it is git specifically). This skew needs a git pull in main, so
     * the one printed cure was the one thing this session cannot perform. Be precise about that and do
     * NOT overstate it into "you cannot reach that tree at all" — a local `cd <main> && pnpm install`
     * measurably DOES run, it simply cannot move main onto a different commit, which is what a skew
     * requires. The actor who can is the MAIN AGENT running in the MAIN git worktree, so the forwarded
     * text asks for exactly that — and asks to be TOLD WHEN IT IS DONE, because "the work happened" is
     * the event that unblocks this subagent and it has no way to observe it otherwise.
     *
     * And it has to say STOP, in caps, because forwarding is only half of what the subagent must do. One
     * measured subagent transcript re-fired this identical deny 13 TIMES (25 across the whole session,
     * counting two sibling subagents and two parent sessions): the subagent read it, escalated exactly
     * as asked — and then kept making tool calls, because nothing here said that forwarding ENDS the
     * turn. Every retry cost a round trip and pushed the one message that mattered further up the
     * scrollback. The block is not transient and no command from this tree slips past it, so retrying is
     * never a strategy; it is the bug. The caps are spent ONLY on that beat (STOP WORKING NOW / NO
     * further tool calls / RETRYING IS THE BUG / WAIT) — shouting the whole report would just restore
     * the wall of text the L0 message diet exists to prevent.
     */
    private escalationLines(tree: EffectiveTree, quartet: VersionQuartet, skew: SkewCase): readonly string[] {
        return [
            `   SUBAGENT? You cannot fix the main tree from here. Forward this to your coordinator verbatim:`,
            `     > My worktree ${tree.root} is on @webpieces ${this.show(quartet.worktree.pinned).trim()};`,
            `     > the main tree ${tree.mainRoot} is on ${this.show(quartet.main.pinned).trim()}.`,
            ...this.askLines(tree, quartet, skew),
            `   THEN STOP WORKING NOW. Forwarding that message IS the end of your turn: make NO further tool`,
            `   calls and do NOT retry this one — RETRYING IS THE BUG. Every retry re-fires this identical`,
            `   deny and buries the ask above; one subagent did it 13 times, 25 across that whole session.`,
            `   Nothing you can do from this tree clears it. WAIT for the main agent to confirm it is done,`,
            `   then resume — nothing between.`,
        ];
    }

    /**
     * The forwardable ASK, one per case that needs one. `main-ahead` never reaches here — it has nothing
     * to ask for — so the three shapes below cover every escalating case.
     *
     * The bump ask carries the upgrade sentence VERBATIM as Dean wrote it, because it answers the one
     * question an upgrade agent gets wrong: "webpieces cannot be upgraded from a worktree" is not a
     * missing permission it can route around, it is a property of who governs whom. Its `STOP` is about
     * the ROLE ("you are the wrong agent for this task"); the caps beat at the end of the block is about
     * the TURN ("forwarding ends it"). Two different instructions, and the closer stays last and unique.
     */
    private askLines(tree: EffectiveTree, quartet: VersionQuartet, skew: SkewCase): readonly string[] {
        if (skew === 'bump') {
            return [
                `     > A \`pnpm install\` in main will NOT fix this — main's PIN has to move. Pick one:`,
                `     >  (a) I redo this task in the MAIN tree (a version bump cannot be done in a worktree), or`,
                `     >  (b) you TELL THE MAIN AGENT in the MAIN git worktree ${tree.mainRoot} to`,
                `     >      raise main's catalog pin to ${this.show(quartet.worktree.pinned).trim()} and \`pnpm install\` there, and to tell me when it is complete`,
                `     >      so I can continue here. I cannot reach that tree from here.`,
                `   If you are a subagent upgrading webpieces, STOP — only main agents in worktrees can do`,
                `   this. Otherwise your main agent must \`git pull\` main: main has an earlier version of`,
                `   webpieces pinned and must upgrade. You MUST tell the main agent to pull main and`,
                `   \`pnpm install\`.`,
            ];
        }
        if (skew === 'main-inconsistent') {
            return [
                `     > Please TELL THE MAIN AGENT in the MAIN git worktree ${tree.mainRoot} to run`,
                `     > \`pnpm install\` there — its node_modules is on ${this.show(quartet.main.installed).trim()} but its own pin says`,
                `     > ${this.show(quartet.main.pinned).trim()}, so no pull is needed — and to tell me when it is complete so I can`,
                `     > continue working. I cannot reach that tree from here.`,
            ];
        }
        return [
            `     > Please TELL THE MAIN AGENT in the MAIN git worktree ${tree.mainRoot} to run`,
            `     > \`git checkout main && git pull && pnpm install\` there — it must NAME main, since a bare`,
            `     > pull moves whatever branch that tree is on — so both trees are on the same release, and`,
            `     > to tell me when it is complete so I can continue working, and what`,
            `     > \`ls node_modules/@webpieces\` shows there. I cannot reach that tree from here.`,
        ];
    }

    /**
     * Did THIS BRANCH change the pin, as opposed to the two trees having drifted onto different commits?
     *
     * Only answerable now that both pin legs actually resolve — before the catalog reader followed YAML
     * anchors they both read null on the repos that pin via an anchor, so every skew looked alike and the
     * report could only ever print the one generic cure.
     *
     * Two git spawns worst case, on the BLOCK path only (this is never reached on an allow), and
     * best-effort: a git failure answers "not a deliberate bump", which falls back to the generic cure
     * that was the only text this report had before.
     */
    private isDeliberateBump(tree: EffectiveTree, quartet: VersionQuartet): boolean {
        if (quartet.main.pinned === null || quartet.worktree.pinned === null) return false;
        if (quartet.main.pinned === quartet.worktree.pinned) return false;
        return this.touchesWorkspaceFile(tree.root, ['status', '--porcelain', '--', WORKSPACE_MANIFEST])
            || this.touchesWorkspaceFile(tree.root, ['diff', '--name-only', 'origin/main...HEAD', '--', WORKSPACE_MANIFEST]);
    }

    private touchesWorkspaceFile(root: string, args: readonly string[]): boolean {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
        return result.status === 0 && (result.stdout ?? '').trim() !== '';
    }

    // Every version WITH the file it came from. An agent that is told "they disagree" without being told
    // WHICH FILE to edit re-derives it by grepping, which is exactly the turn-burning this guard exists
    // to prevent. Unreadable legs are printed as `-` rather than omitted, so the reader can tell
    // "this one is absent" from "I forgot to look".
    private versionLines(tree: EffectiveTree, quartet: VersionQuartet): readonly string[] {
        const lines = [
            `   main pin       ${this.show(quartet.main.pinned)}   ${tree.mainRoot}/pnpm-workspace.yaml`,
            `   main installed ${this.show(quartet.main.installed)}   ${tree.mainRoot}/node_modules/${UMBRELLA_PACKAGE}`,
            `                  ^ the binary judging this very call`,
            `   this worktree  ${this.show(quartet.worktree.pinned)}   ${tree.root}/pnpm-workspace.yaml`,
        ];
        if (quartet.worktree.installed !== null) {
            lines.push(`   its installed  ${this.show(quartet.worktree.installed)}   ${tree.root}/node_modules/${UMBRELLA_PACKAGE}`);
            lines.push('                  ^ what nx, vitest and eslint load IN this tree');
        }
        const others = this.versions.otherWorktrees(tree.mainRoot, tree.root);
        if (others.length > 0) {
            lines.push(`   NOTE ${others.length} other worktree(s) exist and are governed the same way — if they are`);
            lines.push('        skewed too, their agents are already mis-governed. Consider clones, or');
            lines.push('        serializing the work in the main tree.');
        }
        return lines;
    }

    private show(version: string | null): string {
        return (version ?? '-').padEnd(10);
    }
}
