import * as path from 'path';

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
 *      the same way `webpieces.config.json` already is, so the cure is typable from inside the block.
 * Reads and read-only inspection are never blocked either, so an agent can always look before it fixes.
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
        return [
            `❌ @webpieces version SKEW — this worktree and the main tree disagree, so work here is blocked.`,
            '',
            ...this.versionLines(tree, quartet),
            '',
            `   Whichever tree's hooks are live, one of these two releases lints, validates and builds`,
            `   this worktree — and it may be the one this manifest does not ask for.`,
            '',
            `   FIX (usually just git — the pin is TRACKED, so the same commit gives the same version):`,
            `     1. \`git -C ${tree.mainRoot} pull\` and \`git -C ${tree.root} pull\` onto the same main,`,
            `        then \`pnpm install\` in each tree that has a node_modules. A worktree MAY have its`,
            `        own; what it may not have is a DIFFERENT @webpieces version from the main tree.`,
            `     2. Or work in the MAIN tree instead — it is never blocked by this guard.`,
            `     3. Or, if this tree genuinely needs a DIFFERENT version, use a separate CLONE, not a`,
            `        worktree: a clone gets its own governance. (This is the answer to "I need a different`,
            `        version", never to "I need to install here" — installing here is fine.)`,
            '',
            `   STILL ALLOWED HERE: every Read, read-only inspection, \`pnpm install\`, \`git pull\`/\`fetch\`,`,
            `   and edits to pnpm-workspace.yaml / package.json / webpieces.config.json.`,
            `   Do NOT lower the MAIN tree's pin to match — that downgrades every tree, including this`,
            `   session's own governor. If you are a SUBAGENT, you cannot fix the main tree: report to your`,
            `   coordinator that one of you must move to the other's version.`,
        ].join('\n');
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
