import { PrCreationGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';

const DEFAULT_UPSERT_PR_COMMAND = 'pnpm wp-start-upsert-pr';

function fixHintFor(upsertPrCommand: string): readonly string[] {
    return [
        'Direct PR creation is blocked. Create or update a PR ONLY via the gated flow:',
        `  ${upsertPrCommand}`,
        'It updates the branch from main (3-point merge) and runs the real build (nx affected), then',
        'instructs you to write review.json and run `pnpm wp-finish-upsert-pr`, which assembles the',
        'dashboard and creates/updates the PR itself. A failing build = no PR.',
        'There is nothing to paste or attest to; the commands do the work.',
    ];
}

// Detect every way an agent could open/update a PR directly, so the ONLY path left is the gated
// flow (wp-start-upsert-pr → wp-finish-upsert-pr, whose internal `gh pr create` runs as a child
// process the hook never sees). Read-only `gh pr list` / `gh api .../pulls` GET are intentionally allowed.
function isDirectPrCreation(cmd: string): boolean {
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

export class PrCreationGuardRule extends BashRuleBase<PrCreationGuardConfig> {
    private readonly upsertPrCommand: string;

    constructor(config: PrCreationGuardConfig) {
        super(config, 'pr-creation-guard');
        this.upsertPrCommand = config.upsertPrCommand ?? DEFAULT_UPSERT_PR_COMMAND;
    }

    readonly description = 'Block direct PR creation/edit (gh pr / gh api / curl) so PRs go only through the gated upsert-pr command.';
    get fixHint(): readonly string[] { return fixHintFor(this.upsertPrCommand); }

    check(ctx: BashContext): readonly Violation[] {
        if (!isDirectPrCreation(ctx.command)) return [];
        return [new V(
            1,
            truncate(ctx.command),
            [
                'Direct PR creation/update is blocked.',
                'Use the gated command instead — it runs the build and builds the dashboard:',
                `  ${this.upsertPrCommand}`,
            ].join('\n'),
        )];
    }
}
