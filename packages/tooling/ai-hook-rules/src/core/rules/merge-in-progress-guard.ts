import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces, MERGE_INFO_DIR, MERGE_IN_PROGRESS_FILE, MergeInProgressGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { CommandScanner } from '../command-scan';

const DEFAULT_MERGE_COMPLETE_COMMAND = 'pnpm wp-finish-upsert-pr';

// The ENTIRE enforcement surface of this guard, declared up here because the fixHint RENDERS ITSELF
// from these two lists (see `blockedCommandList`). The hint used to hand-write "do not run other
// commands" — an unbounded claim that forbade the reads, the `git add`, the build and the tests that
// finishing a merge actually requires, and that survived every edit to these lists. It was also wrapped
// in an "Add to memory" directive, so it outlived the session that read it. Generating the sentence
// from the code is what stops the two drifting apart again.
const BLOCKED_GIT_SUBCOMMANDS: readonly string[] = ['commit', 'push', 'merge', 'rebase'];
const BLOCKED_GH_PR_SUBCOMMANDS: readonly string[] = ['create', 'edit', 'merge'];

// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function blockedCommandList(): string {
    return BLOCKED_GIT_SUBCOMMANDS.map((sub: string) => `\`git ${sub}\``).join(', ')
        + `, and \`gh pr ${BLOCKED_GH_PR_SUBCOMMANDS.join('|')}\``;
}

// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function fixHintFor(mergeCompleteCommand: string): FixHint {
    return new FixHint(
        'A merge is in progress and not yet validated — this command is blocked.',
        'You started a merge but never called the finish-merge command, so a 3-point merge is still in progress.\n'
        + `Blocked until the merge is validated: ${blockedCommandList()}. That is the whole list;\n`
        + 'the finish command below does the commit for you.\n'
        + 'EXPECTED of you right now, and NOT blocked: read the conflicted files, edit them until every\n'
        + 'conflict marker is gone, `git add` each file you resolve, write the merge explanation for each\n'
        + 'one, and run the build and the tests. Finishing a merge requires all of those.\n'
        + 'Then run:\n'
        + `  ${mergeCompleteCommand}\n`
        + 'That scans for leftover conflict markers and runs the build; only when green does it commit,\n'
        + 'unblock commit/push/PR, render the dashboard, and create/update the PR.\n'
        + 'Add to memory: finish a started merge before beginning other work.',
    );
}

// Returns the path of the first UNVALIDATED merge marker found, or null. We detect validation
// by a raw substring (no JSON.parse) so a malformed marker can never crash the guard.
/**
 * DEPTH-BOUNDED SCAN, not a fixed level. The marker's home has moved twice: it was
 * `merge-info/<feature>/`, then `merge-info/<feature>/merge-<n>/` once each sync got its own run dir,
 * and is now `merge-info/staged/<feature>/merge-<n>/` since merge-info split into staged/merged. This
 * guard was still looking only at the FIRST layout's depth, so it silently found nothing and stopped
 * blocking — a guard failing open without saying so. A bounded walk covers every layout, legacy
 * included, and stops long before it could descend into anything large.
 */
const MARKER_SCAN_MAX_DEPTH = 3;

// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function findMarkerUnder(dir: string, depth: number): string | null {
    if (depth < 0 || !fs.existsSync(dir)) return null;
    const marker = path.join(dir, MERGE_IN_PROGRESS_FILE);
    if (fs.existsSync(marker)) {
        const raw = fs.readFileSync(marker, 'utf8');
        if (!/"validated"\s*:\s*true/.test(raw)) return marker;
    }
    if (depth === 0) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = findMarkerUnder(path.join(dir, entry.name), depth - 1);
        if (found !== null) return found;
    }
    return null;
}

// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function findUnvalidatedMerge(workspaceRoot: string): string | null {
    // LOCAL scope: the merge this guard blocks on is the one THIS worktree started. Another
    // worktree's in-flight merge must not block commits here — that was never the intent, and under a
    // shared merge-info dir it would be the behaviour.
    return findMarkerUnder(dotWebpieces.localFile(workspaceRoot, MERGE_INFO_DIR), MARKER_SCAN_MAX_DEPTH);
}

const SCANNER = new CommandScanner();
// Built from BLOCKED_GH_PR_SUBCOMMANDS so the enforcement and the sentence the fixHint prints can
// never name different commands.
const BLOCKED_GH_PR_PATTERN = new RegExp(`\\bgh\\s+pr\\s+(${BLOCKED_GH_PR_SUBCOMMANDS.join('|')})\\b`);

// Operations that would let an agent route around the merge gate.
//
// Routed through CommandScanner rather than `/\bgit\s+merge\b/`: that pattern matches the read-only
// `git merge-base origin/main HEAD` (`\b` sits between `e` and `-`), which appears in this repo's own
// documented build command — so an in-progress merge used to block a harmless diff-scope lookup.
// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function isBlockedDuringMerge(cmd: string): boolean {
    return SCANNER.commandInvokesAnyGit(cmd, BLOCKED_GIT_SUBCOMMANDS)
        || BLOCKED_GH_PR_PATTERN.test(cmd);
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
        if (!isBlockedDuringMerge(ctx.commandCode)) return [];
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
