import * as fs from 'fs';
import * as path from 'path';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

// The BRANCH-MUTATION log — an audit trail for every workflow verb that RENAMES or MOVES branches
// (wp-start-update / wp-finish-update / wp-start-upsert-pr / wp-finish-upsert-pr and the merge-start /
// merge-end primitives they compose). Before this, a branch could silently rename wpN → wpN+1 under
// the agent (backup, checkout main, pull, squash-merge, rename) with ONLY `git reflog` as evidence —
// nothing in `.webpieces/`. This log records START / each phase boundary / END-with-outcome so the
// next agent (or a human) can reconstruct what the tooling did to the branches and where the merge/PR
// artifacts landed. Kept SEPARATE from the read-only refresher log (guard-async-work.log) so that log
// stays purely about the async cache. Writes to `.webpieces/hooks/branch-mutations.log`.
//
// Lives in rules-config (the shared dep of pr-gate) so the pr-gate scripts can call it directly.

const HOOKS_DIR = 'hooks';
const LOG_FILE = 'branch-mutations.log';
const LOG_FILE_PREV = 'branch-mutations.1.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors the other webpieces logs)
const MAX_DETAIL_LEN = 400;

// The workflow verb whose branch mutation is being logged (the bin the AI/human invoked).
export type MutationVerb = 'wp-start-update' | 'wp-finish-update' | 'wp-start-upsert-pr' | 'wp-finish-upsert-pr';

// A boundary within a verb's execution. START/END bracket the whole run; the middle phases mark each
// irreversible git step so an interrupt leaves a breadcrumb at the last phase reached.
export type MutationPhase =
    | 'START' | 'BACKUP' | 'CHECKOUT_MAIN' | 'PULL' | 'SQUASH' | 'RENAME'
    | 'FINALIZE' | 'CONFLICT' | 'INTERRUPTED' | 'END';

// Data-only record of one branch-mutation event (per CLAUDE.md: classes for data, explicit
// construction). `verb` + `phase` are always set; the rest describe the transition and default to
// empty so a call site fills only what that phase knows (e.g. RENAME sets from/to, PULL sets
// oldMain/newMain, CONFLICT sets conflictFiles + artifacts, END sets outcome).
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

    constructor(verb: MutationVerb, phase: MutationPhase) {
        this.verb = verb;
        this.phase = phase;
    }
}

export function branchMutationLogPath(root: string): string {
    return path.join(root, WEBPIECES_TMP_DIR, HOOKS_DIR, LOG_FILE);
}

/**
 * Append one tab-separated line per branch-mutation event to `.webpieces/hooks/branch-mutations.log`.
 * `root` is the workspace root holding `.webpieces`. Swallows all errors — logging must NEVER block or
 * fail the workflow it is observing (mirrors logSyncEvent's contract).
 */
export function logBranchMutation(root: string, event: BranchMutationEvent): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        const hooksDir = path.join(root, WEBPIECES_TMP_DIR, HOOKS_DIR);
        fs.mkdirSync(hooksDir, { recursive: true });

        const logPath = path.join(hooksDir, LOG_FILE);
        rotateLogFile(logPath, path.join(hooksDir, LOG_FILE_PREV));

        const line = [
            `[${timestamp}]`,
            event.verb,
            event.phase,
            oneLine(formatDetail(event)),
        ].join('\t') + '\n';
        fs.appendFileSync(logPath, line);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}

// Render only the fields this event actually set, as `key=value` tokens — so a RENAME line reads
// `from=… to=…` and a PULL line reads `oldMain=… newMain=…`, all greppable on one line.
function formatDetail(event: BranchMutationEvent): string {
    const parts: string[] = [];
    if (event.fromBranch !== '' || event.toBranch !== '') parts.push(`from=${event.fromBranch || '?'} to=${event.toBranch || '?'}`);
    if (event.oldMain !== '' || event.newMain !== '') parts.push(`oldMain=${event.oldMain || '?'} newMain=${event.newMain || '?'}`);
    if (event.conflict) parts.push('conflict=true');
    if (event.conflictFiles.length > 0) parts.push(`conflictFiles=${event.conflictFiles.length}(${event.conflictFiles.join(',')})`);
    if (event.outcome !== '') parts.push(`outcome=${event.outcome}`);
    for (const artifact of event.artifacts) parts.push(`artifact=${artifact}`);
    return parts.join(' ');
}

// Collapse newlines/tabs and cap length so one event is always exactly one log line.
function oneLine(value: string): string {
    const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
    return flat.length <= MAX_DETAIL_LEN ? flat : flat.slice(0, MAX_DETAIL_LEN) + '…';
}

function rotateLogFile(logPath: string, prevPath: string): void {
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
