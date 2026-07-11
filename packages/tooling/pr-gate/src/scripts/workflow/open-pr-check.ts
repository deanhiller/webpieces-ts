import { spawnSync } from 'child_process';
import { CliExitError } from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/rules-config';
import { injectable } from 'inversify';
import { BranchNaming } from './branch-naming';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** Hard gate: whether an OPEN PR already tracks a feature branch (by its stable base name). */
@provideSingleton()
@injectable()
export class OpenPrCheck {
    constructor(private readonly branchNaming: BranchNaming) {}

    // The open PR (if any) tracking a feature branch, looked up by its STABLE base name. Returns '' ONLY
    // when GitHub answered and there is genuinely no open PR. HARD GATE: FAILS FAST if `gh` cannot
    // answer — we must NOT degrade "couldn't ask GitHub" into "no PR" (a 3-point update makes a new
    // branch generation and the existing PR would be stranded on the OLD branch). Refuse rather than guess.
    openPrForBranch(repoRoot: string, currentBranch: string): string {
        const base = this.branchNaming.baseBranchName(currentBranch);
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
                'PR already exists, wp-start-update would leave it pointing at the OLD branch. Fix gh first\n' +
                '(install / `gh auth login` / restore network), then re-run — or, if a PR does exist, use\n' +
                'the PR flow: pnpm wp-start-upsert-pr → /wp-merge → pnpm wp-finish-upsert-pr\n',
            );
        }
        return (result.stdout ?? '').trim();
    }
}
