import { spawnSync } from 'child_process';
import { baseBranchName } from './branch-naming';

// The open PR (if any) tracking a feature branch, looked up by its STABLE base name (the PR always
// lives on `base`, never on the numbered generation basewp2/basewp3/…). Best-effort: a missing or
// unauthenticated `gh` (or any failure) degrades to '' = "no open PR" rather than crashing — mirrors
// detectMergedPr's contract so the guard never blocks on tooling absence.
export function openPrForBranch(repoRoot: string, currentBranch: string): string {
    const result = spawnSync(
        'gh', ['pr', 'list', '--head', baseBranchName(currentBranch), '--state', 'open', '--json', 'number', '--jq', '.[0].number'],
        { cwd: repoRoot, encoding: 'utf8' },
    );
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}
