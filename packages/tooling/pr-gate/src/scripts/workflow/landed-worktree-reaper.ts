import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Worktree, WorktreeService } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * The RE-EXEC half of `wp-land-pr`: reap the worktree the command is standing in, from a process that
 * is NOT standing in it.
 *
 * THE PROBLEM. `wp-land-pr` squash-merges the branch checked out in the worktree it runs in. The
 * moment that lands, both the branch and the directory are dead — but removing them from in here means
 * deleting the files underneath the running process, which is exactly what every rail in WorktreeReaper
 * refuses. #512 took this to an honest halfway point: print `cd <primary> && pnpm wp-cleanup` and stop.
 * Correct, and the single most-skipped step in the whole flow, because the PR is already landed and the
 * work FEELS done. Every skipped one leaves a corpse, and corpses are what trip branch-creation-guard.
 *
 * THE FIX. Do not reap in this process at all — hand the reap to a CHILD process whose `cwd` is the
 * PRIMARY CLONE. The child's cwd is a directory nobody is deleting, so `git worktree remove` is an
 * ordinary removal of somebody else's directory, and every existing rail still holds inside the child
 * (it refuses its own cwd, which is now the primary clone, and it refuses the primary clone by name).
 *
 * WHY `WorktreeService` AND NOT `EffectiveTreeResolver`. EffectiveTreeResolver (ai-hook-rules) answers
 * "which tree does this BASH COMMAND STRING act on" — it takes a command, resolves its leading `cd`
 * run, and classifies foreign/outside repos for the PreToolUse guards. There is no command string
 * here, pr-gate does not (and must not) depend on ai-hook-rules, and the only question being asked is
 * "which of git's worktrees is the primary clone, and which one holds this branch". That is
 * WorktreeService's whole job, and it is already the authority WorktreeReaper itself uses to decide
 * what is protected — using a second resolver would risk the two disagreeing about which tree we are
 * in, which for a directory deletion is the one disagreement nobody survives.
 *
 * WHY A CHILD AND NOT AN IN-PROCESS `chdir`. `process.chdir(primary)` would leave this node process's
 * own module graph rooted in a directory that is about to be deleted, and its lazily-resolved requires
 * with it. The child is spawned from THIS package's own files (same version — no skew with whatever
 * the primary clone has installed), and it finishes loading them before it removes anything.
 */

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * Data-only (per CLAUDE.md, classes for data). The decision about the just-landed worktree: which
 * directory, which branch, where the reap must run FROM, and — when it cannot run — why not.
 */
export class WorktreeReapHandoff {
    /** The linked worktree holding the branch that was just landed. */
    readonly worktreePath: string;
    readonly branch: string;
    /** The primary clone — the child's `cwd`, and the directory a human must `cd` to afterwards. */
    readonly primaryPath: string;
    /** The compiled entry the child runs. '' when it could not be located on disk. */
    readonly entryScript: string;
    /** '' when the hand-off can run; otherwise the reason it cannot, in one human-readable clause. */
    readonly blockedBecause: string;
    /** Precomputed (as EffectiveTree does with `redirected`) so no caller re-derives the rule. */
    readonly canReap: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        worktreePath: string,
        branch: string,
        primaryPath: string,
        entryScript: string,
        blockedBecause: string,
    ) {
        this.worktreePath = worktreePath;
        this.branch = branch;
        this.primaryPath = primaryPath;
        this.entryScript = entryScript;
        this.blockedBecause = blockedBecause;
        this.canReap = blockedBecause === '';
    }
}

@injectable(bindingScopeValues.Singleton)
export class LandedWorktreeReaper {
    constructor(private readonly worktrees: WorktreeService) {}

