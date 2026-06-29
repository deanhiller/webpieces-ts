import type { BashRule, BashContext, Violation } from '../types';
import { Violation as V } from '../types';

const FIX_HINT: readonly string[] = [
    'Direct PR creation is blocked. Create or update a PR ONLY via the gated command:',
    '  pnpm wp-upsert-pr',
    'It updates the branch from main (3-point merge), runs the real build (nx affected), and',
    'assembles the PR dashboard — then creates/updates the PR itself. A failing build = no PR.',
    'There is nothing to paste or attest to; the command does the work.',
];

// Detect every way an agent could open/update a PR directly, so the ONLY path left is
// `pnpm wp-upsert-pr` (whose internal `gh pr create` runs as a child process the hook
// never sees). Read-only `gh pr list` / `gh api .../pulls` GET are intentionally allowed.
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

const prCreationGuard: BashRule = {
    name: 'pr-creation-guard',
    description: 'Block direct PR creation/edit (gh pr / gh api / curl) so PRs go only through pnpm wp-upsert-pr.',
    scope: 'bash',
    files: [],
    defaultOptions: {},
    fixHint: FIX_HINT,

    check(ctx: BashContext): readonly Violation[] {
        if (!isDirectPrCreation(ctx.command)) return [];
        return [new V(
            1,
            truncate(ctx.command),
            [
                'Direct PR creation/update is blocked.',
                'Use the gated command instead — it runs the build and builds the dashboard:',
                '  pnpm wp-upsert-pr',
            ].join('\n'),
        )];
    },
};

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export default prCreationGuard;
