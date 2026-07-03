import * as fs from 'fs';
import * as path from 'path';

import { WEBPIECES_TMP_DIR, MERGE_INFO_DIR, MERGE_IN_PROGRESS_FILE, MergeInProgressGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';

const DEFAULT_MERGE_COMPLETE_COMMAND = 'pnpm wp-finish-upsert-pr';

function fixHintFor(mergeCompleteCommand: string): FixHint {
    return new FixHint(
        'A merge is in progress and not yet validated — this command is blocked.',
        'A 3-point merge is in progress and not yet validated.\n'
        + 'Resolve the remaining conflicts in the working tree, then run:\n'
        + `  ${mergeCompleteCommand}\n`
        + 'That scans for leftover conflict markers and runs the build; only when green does it commit,\n'
        + 'unblock commit/push/PR, render the dashboard, and create/update the PR.',
    );
}

// Returns the path of the first UNVALIDATED merge marker found, or null. We detect validation
// by a raw substring (no JSON.parse) so a malformed marker can never crash the guard.
function findUnvalidatedMerge(workspaceRoot: string): string | null {
    // Per-feature merge dirs live under `.webpieces/merge-info/<feature>/`; scan that home's subdirs.
    const mergeInfoDir = path.join(workspaceRoot, WEBPIECES_TMP_DIR, MERGE_INFO_DIR);
    if (!fs.existsSync(mergeInfoDir)) return null;
    for (const entry of fs.readdirSync(mergeInfoDir)) {
        const marker = path.join(mergeInfoDir, entry, MERGE_IN_PROGRESS_FILE);
        if (!fs.existsSync(marker)) continue;
        const raw = fs.readFileSync(marker, 'utf8');
        if (!/"validated"\s*:\s*true/.test(raw)) return marker;
    }
    return null;
}

// Operations that would let an agent route around the merge gate.
function isBlockedDuringMerge(cmd: string): boolean {
    return /\bgit\s+commit\b/.test(cmd)
        || /\bgit\s+push\b/.test(cmd)
        || /\bgit\s+merge\b/.test(cmd)
        || /\bgit\s+rebase\b/.test(cmd)
        || /\bgh\s+pr\s+(create|edit|merge)\b/.test(cmd);
}

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class MergeInProgressGuardRule extends BashRuleBase<MergeInProgressGuardConfig> {
    private readonly mergeCompleteCommand: string;

    constructor(config: MergeInProgressGuardConfig) {
        super(config, 'merge-in-progress-guard');
        this.mergeCompleteCommand = config.mergeCompleteCommand ?? DEFAULT_MERGE_COMPLETE_COMMAND;
    }

    readonly description = 'Block commit/push/merge/PR while a 3-point merge marker is unvalidated, forcing the merge-complete command.';
    get fixHint(): FixHint { return fixHintFor(this.mergeCompleteCommand); }

    check(ctx: BashContext): readonly Violation[] {
        if (!isBlockedDuringMerge(ctx.command)) return [];
        const marker = findUnvalidatedMerge(ctx.workspaceRoot);
        if (!marker) return [];
        return [new V(
            1,
            truncate(ctx.command),
            'A merge is in progress and not yet validated — this command is blocked.\n'
            + `Marker: ${marker}`,
        )];
    }
}
