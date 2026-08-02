import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, MergedBranchBashGuardConfig } from '@webpieces/rules-config';

import { BashContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
//   branch       — what `git rev-parse --abbrev-ref HEAD` reports
//   status       — the cached main-sync-status.json the guard reads
//   branchThrows — simulate git being unavailable entirely (fail-open)
const state = vi.hoisted(() => ({
    branch: 'feature-x',
    status: null as MainSyncStatus | null,
    branchThrows: false,
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('--abbrev-ref')) {
            if (state.branchThrows) throw new Error('not a git repository');
            return `${state.branch}\n`;
        }
        return '';
    },
}));

vi.mock('@webpieces/rules-config', async (importActual: () => Promise<RulesConfigModule>) => {
    const actual = await importActual();
    return {
        ...actual,
        readMainSyncStatus: (): MainSyncStatus | null => state.status,
    };
});

// Spawning the detached refresher must never run in tests.
vi.mock('../main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));
// The decision log writes to disk; silence it so tests never touch the fs.
vi.mock('../decision-log', () => ({
    logGuardDecision: (): void => undefined,
    GuardDecision: class { constructor(...args: unknown[]) { void args; } },
}));

import { MergedBranchBashGuardRule } from './merged-branch-bash-guard';

function ctx(command: string): BashContext {
    return new BashContext(command, '/tmp/x');
}

function rule(): MergedBranchBashGuardRule {
    const cfg = new MergedBranchBashGuardConfig();
    cfg.mode = 'ON';
    return new MergedBranchBashGuardRule(cfg);
}

// A cache for the checked-out branch. `merged` toggles branchAlreadyMerged (+ a PR number).
function status(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    const base = new MainSyncStatus('feature-x', true, '194', true, 'fork', 'origin-sha', 'head', false, [], 'ts');
    return Object.assign(base, over);
}

// Baseline: on a merged feature branch with a matching cache — the blocking case. Each test perturbs
// one axis.
function reset(): void {
    state.branch = 'feature-x';
    state.status = status();
    state.branchThrows = false;
}

function allowed(command: string): boolean {
    return rule().check(ctx(command)).length === 0;
}

// The same guard, but for a command that runs somewhere else entirely (a leading `cd`, which is how
// an agent reaches a linked worktree or a scratchpad — the harness resets a cwd that left the workspace).
function allowedFrom(command: string, effectiveCwd: string): boolean {
    return rule().check(new BashContext(command, '/tmp/x', effectiveCwd)).length === 0;
}

describe('merged-branch-bash-guard — blocks non-recovery bash on a merged branch', () => {
    beforeEach(reset);

    it('blocks booting servers, reading repo files, builds, and git writes', () => {
        expect(allowed('scripts/local.sh start lang')).toBe(false);
        expect(allowed('cat src/foo.ts')).toBe(false);
        expect(allowed('ls services/lang')).toBe(false);
        expect(allowed('pnpm build')).toBe(false);
        expect(allowed('pnpm nx run-many -t test')).toBe(false);
        expect(allowed('git commit -m "keep working"')).toBe(false);
        expect(allowed('git push')).toBe(false);
    });

    it('the block message names the already-merged state and the cure', () => {
        const violations = rule().check(ctx('scripts/local.sh start lang'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('already merged');
        expect(violations[0].message).toContain('origin/main');
    });

    it('denies a chain if ANY segment is non-recovery, even when the rest is allowlisted', () => {
        expect(allowed('git status && cat src/foo.ts')).toBe(false);
        expect(allowed('git fetch origin main && scripts/local.sh start')).toBe(false);
    });
});

describe('merged-branch-bash-guard — allows recovery / cleanup / inspection', () => {
    beforeEach(reset);

    it('allows the fresh-start cure and switching away', () => {
        expect(allowed('git fetch origin main && git checkout -b dean/new origin/main')).toBe(true);
        expect(allowed('git worktree add ../new -b dean/new origin/main')).toBe(true);
        expect(allowed('git checkout main && git pull origin main')).toBe(true);
        expect(allowed('git switch some-other-branch')).toBe(true);
        expect(allowed('git worktree prune && git worktree remove ../dead && git branch -D dead')).toBe(true);
    });

    it('allows read-only git/gh orientation', () => {
        expect(allowed('git status')).toBe(true);
        expect(allowed('git log --oneline -20')).toBe(true);
        expect(allowed('git diff HEAD~1')).toBe(true);
        expect(allowed('git branch -a')).toBe(true);
        expect(allowed('gh pr list --state merged')).toBe(true);
        expect(allowed('gh pr view 194')).toBe(true);
    });

    it('allows the wp-* cleanup bins and installs, but not other pnpm scripts', () => {
        expect(allowed('pnpm wp-cleanup')).toBe(true);
        expect(allowed('pnpm install')).toBe(true);
        expect(allowed('pnpm test')).toBe(false);
    });

    it('does NOT allowlist gh writes (governed by the PR guards)', () => {
        expect(allowed('gh pr create --title x')).toBe(false);
        expect(allowed('gh pr merge 194')).toBe(false);
    });
});

/**
 * The regression this suite exists for: the allowlist matched the RAW command string, so appending
 * the output shaping every agent appends by reflex turned an allowed command into a blocked one —
 * including `git fetch origin main`, printed verbatim in the guard's own remedy block. Verified pairs
 * from the field (only the shell decoration differs):
 *
 *     pnpm wp-cleanup                     allowed
 *     pnpm wp-cleanup 2>&1 | tail -40     BLOCKED
 *     git fetch origin main               allowed
 *     git fetch origin main 2>&1; echo …  BLOCKED
 */
describe('merged-branch-bash-guard — judges each SEGMENT, not the raw string', () => {
    beforeEach(reset);

    it('allows the remedy with the pipe/redirect an agent reflexively appends', () => {
        expect(allowed('git fetch origin main 2>&1 | tail -5')).toBe(true);
        expect(allowed('pnpm wp-cleanup 2>&1 | tail -40')).toBe(true);
        expect(allowed('git log --oneline --no-merges -20 | head -5')).toBe(true);
        expect(allowed('git branch -a | wc -l')).toBe(true);
    });

    it('allows a sequence whose other segment is inert', () => {
        expect(allowed('git fetch origin main 2>&1; echo "fetched"')).toBe(true);
        expect(allowed('cd ../other-tree && git status')).toBe(true);
    });

    it('allows a loop whose body is allowlisted (for/do/done are not commands)', () => {
        expect(allowed('for b in one two; do gh pr list --head $b; done')).toBe(true);
    });

    it('still BLOCKS when a segment of the pipeline is genuinely disallowed', () => {
        // The consumer is fine; the producer is not.
        expect(allowed('pnpm build 2>&1 | tail -20')).toBe(false);
        expect(allowed('scripts/local.sh start lang | head -5')).toBe(false);
        // A piped filter that names a WORKSPACE PATH reads pre-merge content — the thing being guarded.
        expect(allowed('git status | cat src/foo.ts')).toBe(false);
        // A loop body that is not allowlisted.
        expect(allowed('for b in one two; do scripts/local.sh start $b; done')).toBe(false);
    });

    // `echo x > src/y.ts` is a WRITE. A redirect to a file is never inert, so it must not ride in on
    // the "echo is harmless" allowance.
    it('does not let an output redirect ride in as inert', () => {
        expect(allowed('echo "broken" > src/foo.ts')).toBe(false);
        expect(allowed('git status')).toBe(true);
    });

    // Read-only, and watching CI is exactly what you do while parked on a just-merged branch. `gh run
    // view <id>` was blocked BARE in the field while `gh pr view` beside it succeeded.
    it('allows read-only gh run inspection, but not its write actions', () => {
        expect(allowed('gh run view 123456')).toBe(true);
        expect(allowed('gh run list --limit 5 | head -3')).toBe(true);
        expect(allowed('gh run watch 123456')).toBe(true);
        expect(allowed('gh run cancel 123456')).toBe(false);
    });
});

describe('merged-branch-bash-guard — fail-open', () => {
    beforeEach(reset);

    it('allows everything when the branch is NOT merged', () => {
        state.status = status({ branchAlreadyMerged: false, mergedPr: '' });
        expect(allowed('scripts/local.sh start lang')).toBe(true);
        expect(allowed('cat src/foo.ts')).toBe(true);
    });

    it('allows when the cache is for a DIFFERENT branch (never act on another branch snapshot)', () => {
        state.status = status({ branch: 'some-old-branch' });
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });

    it('allows when there is no cache yet', () => {
        state.status = null;
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });

    it('allows when the branch cannot be determined', () => {
        state.branchThrows = true;
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });
});

/**
 * The 2026-07-30 sighting: `ls -la /Users/x/.claude/projects/ | grep -i foo` was blocked with "this
 * branch is merged". The command touches nothing in any repo — which branch the tree is on cannot
 * possibly matter to it. What makes this safe rather than a hole is that ONLY content readers qualify:
 * a build, a server or a git write is never waved through on the strength of its paths.
 */
describe('merged-branch-bash-guard — a read that names nothing in this tree has no claim on it', () => {
    beforeEach(reset);

    it('allows a content read whose paths are all OUTSIDE the workspace', () => {
        expect(allowed('ls -la /Users/dean/.claude/projects/')).toBe(true);
        // The 2026-07-31 repro: a grep over two scratchpad files, NO `cd`, blocked and attributed to
        // an UNRELATED agent's merged branch (the shell cwd was the primary clone). With several
        // agents running, judging the shell cwd does not just misfire — it names someone else's tree.
        expect(allowed('grep -n needle /private/tmp/claude-501/scratchpad/a.md /private/tmp/claude-501/scratchpad/b.md')).toBe(true);
        expect(allowed('ls -la /Users/dean/.claude/projects/ | grep -i monorepo')).toBe(true);
        expect(allowed('cat /etc/hosts')).toBe(true);
        expect(allowed('grep -r needle /some/other/repo')).toBe(true);
    });

    it('still BLOCKS the same readers when they name workspace content (no bypass)', () => {
        expect(allowed('cat src/foo.ts')).toBe(false);
        expect(allowed('ls -la src/')).toBe(false);
        expect(allowed('ls')).toBe(false);                      // a bare cwd walk IS a tree read
        expect(allowed('grep -r needle src/')).toBe(false);
    });

    it('does NOT wave through non-readers just because their arguments point outside', () => {
        expect(allowed('scripts/local.sh start /tmp/whatever')).toBe(false);
        expect(allowed('node /tmp/server.js')).toBe(false);
        expect(allowed('git commit -m x')).toBe(false);
    });

    it('judges a relative path against the directory the command RUNS in, not the shell cwd', () => {
        // `cd /tmp/scratch && cat notes.md` reads /tmp/scratch/notes.md — nothing to do with this repo.
        expect(allowedFrom('cd /tmp/scratch && cat notes.md', '/tmp/scratch')).toBe(true);
        // …but an absolute path back into the tree is still caught from anywhere.
        expect(allowedFrom('cd /tmp/scratch && cat /tmp/x/src/foo.ts', '/tmp/scratch')).toBe(false);
    });
});
