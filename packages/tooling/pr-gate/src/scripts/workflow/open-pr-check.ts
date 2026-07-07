import { spawnSync } from 'child_process';
import { CliExitError } from '@webpieces/rules-config';
import { baseBranchName } from './branch-naming';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// The open PR (if any) tracking a feature branch, looked up by its STABLE base name (the PR always
// lives on `base`, never on the numbered generation basewp2/basewp3/…). Returns '' ONLY when GitHub
// answered and there is genuinely no open PR.
//
// This is a HARD GATE, not an advisory hint: it FAILS FAST if `gh` cannot answer (not installed, not
// authenticated, offline). We must NOT degrade "couldn't ask GitHub" into "no PR" — a 3-point update
// makes a new branch generation and the existing PR would be left pointing at the OLD branch (stale),
// so running wp-update-start blind when a PR might exist is exactly the disaster we are guarding
// against. Refuse rather than guess.
export function openPrForBranch(repoRoot: string, currentBranch: string): string {
    const base = baseBranchName(currentBranch);
    const result = spawnSync(
        'gh', ['pr', 'list', '--head', base, '--state', 'open', '--json', 'number', '--jq', '.[0].number'],
        { cwd: repoRoot, encoding: 'utf8' },
    );
    if (result.status !== 0) {
        const detail = (result.stderr ?? '').trim() || (result.error ? result.error.message : 'gh exited non-zero');
        throw new CliExitError(2,
            '\n' + SEP + '❌ Could not ask GitHub whether an open PR exists for this branch\n' + SEP + '\n' +
            `gh failed for base branch "${base}": ${detail}\n\n` +
            'This check must NOT be skipped: a 3-point update creates a NEW branch generation, so if a\n' +
            'PR already exists, wp-update-start would leave it pointing at the OLD branch. Fix gh first\n' +
            '(install / `gh auth login` / restore network), then re-run — or, if a PR does exist, use\n' +
            'the PR flow: pnpm wp-start-upsert-pr → /wp-merge → pnpm wp-finish-upsert-pr\n',
        );
    }
    return (result.stdout ?? '').trim();
}
