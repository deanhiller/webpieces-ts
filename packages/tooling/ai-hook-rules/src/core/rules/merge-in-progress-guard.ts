import * as fs from 'fs';
import * as path from 'path';

import { WEBPIECES_TMP_DIR, MERGE_DIR_PREFIX, MERGE_IN_PROGRESS_FILE, MergeInProgressGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';

const FIX_HINT: readonly string[] = [
    'A 3-point merge is in progress and not yet validated.',
    'Resolve the remaining conflicts in the working tree, then run:',
    '  pnpm wp-finish-upsert-pr',
    'That scans for leftover conflict markers and runs the build; only when green does it commit,',
    'unblock commit/push/PR, render the dashboard, and create/update the PR.',
];

// Returns the path of the first UNVALIDATED merge marker found, or null. We detect validation
// by a raw substring (no JSON.parse) so a malformed marker can never crash the guard.
function findUnvalidatedMerge(workspaceRoot: string): string | null {
    const tmpDir = path.join(workspaceRoot, WEBPIECES_TMP_DIR);
    if (!fs.existsSync(tmpDir)) return null;
    for (const entry of fs.readdirSync(tmpDir)) {
        if (!entry.startsWith(MERGE_DIR_PREFIX)) continue;
        const marker = path.join(tmpDir, entry, MERGE_IN_PROGRESS_FILE);
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
    constructor(config: MergeInProgressGuardConfig) { super(config, 'merge-in-progress-guard'); }

    readonly description = 'Block commit/push/merge/PR while a 3-point merge marker is unvalidated, forcing pnpm wp-finish-upsert-pr.';
    readonly fixHint = FIX_HINT;

    check(ctx: BashContext): readonly Violation[] {
        if (!isBlockedDuringMerge(ctx.command)) return [];
        const marker = findUnvalidatedMerge(ctx.workspaceRoot);
        if (!marker) return [];
        return [new V(
            1,
            truncate(ctx.command),
            [
                'A merge is in progress and not yet validated — this command is blocked.',
                `Marker: ${marker}`,
                'Finish resolving conflicts, then run:  pnpm wp-finish-upsert-pr',
            ].join('\n'),
        )];
    }
}
