import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrLifecycleGuardConfig, BranchStateGuardConfig, Option } from '@webpieces/rules-config';
import { BashContext } from '../types';
import { RedirectHowToMergeMainRule } from './redirect-how-to-merge-main';
import { StaleMainBashGuardRule } from './stale-main-bash-guard';

const rule = new RedirectHowToMergeMainRule(new PrLifecycleGuardConfig());

function ctx(command: string, workspaceRoot: string): BashContext {
    return new BashContext(command, workspaceRoot);
}

// The merge/rebase path never shells out to git — that is the design win of the blanket ban, and it
// is what makes these cases testable at all. It DOES write the git-workflow doc it links to, so the
// root must be a real directory we own.
const NO_GIT_NEEDED = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-redirect-'));

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

// An AI that only learns WHAT to type instead keeps looking for a way around the guard; one that
// understands WHY the fork point matters stops trying. The DERIVATION of that WHY lives in ONE place —
// the git-workflow template — and the hint's job is to name the invariant, say what breaks it, and
// send the reader there. It used to re-derive the whole thing inline, which is a second copy of a
// doc that is regenerated per version; these tests now pin each half where it actually belongs.
describe('redirect-how-to-merge-main — why the fork point matters', () => {
    it('names the invariant and what breaks it, and points at the derivation', () => {
        const hint = rule.fixHint.mainMessage;
        expect(hint).toContain('pure main commit');
        // The consumers a polluted fork point corrupts.
        expect(hint).toContain('--base');
        expect(hint).toContain('review diff');
        // The doc pointer must advertise what the hint no longer spells out, or the reader has no
        // reason to open it.
        expect(hint).toContain('the fork-point invariant');
        // The FULL phrase, not the `never sync a branch` prefix it used to assert. That prefix passed
        // under both the retired authorship framing ("...you do not own") and the liveness one, so the
        // hint could keep teaching the removed rule while the doc taught its replacement — and the hint
        // is what an agent reads FIRST, the doc only what it is sent to open.
        expect(hint).toContain('never sync a branch something is ACTIVELY holding');
        expect(hint).not.toContain('you do not own');
        expect(hint).not.toContain('another\nsession owns');
    });

    it('sends the AI to a doc that states the invariant, its consumers and the rewrite in full', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-redirect-invariant-'));
        rule.check(ctx('git merge origin/main', root));
        const written = fs.readFileSync(path.join(root, '.webpieces', 'instruct-ai', 'webpieces.git-workflow.md'), 'utf8');
        expect(written).toContain('THE FORK POINT INVARIANT');
        // Both halves of the symmetric invariant.
        expect(written).toContain('pure `main` commit containing none of your work');
        expect(written).toContain('none of main\'s commits after it');
        // The consumers a polluted fork point corrupts — the merge is only one of three.
        expect(written).toContain('`nx affected` — the build gate\'s scope');
        expect(written).toContain('The review diff.');
        // The rewrite is the mechanism, and the ownership consequence that follows from it.
        expect(written).toContain('The rewrite **is** the mechanism');
        // The consequence is about LIVENESS, not authorship. It used to read "never sync a branch you do
        // not own", which was the wrong test: a branch whose owner has finished is held by nobody, and
        // taking it over is often exactly what has to happen (a stalled agent still leaves a real PR to
        // land). What the force-push actually destroys is a fork point something is holding RIGHT NOW.
        expect(written).toContain('never sync a branch something is ACTIVELY holding');
        expect(written).toContain('The test is LIVENESS, not authorship');
        // The observable signal that answers it, so the rule is checkable rather than a judgement call.
        expect(written).toContain('`locked`');
        // And conflicts alone are not an escalation: the 3-point merge shows both intents.
        expect(written).toContain('/wp-merge');
        // The superseded wording must not come back alongside the new one.
        expect(written).not.toContain('never sync a branch you do not own');
        fs.rmSync(root, { recursive: true, force: true });
    });

    // The scripted warning to hand the human was lifted out of the hint for the same reason. It is
    // only safe to drop from the message because the doc the message links carries it.
    it('leaves the words to warn the human with in the doc it links', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-redirect-warn-'));
        rule.check(ctx('git merge origin/main', root));
        const written = fs.readFileSync(path.join(root, '.webpieces', 'instruct-ai', 'webpieces.git-workflow.md'), 'utf8');
        expect(written).toContain('push back and make you use the 3-point merge instead');
        expect(rule.fixHint.mainMessage).toContain('the exact words to warn a human with');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// What the AI actually READS when blocked: the fix hint's text and the doc it is sent to. These are
// the surface that drifted before (a start from one pair + the other pair's finish).
describe('redirect-how-to-merge-main — what the block tells the AI', () => {
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

    // A hint may ask the AI to persist a sentence, and that sentence outlives the code that printed it.
    // "Add that info to memory" pointed at the git-workflow doc, which is REGENERATED per repo and per
    // version — so the remembered copy is stale by construction. Only version-stable invariants qualify.
    it('asks the AI to memorize only the invariant, never the regenerated doc it links', () => {
        const hint = rule.fixHint.mainMessage;
        const memoryLines = hint.split('\n').filter((line: string): boolean => line.includes('to memory'));
        expect(memoryLines.length).toBe(1);
        expect(memoryLines[0]).not.toContain('Add that info to memory');
        expect(hint).toContain('re-read its git-workflow doc each time rather than recalling it');
    });

    it('writes the git-workflow doc it points the AI at, and links that exact path', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-redirect-doc-'));
        const doc = path.join(root, '.webpieces', 'instruct-ai', 'webpieces.git-workflow.md');
        expect(fs.existsSync(doc)).toBe(false);

        const violations = rule.check(ctx('git merge origin/main', root));
        expect(violations.length).toBe(1);
        expect(fs.existsSync(doc)).toBe(true);
        expect(violations[0].message).toContain(doc);
        // The doc it writes must itself describe both pairs — it is the thing the AI is sent to read.
        const written = fs.readFileSync(doc, 'utf8');
        expect(written).toContain('pnpm wp-finish-update');
        expect(written).toContain('pnpm wp-finish-upsert-pr');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('answers "how do I update MAIN itself" — the question that has no other answer here', () => {
        // The dead end that produces `git reset --hard origin/main`: an AI ON main is shown how to sync
        // a FEATURE branch and how to LOOK, but never how to fast-forward main. Now it is told.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-redirect-main-'));
        const message = rule.check(ctx('git merge --ff-only origin/main', root))[0].message;
        expect(message).toContain('bring MAIN itself up to date');
        // The one command that goes to main, pulls it, reaps dead branches/worktrees and sweeps the
        // orphan directories — not the hand-chained pair it used to print (see TreeRecovery).
        expect(message).toContain('pnpm wp-checkout-clean-main');
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('offers read-only ways to LOOK, and says --ff-only is not one', () => {
        const hint = rule.fixHint.mainMessage;
        expect(hint).toContain('git merge-base --is-ancestor origin/main HEAD');
        expect(hint).toContain('`git merge --ff-only` is NOT a look');
        // The violation line itself calls it out, since that is what the AI reads first.
        const violation = rule.check(ctx('git merge --ff-only origin/main 2>/dev/null', NO_GIT_NEEDED))[0];
        expect(violation.message).toContain('NOT a read-only check');
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

    /**
     * The measured 2026-08-11 bug. `git checkout main && git pull origin main` passed; adding `-q`
     * made `main` stop following `checkout`, so the main EXEMPTION missed, the negative-lookahead twin
     * concluded the target was a feature branch, and the command was blocked with a reason that was
     * the opposite of what it does. A human had to route around two guards to update main.
     */
    it('is flag-tolerant: -q/--quiet do not turn a checkout of MAIN into a feature switch', () => {
        git('checkout', 'main');
        expect(rule.check(ctx('git checkout -q main && git pull -q origin main', repo)).length).toBe(0);
        expect(rule.check(ctx('git checkout --quiet main && git pull origin main', repo)).length).toBe(0);
        expect(rule.check(ctx('git switch -q main && git pull --ff-only origin main', repo)).length).toBe(0);
    });

    // The other direction, which matters more: a flag must not smuggle a FEATURE switch past the
    // guard, and `main` appearing anywhere in the words is not the question being asked.
    it('still blocks a flagged switch to a branch that merely LOOKS like main', () => {
        git('checkout', 'main');
        expect(rule.check(ctx('git checkout -q feat && git pull origin main', repo)).length).toBe(1);
        expect(rule.check(ctx('git checkout feature/main-thing && git pull origin main', repo)).length).toBe(1);
        expect(rule.check(ctx('git checkout -b feature/main-thing && git pull origin main', repo)).length).toBe(1);
        expect(rule.check(ctx('git checkout -- main.ts && git pull origin main', repo)).length).toBe(0);  // a FILE; on main, so the pull is fine
    });

    /**
     * THE INVARIANT this fix restores: the cure one guard PRINTS must not be blocked by the other.
     * Asserted against stale-main-bash-guard's own fix-hint text rather than a copy of it, so a future
     * edit to that hint that drifts away from what this guard accepts turns this red.
     */
    it('does not block the cure stale-main-bash-guard prescribes', () => {
        git('checkout', 'main');
        const hint = new StaleMainBashGuardRule(new BranchStateGuardConfig()).fixHint;
        const preferred = hint.fixOptions.filter((o: Option): boolean => o.preferred);
        expect(preferred.length).toBe(1);
        // The prescribed cure is now the ONE command, extracted from that guard's own hint rather than
        // copied here, so a future edit that drifts away from what THIS guard accepts turns it red.
        const cure = /pnpm wp-checkout-clean-main/.exec(preferred[0].text);
        expect(cure).not.toBeNull();
        expect(rule.check(ctx(cure === null ? '' : cure[0], repo)).length).toBe(0);
        // THE HAND-ROLLED PAIR STAYS ALLOWED HERE, and that is deliberate rather than leftover. The
        // guards stopped TEACHING it, but it is plain git and it is the L0 version-drift cure — the one
        // state where node_modules is what is broken and no `pnpm` bin can be relied on to load. Turning
        // "no longer prescribed" into "now blocked" would delete the only escape from that deadlock.
        expect(rule.check(ctx('git checkout main && git pull origin main', repo)).length).toBe(0);
        // …and the same pair carrying the flags an agent habitually appends, which is the form that
        // was blocked in the field.
        expect(rule.check(ctx('git checkout -q main && git pull -q origin main', repo)).length).toBe(0);
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
