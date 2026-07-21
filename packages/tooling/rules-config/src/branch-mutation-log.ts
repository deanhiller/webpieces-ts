import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

// The BRANCH-MUTATION log — an audit trail for every workflow verb that RENAMES or MOVES branches.
// Records START / each phase boundary / END-with-outcome so the next agent (or a human) can
// reconstruct what the tooling did to the branches. Writes to `.webpieces/hooks/branch-mutations.log`.
// Lives in rules-config (the shared dep of pr-gate) so the pr-gate scripts can call it directly.

const HOOKS_DIR = 'hooks';
const LOG_FILE = 'branch-mutations.log';
const LOG_FILE_PREV = 'branch-mutations.1.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors the other webpieces logs)
const MAX_DETAIL_LEN = 400;

// The workflow verb whose branch mutation is being logged (the bin the AI/human invoked).
// `auto-reap` is the odd one out: no human invoked it — it is the detached background refresher
// (sync-main.ts) deleting dead branches on its own. It gets a verb precisely BECAUSE it is
// unattended: a deletion nobody watched happen is the one that most needs an audit line.
export type MutationVerb =
    | 'wp-start-update' | 'wp-finish-update' | 'wp-start-upsert-pr' | 'wp-finish-upsert-pr'
    | 'wp-cleanup' | 'auto-reap';

// A boundary within a verb's execution. START/END bracket the whole run; the middle phases mark each
// irreversible git step so an interrupt leaves a breadcrumb at the last phase reached.
// REAP is a whole mutation in one line (a branch delete has no phases) — see BranchReaper.
export type MutationPhase =
    | 'START' | 'BACKUP' | 'CHECKOUT_MAIN' | 'PULL' | 'SQUASH' | 'RENAME'
    | 'FINALIZE' | 'CONFLICT' | 'INTERRUPTED' | 'END' | 'REAP';

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

    constructor(verb: MutationVerb, phase: MutationPhase) {
        this.verb = verb;
        this.phase = phase;
    }
}

/** Appends branch-mutation audit lines. `@injectable(bindingScopeValues.Singleton)` so it's injectable + drawn in the design. */
@injectable(bindingScopeValues.Singleton)
export class BranchMutationLog {
    branchMutationLogPath(root: string): string {
        return path.join(root, WEBPIECES_TMP_DIR, HOOKS_DIR, LOG_FILE);
    }

    /**
     * Append one tab-separated line per branch-mutation event to
     * `.webpieces/hooks/branch-mutations.log`. Swallows all errors — logging must NEVER block or fail
     * the workflow it is observing.
     */
    logBranchMutation(root: string, event: BranchMutationEvent): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const timestamp = new Date().toISOString();
            const hooksDir = path.join(root, WEBPIECES_TMP_DIR, HOOKS_DIR);
            fs.mkdirSync(hooksDir, { recursive: true });

            const logPath = path.join(hooksDir, LOG_FILE);
            this.rotateLogFile(logPath, path.join(hooksDir, LOG_FILE_PREV));

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
        if (event.sha !== '') parts.push(`sha=${event.sha} recover=git branch ${event.fromBranch || '?'} ${event.sha}`);
        for (const artifact of event.artifacts) parts.push(`artifact=${artifact}`);
        return parts.join(' ');
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
