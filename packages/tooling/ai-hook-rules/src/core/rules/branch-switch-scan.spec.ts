import { describe, it, expect } from 'vitest';

import { BranchSwitchScan } from './branch-switch-scan';

const scan = new BranchSwitchScan();

/**
 * The whole matrix, in one table, because the measured bug was a SINGLE flag: `git checkout -q main`
 * parsed as "not main" by a regex that assumed the branch name follows the subcommand immediately.
 *
 * The over-match direction is pinned just as hard, and matters more: if `git checkout -b
 * feature/main-thing` or `git checkout -- main.ts` read as "switching to main", they would be
 * EXEMPTED from redirect-how-to-merge-main, i.e. a real feature-branch pull would sail through the
 * guard that exists to catch it. A too-loose parse here is worse than the bug it replaces.
 */
describe('BranchSwitchScan — which branch does this land on', () => {
    const RECOGNISED_AS_MAIN: readonly string[] = [
        'git checkout main',
        'git checkout -q main',
        'git checkout --quiet main',
        'git switch main',
        'git switch -q main',
        'git switch --quiet main',
        'git checkout --no-track main',
        'git -C /some/path checkout -q main',
        'sudo git checkout -q main',
    ];

    const NOT_MAIN: readonly string[] = [
        'git checkout -b x origin/main',        // creates — current by construction
        'git checkout -b feature/main-thing',   // the over-match trap
        'git checkout -B main origin/main',     // creates, even spelled `main`
        'git switch -c deanhiller/feat origin/main',
        'git checkout -- main.ts',              // `--` ends options: a FILE
        'git checkout -- main',                 // a file that happens to be named main
        'git checkout feature/main-thing',
        'git checkout -q feature',
        'git checkout main-ish',
        'git checkout origin/main',             // detaches onto a remote ref, not the local branch
        'git checkout 2b151db',
        'git checkout -',                       // previous branch — unknowable at hook time
        'git checkout',                         // no target at all
        'git status',                           // not a switch
        'echo "git checkout main"',             // a mention, not an invocation
    ];

    it.each(RECOGNISED_AS_MAIN)('recognises %s as landing on main', (command: string) => {
        expect(scan.landsOnExistingMain(command)).toBe(true);
    });

    it.each(NOT_MAIN)('does NOT read %s as landing on main', (command: string) => {
        expect(scan.landsOnExistingMain(command)).toBe(false);
    });

    it('reports the branch a creating form lands on, and that it created it', () => {
        expect(scan.targetOf('git checkout -b deanhiller/feat origin/main')).toEqual({ branch: 'deanhiller/feat', created: true });
        expect(scan.targetOf('git switch -c feat origin/main')).toEqual({ branch: 'feat', created: true });
        expect(scan.targetOf('git checkout -q feature')).toEqual({ branch: 'feature', created: false });
    });

    it('lands nowhere for pathspec / previous-branch / non-switch forms', () => {
        expect(scan.targetOf('git checkout -- main.ts')).toBeNull();
        expect(scan.targetOf('git checkout -')).toBeNull();
        expect(scan.targetOf('git branch -D main')).toBeNull();
    });

    it('walks a whole command, one entry per switching segment', () => {
        expect(scan.switchesIn('git checkout -q main && git pull -q origin main'))
            .toEqual([{ branch: 'main', created: false }]);
        expect(scan.switchesIn('git branch -D old && git checkout feat && git pull origin main'))
            .toEqual([{ branch: 'feat', created: false }]);
        expect(scan.switchesIn('pnpm install')).toEqual([]);
    });
});
