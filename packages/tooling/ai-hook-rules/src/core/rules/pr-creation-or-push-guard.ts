import { PrCreationOrPushGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';

const DEFAULT_UPSERT_PR_COMMAND = 'pnpm wp-start-upsert-pr';

function fixHintFor(upsertPrCommand: string): FixHint {
    return new FixHint(
        'Direct PR creation/update AND manual `git push` are blocked.',
        'Never push or open/update a PR by hand — everything goes through the gated flow:\n'
        + `  ${upsertPrCommand}\n`
        + 'It updates the branch from main (3-point merge) and runs the real build (nx affected), then\n'
        + 'instructs you to write review.json and run `pnpm wp-finish-upsert-pr`, which assembles the\n'
        + 'dashboard and creates/updates the PR — and pushes for you (its internal `git push` is a child\n'
        + 'process this hook never sees, so the gated commands are unaffected by this guard). A failing\n'
        + 'build = no push and no PR.\n'
        + 'There is nothing to paste or attest to; the commands do the work.\n'
        + 'If a HUMAN genuinely needs an out-of-band push (no PR), do NOT do it yourself — ask them to run\n'
        + 'the push, since a manual push bypasses the build gate, review.json, and dashboard.\n'
        + 'Add this to your memory so you don\'t forget next time and waste tokens.',
    );
}

// Detect every way an agent could push or open/update a PR directly, so the ONLY path left is the
// gated flow (wp-start-upsert-pr → wp-finish-upsert-pr, whose internal `git push` / `gh pr create`
// run as child processes the hook never sees). Read-only `gh pr list` / `gh api .../pulls` GET are
// intentionally allowed.
function isBlockedPrOrPush(cmd: string): boolean {
    // A manual push is always blocked — the gated flow pushes for you behind the build gate.
    if (/\bgit\s+push\b/.test(cmd)) return true;

    if (/\bgh\s+pr\s+(create|edit)\b/.test(cmd)) return true;

    const ghApiPulls = /\bgh\s+api\b[^\n]*\/pulls\b/.test(cmd);
    if (ghApiPulls && (/--method\s+POST/i.test(cmd) || /-X\s+POST/i.test(cmd) || /\s-f\b/.test(cmd) || /\s-F\b/.test(cmd) || /--field\b/.test(cmd))) {
        return true;
    }

    const curlPulls = /\bcurl\b[^\n]*api\.github\.com[^\n]*\/pulls\b/.test(cmd);
    if (curlPulls && (/-X\s*POST/i.test(cmd) || /--request\s+POST/i.test(cmd) || /(\s-d\b|--data\b)/.test(cmd))) {
        return true;
    }
    return false;
}

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class PrCreationOrPushGuardRule extends BashRuleBase<PrCreationOrPushGuardConfig> {
    private readonly upsertPrCommand: string;

    constructor(config: PrCreationOrPushGuardConfig) {
        super(config, 'pr-creation-or-push-guard');
        this.upsertPrCommand = config.upsertPrCommand ?? DEFAULT_UPSERT_PR_COMMAND;
    }

    readonly description = 'Block manual `git push` and direct PR creation/edit (gh pr / gh api / curl) so pushes and PRs go only through the gated upsert-pr command.';
    get fixHint(): FixHint { return fixHintFor(this.upsertPrCommand); }

    check(ctx: BashContext): readonly Violation[] {
        if (!isBlockedPrOrPush(ctx.command)) return [];
        return [new V(1, truncate(ctx.command))];
    }
}
