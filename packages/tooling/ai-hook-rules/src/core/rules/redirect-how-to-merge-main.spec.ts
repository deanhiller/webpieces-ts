import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RedirectHowToMergeMainConfig } from '@webpieces/rules-config';
import type { BashContext } from '../types';
import { RedirectHowToMergeMainRule } from './redirect-how-to-merge-main';

const rule = new RedirectHowToMergeMainRule(new RedirectHowToMergeMainConfig());

function ctx(command: string, workspaceRoot: string): BashContext {
    return { command, workspaceRoot, options: {} } as BashContext;
}

// The merge/rebase path never shells out to git — that is the design win of the blanket ban, and it
// is what makes these cases testable at all. Any root will do.
const NO_GIT_NEEDED = '/tmp/does-not-matter';

describe('redirect-how-to-merge-main — merge/rebase are banned outright', () => {
    it('blocks the regression: a compound command that lands on a feature branch first', () => {
        // The incident. HEAD is irrelevant now — the rule never reads it — but the whole point is
        // that this used to be ALLOWED because hook-time HEAD was still `main`.
        expect(rule.check(ctx('git checkout feat && git rebase main', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git branch -D old && git checkout feat && git rebase main', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git switch feat; git merge main', NO_GIT_NEEDED)).length).toBe(1);
    });

    it('blocks merge/rebase in every form, regardless of target', () => {
        expect(rule.check(ctx('git merge main', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git merge origin/main', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git rebase origin/main', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git rebase -i HEAD~3', NO_GIT_NEEDED)).length).toBe(1);
        // No --squash carve-out: the recovery docs that used to prescribe this were rewritten.
        expect(rule.check(ctx('git merge --squash feat', NO_GIT_NEEDED)).length).toBe(1);
        // A non-main target is still a merge — it still breaks the fork-point system.
        expect(rule.check(ctx('git merge feature-x', NO_GIT_NEEDED)).length).toBe(1);
        expect(rule.check(ctx('git merge --ff-only origin/main', NO_GIT_NEEDED)).length).toBe(1);
    });

    it('names BOTH paired flows — never a start from one pair with the other pair\'s finish', () => {
        const hint = rule.fixHint.mainMessage;
        expect(hint).toContain('pnpm wp-start-update');
        expect(hint).toContain('pnpm wp-finish-update');
        expect(hint).toContain('pnpm wp-start-upsert-pr');
        expect(hint).toContain('pnpm wp-finish-upsert-pr');
        expect(hint).toContain('wp-start-update    → wp-finish-update');
        expect(hint).toContain('wp-start-upsert-pr → wp-finish-upsert-pr');
        // The bug this fixes: the hint used to say "wp-start-update (then: wp-finish-upsert-pr)".
        expect(hint).not.toContain('wp-start-update        (then: pnpm wp-finish-upsert-pr)');
        // An open PR removes the choice.
        expect(hint).toContain('MUST use the upsert-pr pair');
    });

    it('offers read-only ways to LOOK, and says --ff-only is not one', () => {
        const hint = rule.fixHint.mainMessage;
        expect(hint).toContain('git merge-base --is-ancestor origin/main HEAD');
        expect(hint).toContain('`git merge --ff-only` is NOT a look');
        // The violation line itself calls it out, since that is what the AI reads first.
        const violation = rule.check(ctx('git merge --ff-only origin/main 2>/dev/null', NO_GIT_NEEDED))[0];
        expect(violation.message).toContain('NOT a read-only check');
    });

    it('allows the undo forms — they cannot create a merge commit', () => {
        expect(rule.check(ctx('git merge --abort', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('git rebase --abort', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('git rebase --quit', NO_GIT_NEEDED)).length).toBe(0);
    });

    it('blocks --continue — that COMPLETES the operation', () => {
        expect(rule.check(ctx('git rebase --continue', NO_GIT_NEEDED)).length).toBe(1);
    });

    it('allows read-only git and the gated commands', () => {
        expect(rule.check(ctx('git merge-base origin/main HEAD', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('pnpm wp-start-update', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('pnpm wp-finish-upsert-pr', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('git status', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('git branch -D feat && git checkout main', NO_GIT_NEEDED)).length).toBe(0);
    });

    it('allows commands that merely MENTION merge/rebase', () => {
        expect(rule.check(ctx("grep 'git rebase main' notes.md", NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('echo "git merge main"', NO_GIT_NEEDED)).length).toBe(0);
        expect(rule.check(ctx('git commit -m "merge main into feat"', NO_GIT_NEEDED)).length).toBe(0);
    });
});

// The pull path is the one place that still consults the branch, so it needs a real repo.
describe('redirect-how-to-merge-main — the pull path', () => {
    let repo: string;

    function git(...args: string[]): void {
        execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    }

    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-rule-'));
        git('init', '-b', 'main');
        // Temp repos must not run this repo's hooks, or the commit to main is blocked.
        git('config', 'core.hooksPath', '/dev/null');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'test');
        fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
        git('add', '-A');
        git('commit', '-m', 'init');
    });

    afterAll(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('allows pulling main while ON main', () => {
        git('checkout', 'main');
        expect(rule.check(ctx('git pull origin main', repo)).length).toBe(0);
        expect(rule.check(ctx('git checkout main && git pull origin main', repo)).length).toBe(0);
    });

    it('blocks pulling main while on a feature branch', () => {
        git('checkout', '-b', 'feat');
        expect(rule.check(ctx('git pull origin main', repo)).length).toBe(1);
    });

    it('blocks a compound that switches to a feature branch then pulls main, even from main', () => {
        // The same hook-time-HEAD hole as the rebase regression — still live on the pull path,
        // since pull retains a legitimate on-main form.
        git('checkout', 'main');
        expect(rule.check(ctx('git checkout feat && git pull origin main', repo)).length).toBe(1);
    });
});

// `git checkout main && git pull origin main` is the ALLOWED form in the primary clone — and an
// impossible one inside a linked worktree, where git refuses ("'main' is already checked out at
// <primary>"). Waving it through there hands the AI a command that cannot work. Real worktree here,
// not a mock: the whole signal is git's own on-disk layout (.git is a FILE in a linked worktree).
describe('redirect-how-to-merge-main — inside a linked worktree', () => {
    let repo: string;
    let worktree: string;

    function git(...args: string[]): void {
        execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    }

    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-wt-'));
        git('init', '-b', 'main');
        git('config', 'core.hooksPath', '/dev/null');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'test');
        fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
        git('add', '-A');
        git('commit', '-m', 'init');
        worktree = path.join(repo, '..', path.basename(repo) + '-wt');
        git('worktree', 'add', worktree, '-b', 'dean/feat');
    });

    afterAll(() => {
        fs.rmSync(worktree, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('blocks `git checkout main && git pull origin main` and steers to the fetch', () => {
        const violations = rule.check(ctx('git checkout main && git pull origin main', worktree));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('linked worktree');
        expect(violations[0].message).toContain('git fetch origin main');
    });

    it('still allows that exact command in the primary clone', () => {
        git('checkout', 'main');
        expect(rule.check(ctx('git checkout main && git pull origin main', repo)).length).toBe(0);
    });
});
