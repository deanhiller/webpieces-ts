import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Worktree, WorktreeService, atRoot } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { ReapOutcomeReport, ReapOutcomeSignal, REAP_OUTCOME_MISSING } from './reap-outcome';

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
    /**
     * That worktree's HEAD — which is, by construction, the exact commit GitHub squashed (see
     * LandedTreeResolver). Carried so the child can re-verify the SELECTION rather than take a path on
     * trust: a branch name is not an identity, and this is the half that makes it one.
     */
    readonly head: string;
    /** The primary clone — the child's `cwd`, and the directory a human must `cd` to afterwards. */
    readonly primaryPath: string;
    /** The compiled entry the child runs. '' when it could not be located on disk. */
    readonly entryScript: string;
    /** '' when the hand-off can run; otherwise the reason it cannot, in one human-readable clause. */
    readonly blockedBecause: string;
    /**
     * Is the OPERATOR'S OWN shell inside the directory about to be removed?
     *
     * True is the `/full-cycle` case (the agent lands its own PR from its own worktree) and it is the
     * only case where "your cwd no longer exists" is a true sentence worth shouting. False is the
     * coordinator case — `wp-land-pr --pr <n>` from the primary clone — where saying it would send a
     * reader chasing a directory move they do not need to make.
     */
    readonly standingHere: boolean;
    /** Precomputed (as EffectiveTree does with `redirected`) so no caller re-derives the rule. */
    readonly canReap: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        worktreePath: string,
        branch: string,
        head: string,
        primaryPath: string,
        entryScript: string,
        blockedBecause: string,
        standingHere: boolean,
    ) {
        this.worktreePath = worktreePath;
        this.branch = branch;
        this.head = head;
        this.primaryPath = primaryPath;
        this.entryScript = entryScript;
        this.blockedBecause = blockedBecause;
        this.standingHere = standingHere;
        this.canReap = blockedBecause === '';
    }
}

@injectable(bindingScopeValues.Singleton)
export class LandedWorktreeReaper {
    constructor(
        private readonly worktrees: WorktreeService,
        private readonly signal: ReapOutcomeSignal,
    ) {}

    /**
     * Is there a worktree to reap at all, and can the hand-off run?
     *
     * IT IS TOLD WHICH TREE, AND NO LONGER LOOKS. This used to call `currentWorktree(repoRoot)` and reap
     * only when the tree it was STANDING IN held the landed branch — which made the whole #512 mechanism
     * dead code in the one case it was built for, because `pnpm` hoists a bin's cwd out of a nested
     * `.claude/worktrees/**` worktree and into the primary clone, where `isMain` is true and this
     * returned null. Worse, "the tree I am in" was never the right question: a coordinator landing a dead
     * agent's PR is standing somewhere else entirely. LandedTreeResolver answers the right one — which
     * tree's HEAD is the commit GitHub squashed — and hands the answer here.
     *
     * `null` means there is genuinely no worktree to reap: the branch lived only in the primary clone, or
     * nowhere the sha agrees with. That is the ordinary `pnpm wp-cleanup` case and needs no special
     * sentence. A non-null handoff with `canReap === false` means there IS a corpse but the re-exec is
     * not safely achievable, which is the case that must keep the manual notice.
     */
    plan(repoRoot: string, landed: Worktree | null, invocationCwd: string): WorktreeReapHandoff | null {
        if (landed === null || landed.isMain) return null;
        const standingHere = this.isInside(invocationCwd, landed.path);

        const primary = this.worktrees.listWorktrees(repoRoot)
            .find((tree: Worktree): boolean => tree.isMain);
        if (primary === undefined) {
            return new WorktreeReapHandoff(
                landed.path, landed.branch, landed.head, '<the primary clone>', '',
                'git did not report a primary clone, so there is no safe directory to reap from',
                standingHere);
        }

        const entry = this.reapEntryScript();
        if (entry === '') {
            return new WorktreeReapHandoff(
                landed.path, landed.branch, landed.head, primary.path, '',
                'the reap entry point is not on disk (this package is running unbuilt)', standingHere);
        }
        return new WorktreeReapHandoff(
            landed.path, landed.branch, landed.head, primary.path, entry, '', standingHere);
    }

    /**
     * Is `cwd` the worktree itself or somewhere beneath it? A path COMPARISON, not a git question:
     * the operator may have been in a subdirectory when they ran the command, and that shell is just as
     * dead once the tree goes. Both sides are resolved first so `.`/`..` and a trailing slash cannot
     * turn a match into a miss.
     */
    private isInside(cwd: string, worktreePath: string): boolean {
        const from = path.resolve(cwd);
        const tree = path.resolve(worktreePath);
        return from === tree || from.startsWith(tree + path.sep);
    }

