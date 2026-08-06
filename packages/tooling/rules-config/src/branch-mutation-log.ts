import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { DotWebpieces, dotWebpieces } from './state-dir';
import { toError } from './to-error';

// The BRANCH-MUTATION log — an audit trail for every workflow verb that RENAMES or MOVES branches.
// Records START / each phase boundary / END-with-outcome so the next agent (or a human) can
// reconstruct what the tooling did to the branches. Writes to `.webpieces/logs/branch-mutations.log`
// (in a linked worktree: `.webpieces/worktrees/<name>/logs/`) — see LOGS_STATE_DIR for why every
// webpieces log lives under `logs/` and no longer beside the non-log state in `hooks/`.
// Lives in rules-config (the shared dep of pr-gate) so the pr-gate scripts can call it directly.

const LOG_FILE = 'branch-mutations.log';
const LOG_FILE_PREV = 'branch-mutations.1.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors the other webpieces logs)
const MAX_DETAIL_LEN = 400;

// The workflow verb whose branch mutation is being logged (the bin the AI/human invoked).
// `auto-reap` is the odd one out: no human invoked it — it is the detached background refresher
// (sync-main.ts) deleting dead branches on its own. It gets a verb precisely BECAUSE it is
// unattended: a deletion nobody watched happen is the one that most needs an audit line.
export type MutationVerb =
    | 'wp-start-update' | 'wp-finish-update' | 'wp-start-upsert-pr' | 'wp-review-upsert-pr'
    | 'wp-finish-upsert-pr' | 'wp-cleanup' | 'wp-land-pr' | 'auto-reap';

// A boundary within a verb's execution. START/END bracket the whole run; the middle phases mark each
// irreversible git step so an interrupt leaves a breadcrumb at the last phase reached.
// REAP is a whole mutation in one line (a branch delete has no phases) — see BranchReaper.
// REAP_WORKTREE is its worktree twin: archive → `git worktree remove` → `git branch -D`, all three of
// which succeed or fail as one act. It is a SEPARATE phase, not just a REAP with a path, so that
// `grep REAP_WORKTREE` answers "what directories did the tooling delete?" — a strictly scarier
// question than "what refs did it delete?", since a worktree removal takes real files with it.
export type MutationPhase =
    | 'START' | 'BACKUP' | 'CHECKOUT_MAIN' | 'PULL' | 'SQUASH' | 'RENAME'
    | 'FINALIZE' | 'CONFLICT' | 'INTERRUPTED' | 'END' | 'REAP' | 'REAP_WORKTREE';

// Data-only record of one branch-mutation event (per CLAUDE.md: classes for data, explicit construction).
export class BranchMutationEvent {
    verb: MutationVerb;
    phase: MutationPhase;
    fromBranch: string = '';
    toBranch: string = '';
    oldMain: string = '';
    newMain: string = '';
    conflict: boolean = false;
    conflictFiles: string[] = [];
    outcome: string = '';
    artifacts: string[] = [];
    // The commit a DELETED branch pointed at, captured immediately before the delete. This is what
    // makes a reap auditable AND reversible: the work is already in main, and the pre-delete tip is
    // still addressable by hash (the reflog holds it ~90 days), so formatDetail renders a literal
    // `recover=git branch <name> <sha>` next to it. Empty for mutations that delete nothing.
    sha: string = '';
    // The `archive/<date>/<branch>` tag written immediately BEFORE a REAP deleted the branch. When set,
    // formatDetail renders `recover=` against the TAG instead of the sha: a tag is a permanent ref that
    // survives `gc` and reflog expiry and can be pushed, whereas a bare sha is only recoverable while
    // this clone's reflog still holds it. Empty when nothing was tagged (retention policy 'delete').
    archiveTag: string = '';
    // The directory a REAP_WORKTREE removed. When set, `recover=` becomes the WORKTREE form
    // (`git worktree add -b <branch> <path> <ref>`) rather than the bare `git branch` form: putting the
    // ref back does not put the directory back, and a recover line that restores half of what was
    // destroyed is worse than none — it reads as done. Empty for every mutation that removes no directory.
    worktreePath: string = '';

    constructor(verb: MutationVerb, phase: MutationPhase) {
        this.verb = verb;
        this.phase = phase;
    }
}

/** Appends branch-mutation audit lines. `@injectable(bindingScopeValues.Singleton)` so it's injectable + drawn in the design. */
@injectable(bindingScopeValues.Singleton)
export class BranchMutationLog {
    constructor(private readonly dotDir: DotWebpieces = dotWebpieces) {}

    /**
     * LOCAL scope, deliberately — one log per worktree, not one per repo.
     *
     * A SHARED append-only log would genuinely corrupt. `O_APPEND` makes a write indivisible only up to
     * PIPE_BUF, which is 512 bytes on macOS, and a REAP_WORKTREE line carrying
     * `recover=git worktree add -b <branch> <absolute-path> <tag>` exceeds that — concurrent appenders
     * from seven worktrees would interleave into an unrecoverable audit trail, which is the one thing
     * this file exists not to be. Per-worktree, THIS log has one writer and cannot tear.
     *
     * That last claim is narrower than it looks, so do not generalise it (2026-08-06). It holds here
     * because the wp-* bins write this file one command at a time. It does NOT hold for the ai-hook
     * logs in the same directory: Claude Code runs every matching PreToolUse hook IN PARALLEL, and
     * several agents and sessions can share one tree, so a per-worktree name there had several
     * concurrent writers. Those names now carry a `<sessionId>-<agentId|coordinator>-<hook>-` prefix
     * (ai-hook-rules' LogStream). This file keeps a bare name deliberately — LogStream lives in
     * ai-hook-rules, which DEPENDS on rules-config, so the import direction forbids reusing it here.
     * If this log ever gains a second concurrent writer, it needs its own stream identity first.
     *
     * Nothing is lost by keeping it local: under the `worktrees/<name>/` layout the log lives in the
     * PRIMARY clone, so it survives `git worktree remove`, and the whole history is one glob —
     * `<primary>/.webpieces/worktrees/＊/logs/branch-mutations.log`.
     */
    branchMutationLogPath(root: string): string {
        return this.dotDir.logsFile(root, LOG_FILE);
    }

