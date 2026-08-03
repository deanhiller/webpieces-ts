import * as fs from 'fs';

import {
    CliExitError,
    DotWebpieces,
    PUSH_DEV_STATE_FILE,
    WP_FINISH_PUSH_DEV,
    WP_PUSH_DEV,
    toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The persisted half of the `wp-push-dev --resolve` state machine.
 *
 * A single-shot wrapper is IMPOSSIBLE here and that is why this file exists: `git merge` halts on
 * conflict with markers in the working tree and a non-zero exit, and a human or an AI has to edit files
 * before anything can be committed. So the command must be able to stop, hand the tree over, and be
 * resumed by a second command that knows exactly where it left off.
 *
 * Data-only (per CLAUDE.md) — the behaviour lives in {@link PushDevStateStore}.
 */
export class PushDevState {
    /** The branch to return to when the resolve finishes or aborts. NEVER written to by this flow. */
    originalBranch: string;
    /** The local throwaway branch the merges happen on. Deleted on finish and on abort. */
    tmpBranch: string;
    /** `<namespace>/<originalBranch>` — the remote copy this resolve republishes. */
    targetRef: string;
    /** The copy refs still to merge, in the order CI composes them. */
    queue: string[];
    /** The ref currently mid-merge (conflicted), or '' when nothing is halted. */
    current: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(originalBranch: string, tmpBranch: string, targetRef: string, queue: string[], current = '') {
        this.originalBranch = originalBranch;
        this.tmpBranch = tmpBranch;
        this.targetRef = targetRef;
        this.queue = queue;
        this.current = current;
    }
}

// The wp-* commands that must REFUSE while a resolve is half-finished, and the ONE place that list is
// written. The blocked-list sentence below RENDERS ITSELF from this array — the same lesson
// merge-in-progress-guard already learned the hard way: a hand-written "don't run other commands"
// survives every edit to the actual enforcement and ends up forbidding things the flow requires.
//
// Why these and not everything: each one either rewrites the current branch (the two starts), pushes it
// (the finishes), or deletes branches (cleanup) — and during a resolve the checkout is a throwaway
// branch, not the feature branch any of them think they are acting on.
const BLOCKED_DURING_RESOLVE: readonly string[] = [
    'wp-start-update', 'wp-finish-update',
    'wp-start-upsert-pr', 'wp-review-upsert-pr', 'wp-finish-upsert-pr',
    'wp-land-pr', 'wp-cleanup',
];

/**
 * Reads, writes and clears the resolve state file, and refuses the other `wp-*` commands while it
 * exists.
 *
 * LOCAL scope, deliberately: a resolve halts one worktree's checkout on a throwaway branch, and another
 * worktree has no reason to care. Sharing it would block a colleague's PR flow on state that says
 * nothing about their tree.
 */
@injectable(bindingScopeValues.Singleton)
export class PushDevStateStore {
    constructor(private readonly dotWebpieces: DotWebpieces) {}

    path(repoRoot: string): string {
        return this.dotWebpieces.localFile(repoRoot, PUSH_DEV_STATE_FILE);
    }

    exists(repoRoot: string): boolean {
        return fs.existsSync(this.path(repoRoot));
    }

    /** The in-flight resolve, or null when none is. A corrupt file reads as null rather than crashing. */
    read(repoRoot: string): PushDevState | null {
        const file = this.path(repoRoot);
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-unmanaged-exceptions -- a truncated/hand-edited state file must degrade to "no resolve in progress" (recoverable via --abort or a fresh --resolve), never crash every wp-* command in the tree
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- JSON.parse is untyped until narrowed on the next line
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PushDevState>;
            if (typeof raw.originalBranch !== 'string' || typeof raw.tmpBranch !== 'string') return null;
            return new PushDevState(
                raw.originalBranch, raw.tmpBranch, raw.targetRef ?? '',
                Array.isArray(raw.queue) ? raw.queue : [], raw.current ?? '');
        // The parse error carries nothing a caller could act on: the ONLY meaningful reading of an
        // unparseable state file is "no resolve in progress", which --abort and a fresh --resolve both
        // recover from.
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    write(repoRoot: string, state: PushDevState): void {
        fs.mkdirSync(this.dotWebpieces.local(repoRoot), { recursive: true });
        fs.writeFileSync(this.path(repoRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
    }

    clear(repoRoot: string): void {
        const file = this.path(repoRoot);
        if (fs.existsSync(file)) fs.rmSync(file);
    }

    /** The read that MUST find a resolve — used by `wp-finish-push-dev`, whose whole job is resuming one. */
    require(repoRoot: string): PushDevState {
        const state = this.read(repoRoot);
        if (state !== null) return state;
        throw new CliExitError(2,
            '\n' + SEP + '⛔ No dev-deploy resolve is in progress\n' + SEP + '\n'
            + `${WP_FINISH_PUSH_DEV} resumes a resolve that \`${WP_PUSH_DEV} --resolve\` started, and there is no\n`
            + `state file at:\n  ${this.path(repoRoot)}\n\n`
            + 'If you meant to publish your branch to the shared dev server, that is the one-command form:\n'
            + `  ${WP_PUSH_DEV}\n`);
    }

    /**
     * Refuse `attempted` while a resolve is half-finished. Called from the app root for every command in
     * {@link BLOCKED_DURING_RESOLVE}, so no individual command has to remember to ask.
     */
    assertIdle(repoRoot: string, attempted: string): void {
        const state = this.read(repoRoot);
        if (state === null) return;
        throw new CliExitError(2,
            '\n' + SEP + `⛔ A dev-deploy resolve is in progress — \`pnpm ${attempted}\` is blocked\n` + SEP + '\n'
            + `You are standing on the throwaway branch \`${state.tmpBranch}\`, not on \`${state.originalBranch}\`,\n`
            + `so ${this.blockedCommandList()} would all act on the wrong branch.\n`
            + 'That is the whole list; nothing else is blocked.\n\n'
            + 'EXPECTED of you right now, and NOT blocked: read the conflicted files and edit them until every\n'
            + 'conflict marker is gone. Then finish or bail out:\n'
            + `  ${WP_FINISH_PUSH_DEV}            ← commit the resolution, resume the queue, publish the copy\n`
            + `  ${WP_FINISH_PUSH_DEV} --abort    ← throw the resolution away and go back to \`${state.originalBranch}\`\n\n`
            + `State file: ${this.path(repoRoot)}\n`);
    }

    // Rendered from BLOCKED_DURING_RESOLVE, never hand-written — see that constant.
    private blockedCommandList(): string {
        return BLOCKED_DURING_RESOLVE.map((c: string): string => `\`pnpm ${c}\``).join(', ');
    }

    /** Is `command` one of the ones that must refuse mid-resolve? Used by the app root. */
    isBlockedDuringResolve(command: string): boolean {
        return BLOCKED_DURING_RESOLVE.includes(command);
    }
}