    /**
     * Run the reap in a child process rooted in the primary clone, and render what happened.
     *
     * stdin is `ignore` deliberately: the child must never be able to ask a question. A prompt printed
     * into a landing recap nobody is watching is not consent, and this reap is authorised by the merge
     * that just succeeded, not by an answer.
     *
     * THE EXIT CODE IS NOT THE ANSWER. The child refuses by PRINTING and exiting 0 on purpose — a
     * non-zero exit after a successful merge would report a landed PR as a failed command. So `exit 0`
     * only means "the child ran"; whether the DIRECTORY is gone is a separate statement it makes through
     * ReapOutcomeSignal, and that is the one that gates the "your cwd no longer exists" notice.
     */
    handOff(handoff: WorktreeReapHandoff): string {
        const result = spawnSync(
            process.execPath, [handoff.entryScript, handoff.worktreePath, handoff.branch, handoff.head],
            { cwd: handoff.primaryPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

        const report = this.signal.read(`${result.stdout ?? ''}${result.stderr ?? ''}`);
        const output = report.text.trimEnd();
        const head = '\n' + SEP + `🌲 Reaping ${handoff.worktreePath} from ${handoff.primaryPath}\n` + SEP + '\n'
            + `   The branch just landed, so that directory is dead. The reap runs in a child process\n`
            + `   whose cwd is the primary clone — nothing deletes the directory it is standing in.\n\n`;
        const body = head + (output !== '' ? output + '\n' : '');

        if (result.status !== 0 || !report.removed) {
            return body + this.notRemoved(result.status, report) + this.manualNotice(handoff);
        }
        return body + this.afterReap(handoff);
    }

    /**
     * WHY the directory is still there, distinguishing the two cases a single exit code conflated: the
     * child broke (non-zero), versus the child worked perfectly and DECLINED (exit 0, outcome refused).
     * `--force` is absent from both, and from every path below them: git refusing to remove a worktree
     * holding untracked files is work no archive tag captured.
     */
    private notRemoved(status: number | null, report: ReapOutcomeReport): string {
        if (status !== 0) {
            return `\n   ⚠️  The reap did not complete (exit ${String(status ?? -1)}). Nothing was forced.\n`;
        }
        const why = report.outcome === REAP_OUTCOME_MISSING
            ? 'the child ended without reporting an outcome'
            : `the child reported '${report.outcome}'`;
        return `\n   ⚠️  The worktree was NOT removed — ${why}. It is still on disk.\n`
            + '       Nothing was forced.\n';
    }

    /**
     * The #512 notice, kept verbatim in spirit for every case the re-exec cannot cover. An honest
     * limitation beats a command that deletes its own working directory mid-run.
     */
    manualNotice(handoff: WorktreeReapHandoff): string {
        const why = handoff.blockedBecause !== '' ? `         (${handoff.blockedBecause})\n` : '';
        return `   Next: this branch is checked out in ${handoff.worktreePath}, so neither it nor that\n`
            + '         worktree can be removed from here. Run cleanup from the primary clone instead:\n'
            + `           ${atRoot(handoff.primaryPath, 'pnpm wp-cleanup')}\n`
            + why
            + `         It archives ${handoff.branch} as a tag, removes ${handoff.worktreePath}, then deletes the branch.\n`;
    }

    /**
     * The one thing a human or agent MUST be told after a successful reap — but only when it is TRUE of
     * them. Landing from inside the tree that just went (the `/full-cycle` case) leaves the shell in a
     * deleted directory and every following relative path is a mystery ENOENT until they move. Landing a
     * dead agent's PR from the primary clone removes somebody ELSE's directory, and telling that operator
     * to `cd` somewhere sends them chasing a move they do not need to make.
     */
    private afterReap(handoff: WorktreeReapHandoff): string {
        if (!handoff.standingHere) {
            return `\n   ${handoff.worktreePath} is gone. Your own shell was never inside it.\n`;
        }
        return `\n   ⚠️  ${handoff.worktreePath} NO LONGER EXISTS — your shell is standing in a deleted\n`
            + '       directory, and every following command will fail until you move:\n'
            // Single-quoted for the same reason atRoot() quotes: a primary clone under a path with a
            // space (`/Users/dean hiller/…`, "Google Drive", iCloud) makes a bare `cd` two arguments.
            + `           cd '${handoff.primaryPath}'\n`;
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