    /**
     * Append one tab-separated line per branch-mutation event to
     * `.webpieces/logs/branch-mutations.log`. Swallows all errors — logging must NEVER block or fail
     * the workflow it is observing.
     */
    logBranchMutation(root: string, event: BranchMutationEvent): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const timestamp = new Date().toISOString();
            const logsDir = this.dotDir.logs(root);
            fs.mkdirSync(logsDir, { recursive: true });

            const logPath = path.join(logsDir, LOG_FILE);
            this.rotateLogFile(logPath, path.join(logsDir, LOG_FILE_PREV));

            const line = [
                `[${timestamp}]`,
                event.verb,
                event.phase,
                this.oneLine(this.formatDetail(event)),
            ].join('\t') + '\n';
            fs.appendFileSync(logPath, line);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // Render only the fields this event actually set, as `key=value` tokens — greppable on one line.
    private formatDetail(event: BranchMutationEvent): string {
        const parts: string[] = [];
        // A rename/move has both ends; a REAP has only the branch it destroyed. Printing `to=?` for
        // the latter reads like a lost destination rather than "there was never one".
        if (event.fromBranch !== '' && event.toBranch !== '') parts.push(`from=${event.fromBranch} to=${event.toBranch}`);
        else if (event.fromBranch !== '') parts.push(`branch=${event.fromBranch}`);
        else if (event.toBranch !== '') parts.push(`from=? to=${event.toBranch}`);
        if (event.oldMain !== '' || event.newMain !== '') parts.push(`oldMain=${event.oldMain || '?'} newMain=${event.newMain || '?'}`);
        if (event.conflict) parts.push('conflict=true');
        if (event.conflictFiles.length > 0) parts.push(`conflictFiles=${event.conflictFiles.length}(${event.conflictFiles.join(',')})`);
        if (event.outcome !== '') parts.push(`outcome=${event.outcome}`);
        // Emitted as one unit so the hash is never separated from the command that undoes the delete.
        // Prefer the archive TAG as the recover ref when there is one — it does not expire.
        if (event.worktreePath !== '') {
            parts.push(this.worktreeDetail(event));
        } else if (event.sha !== '' && event.archiveTag !== '') {
            parts.push(
                `sha=${event.sha} archiveTag=${event.archiveTag} ` +
                `recover=git checkout -b ${event.fromBranch || '?'} ${event.archiveTag}`,
            );
        } else if (event.sha !== '') {
            parts.push(`sha=${event.sha} recover=git branch ${event.fromBranch || '?'} ${event.sha}`);
        }
        for (const artifact of event.artifacts) parts.push(`artifact=${artifact}`);
        return parts.join(' ');
    }

    /**
     * The worktree flavour of the sha/recover token: path, tip, archive tag and the ONE command that
     * puts the directory AND the branch back together.
     *
     * `git worktree add -b <branch> <path> <ref>` is verified by hand and in worktree-reaper.spec.ts —
     * plain `git worktree add <path> <tag>` would restore the files at a DETACHED HEAD, silently losing
     * the branch name the reap destroyed. Falls back to the sha when nothing was archived (retention
     * 'delete'), and to a bare `git worktree add <path>` when there was no branch at all (detached).
     */
    private worktreeDetail(event: BranchMutationEvent): string {
        const ref = event.archiveTag !== '' ? event.archiveTag : event.sha;
        const tokens = [`worktree=${event.worktreePath}`];
        if (event.sha !== '') tokens.push(`sha=${event.sha}`);
        if (event.archiveTag !== '') tokens.push(`archiveTag=${event.archiveTag}`);
        if (ref === '') return tokens.join(' ');
        const recover = event.fromBranch !== ''
            ? `git worktree add -b ${event.fromBranch} ${event.worktreePath} ${ref}`
            : `git worktree add ${event.worktreePath} ${ref}`;
        tokens.push(`recover=${recover}`);
        return tokens.join(' ');
    }

    // Collapse newlines/tabs and cap length so one event is always exactly one log line.
    private oneLine(value: string): string {
        const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
        return flat.length <= MAX_DETAIL_LEN ? flat : flat.slice(0, MAX_DETAIL_LEN) + '…';
    }

    private rotateLogFile(logPath: string, prevPath: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > MAX_LOG_BYTES) {
                if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
                fs.renameSync(logPath, prevPath);
            }
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}

// Temporary migration delegators to BranchMutationLog — removed once consumers inject it.
const branchMutationLogSvc = new BranchMutationLog();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to BranchMutationLog; removed once consumers inject it
export function branchMutationLogPath(root: string): string {
    return branchMutationLogSvc.branchMutationLogPath(root);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to BranchMutationLog; removed once consumers inject it
export function logBranchMutation(root: string, event: BranchMutationEvent): void {
    branchMutationLogSvc.logBranchMutation(root, event);
}