    /**
     * Is there a worktree to reap at all, and can the hand-off run?
     *
     * `null` means "nothing to do here" — we are in the primary clone, or in a worktree that does not
     * hold the branch that just landed. That is the ordinary `pnpm wp-cleanup` case and needs no
     * special sentence. A non-null handoff with `canReap === false` means there IS a corpse but the
     * re-exec is not safely achievable, which is the case that must keep the manual notice.
     */
    plan(repoRoot: string, landedBranch: string): WorktreeReapHandoff | null {
        const here = this.worktrees.currentWorktree(repoRoot);
        if (here === null || here.isMain || here.branch !== landedBranch) return null;

        const primary = this.worktrees.listWorktrees(repoRoot)
            .find((tree: Worktree): boolean => tree.isMain);
        if (primary === undefined) {
            return new WorktreeReapHandoff(
                here.path, landedBranch, '<the primary clone>', '',
                'git did not report a primary clone, so there is no safe directory to reap from');
        }

        const entry = this.reapEntryScript();
        if (entry === '') {
            return new WorktreeReapHandoff(
                here.path, landedBranch, primary.path, '',
                'the reap entry point is not on disk (this package is running unbuilt)');
        }
        return new WorktreeReapHandoff(here.path, landedBranch, primary.path, entry, '');
    }

    /**
     * Run the reap in a child process rooted in the primary clone, and render what happened.
     *
     * stdin is `ignore` deliberately: the child must never be able to ask a question. A prompt printed
     * into a landing recap nobody is watching is not consent, and this reap is authorised by the merge
     * that just succeeded, not by an answer.
     */
    handOff(handoff: WorktreeReapHandoff): string {
        const result = spawnSync(
            process.execPath, [handoff.entryScript, handoff.worktreePath, handoff.branch],
            { cwd: handoff.primaryPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
        const head = '\n' + SEP + `🌲 Reaping this worktree from ${handoff.primaryPath}\n` + SEP + '\n'
            + `   The branch just landed, so this directory is dead. The reap runs in a child process\n`
            + `   whose cwd is the primary clone — nothing deletes the directory it is standing in.\n\n`;

        if (result.status !== 0) {
            return head + (output !== '' ? output + '\n' : '')
                + `\n   ⚠️  The reap did not complete (exit ${String(result.status ?? -1)}). Nothing was forced.\n`
                + this.manualNotice(handoff);
        }
        return head + (output !== '' ? output + '\n' : '') + this.afterReap(handoff);
    }

    /**
     * The #512 notice, kept verbatim in spirit for every case the re-exec cannot cover. An honest
     * limitation beats a command that deletes its own working directory mid-run.
     */
    manualNotice(handoff: WorktreeReapHandoff): string {
        const why = handoff.blockedBecause !== '' ? `         (${handoff.blockedBecause})\n` : '';
        return '   Next: this branch is checked out in THIS worktree, so neither it nor the worktree can\n'
            + '         be removed from in here. Run cleanup from the primary clone instead:\n'
            + `           cd ${handoff.primaryPath} && pnpm wp-cleanup\n`
            + why
            + `         It archives ${handoff.branch} as a tag, removes ${handoff.worktreePath}, then deletes the branch.\n`;
    }

    /**
     * The one thing a human or agent MUST be told after a successful reap: the shell they typed this
     * into is now sitting in a directory that no longer exists. Every relative path from here on is a
     * mystery ENOENT unless they move.
     */
    private afterReap(handoff: WorktreeReapHandoff): string {
        return `\n   ⚠️  ${handoff.worktreePath} NO LONGER EXISTS — your shell is standing in a deleted\n`
            + '       directory, and every following command will fail until you move:\n'
            + `           cd ${handoff.primaryPath}\n`;
    }

    /**
     * WHERE the child's entry point lives — a seam, overridden in the spec, because under vitest this
     * package runs from `.ts` sources and the compiled sibling does not exist.
     *
     * Resolved from `__dirname`, i.e. from THIS package's own installed files, NOT by remapping a path
     * into the primary clone. The primary clone may have a different @webpieces/pr-gate version
     * installed, and re-exec'ing a build that predates this feature would silently do something else.
     * The files are read into the child before it removes anything, so the directory going away
     * underneath them afterwards is harmless.
     */
    protected reapEntryScript(): string {
        const entry = path.join(__dirname, '..', 'wp-reap-worktree.js');
        return fs.existsSync(entry) ? entry : '';
    }
}
