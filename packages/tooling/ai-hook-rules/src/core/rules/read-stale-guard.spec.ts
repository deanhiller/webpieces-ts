import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, BranchStateGuardConfig } from '@webpieces/rules-config';

import type { FileContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
//   branch      — what `git rev-parse --abbrev-ref HEAD` reports
//   status      — the cached main-sync-status.json the guard reads
//   porcelain   — `git status --porcelain` output ('' = clean tree)
//   ancestorRc  — exit code of `git merge-base --is-ancestor <originMain> HEAD`
//                 0 = local main already contains cached origin/main (up to date)
//                 1 = cleanly behind
//                 128 = git could not answer (bad object) → must fail OPEN
//   branchThrows — simulate git being unavailable entirely
//   gitHead     — contents of .git/HEAD, or null to make the fast path unavailable (fall back to git)
//   gitIsDir    — false simulates a worktree, where .git is a FILE and HEAD lives elsewhere
//   execBranchCalls — counts spawns of `git rev-parse --abbrev-ref`, to prove the fast path avoids them
const state = vi.hoisted(() => ({
    branch: 'main',
    status: null as MainSyncStatus | null,
    porcelain: '',
    ancestorRc: 1,
    branchThrows: false,
    gitHead: null as string | null,
    gitIsDir: true,
    execBranchCalls: 0,
}));

vi.mock('fs', () => ({
    statSync: (): { isDirectory: () => boolean } => {
        if (state.gitHead === null) throw new Error('ENOENT');
        return { isDirectory: (): boolean => state.gitIsDir };
    },
    readFileSync: (): string => {
        if (state.gitHead === null) throw new Error('ENOENT');
        return state.gitHead;
    },
    // TargetTreeResolver's two filesystem questions — "does this directory exist" and "what is it
    // really". `/tmp/x` is a fictional root here, so the honest answer is NO: the resolver walks up,
    // finds nothing, and falls back to the governed root, which is the tree every case below judges.
    // Answering them is not optional now that this guard resolves its tree from the target path
    // (issue #851) — a mock missing them fails at the first call, which is the mock telling the truth
    // about a real new dependency.
    existsSync: (): boolean => false,
    realpathSync: (p: string): string => p,
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('--abbrev-ref')) {
            state.execBranchCalls += 1;
            if (state.branchThrows) throw new Error('not a git repository');
            return `${state.branch}\n`;
        }
        if (cmd.includes('status --porcelain')) return state.porcelain;
        if (cmd.includes('rev-list')) return '3\n';
        return '';
    },
    spawnSync: (): { status: number } => ({ status: state.ancestorRc }),
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
    // The layer token the guards now stamp on every line. A mock that omits it fails at import,
    // which is the mock telling the truth: this module really does depend on it.
    matrixL2Row: (reason: string) => ({ layer: 'L2', row: reason }),
}));

import { ReadStaleGuardRule } from './read-stale-guard';

// `filePath` is REQUIRED here now: this guard resolves WHICH TREE it judges from the target path
// (issue #851), so a context without one cannot be classified. `/tmp/x` is neither a git repo nor an
// existing directory, so TargetTreeResolver falls back to the governed root — the tree these cases
// always judged, which is why every assertion below is unchanged. The worktree case, where the two
// roots genuinely differ, needs real git and lives in target-tree.spec.ts.
function ctx(relativePath: string = 'src/a.ts'): FileContext {
    return {
        relativePath,
        filePath: `/tmp/x/${relativePath}`,
        workspaceRoot: '/tmp/x',
        tool: 'Read',
        options: {},
    } as FileContext;
}

function rule(): ReadStaleGuardRule {
    const cfg = new BranchStateGuardConfig();
    cfg.mode = 'ON';
    return new ReadStaleGuardRule(cfg);
}

// A cache that says "on main, and origin/main is some commit". Behind-ness is decided by ancestorRc,
// never by comparing these strings — that is the whole point of escape valve 2.
function status(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    const base = new MainSyncStatus('main', false, '', true, 'fork', 'origin-sha', 'head', false, [], 'ts');
    base.localMain = 'local-sha';
    return Object.assign(base, over);
}

// Baseline: on main, clean tree, cache present, local main genuinely behind → the blocking case.
// Each describe below installs this and then perturbs exactly one axis.
function reset(): void {
    state.branch = 'main';
    state.status = status();
    state.porcelain = '';
    state.ancestorRc = 1;
    state.branchThrows = false;
    state.gitHead = null;
    state.gitIsDir = true;
    state.execBranchCalls = 0;
}

// ---- the per-read cost path ---------------------------------------------------------------------
// This runs on EVERY read, so it must not spawn a git process on the common (feature-branch) case.
describe('read-stale-guard — branch detection cost', () => {
    beforeEach(reset);

    describe('branch detection cost', () => {
        it('reads .git/HEAD instead of spawning git, on the common feature-branch path', () => {
            state.gitHead = 'ref: refs/heads/dean/x\n';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(0);
        });

        it('still blocks correctly when .git/HEAD says main', () => {
            state.gitHead = 'ref: refs/heads/main\n';
            expect(rule().check(ctx()).length).toBe(1);
            expect(state.execBranchCalls).toBe(0);
        });

        it('falls back to spawning git in a worktree (.git is a file, HEAD lives elsewhere)', () => {
            state.gitHead = 'gitdir: /elsewhere/.git/worktrees/wt\n';
            state.gitIsDir = false;
            state.branch = 'dean/x';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(1);
        });

        it('falls back to spawning git on a detached HEAD (raw sha, no ref: line)', () => {
            state.gitHead = 'a8b1b91ea4b117cc05e15364108c094b16e3a1c9\n';
            state.branch = 'dean/x';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(1);
        });
    });
});

// ---- the one case that blocks -------------------------------------------------------------------
describe('read-stale-guard — blocking', () => {
    beforeEach(reset);

    it('blocks a read on a clean main that is behind origin/main', () => {
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        // ONE spelling of "make local main current", and it is the one CLAUDE.md names —
        // `pnpm wp-sync-main`, which pulls `--ff-only` (so it can never start the MERGE
        // redirect-how-to-merge-main exists to keep an AI away from) and sweeps the corpses too.
        // Four spellings of this cure reached the fleet before it was unified; see
        // docs/audit/2026-08-24-mon-wed.md section 3.
        expect(violations[0].message).toContain('pnpm wp-sync-main');
        // The retired spellings, gone rather than softened.
        expect(violations[0].message).not.toContain('git pull --ff-only origin main');
        expect(violations[0].message).not.toContain('git pull origin main');
    });

    it('names what is still allowed in the block message, so the agent is never stuck', () => {
        const message = rule().check(ctx())[0].message ?? '';
        // NOT 'EVERY Bash command' any more: stale-main-bash-guard now blocks content-reading Bash
        // on this same state, so promising the whole shell would be a lie the agent acts on.
        expect(message).not.toContain('EVERY Bash command');
        expect(message).toContain('Bash that does not read repo files');
        expect(message).toContain('webpieces.config.json');
    });

    it('reports how far behind main is', () => {
        expect(rule().check(ctx())[0].message).toContain('3 commit(s) behind');
    });

});

// ---- the fail-open escape valves (D1-D12) -------------------------------------------------------
// Every row here is a deadlock this guard would otherwise create. They all resolve to ALLOW.
describe('read-stale-guard — fail-open escape valves', () => {
    beforeEach(reset);

    // ---- D1/D8: scope --------------------------------------------------------------------------
    it('allows on a feature branch whose cache is not (yet) for this branch', () => {
        state.branch = 'dean/x';
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('allows files outside the workspace', () => {
        expect(rule().check(ctx('../outside.ts')).length).toBe(0);
    });

    // ---- D2: dirty tree ------------------------------------------------------------------------
    /*
     * THE DIRTY VALVE IS CLOSED. It used to fail open here, reasoning that the prescribed
     * in-place pull is not a clean fast-forward on a dirty tree, so blocking would trap the
     * agent away from the files it needed. That was true of the MESSAGE, not of the row: row 6 has
     * always carried a second cure, `git checkout -b <new> origin/main`, which CARRIES uncommitted
     * changes onto the new branch and lands you on current code. The message now prints both, so the
     * block no longer has to be suppressed to keep the cure runnable.
     */
    it('BLOCKS when the tree is dirty — `git checkout -b` carries the work, so nothing is trapped', () => {
        // `porcelain` is set to name the SCENARIO, not to drive the assertion: the guard no longer
        // shells out for it at all. That is the strongest form of this test — the verdict is now
        // independent of tree state by construction, not merely equal for both values of it.
        state.porcelain = ' M src/a.ts\n';
        expect(rule().check(ctx()).length).toBe(1);
        state.porcelain = '';
        expect(rule().check(ctx()).length, 'clean and dirty must be judged alike').toBe(1);
    });

    it('prints BOTH cures, and says which one survives uncommitted changes', () => {
        state.porcelain = ' M src/a.ts\n';
        const message = rule().check(ctx())[0].message;
        expect(message).toContain('pnpm wp-sync-main');
        expect(message).toContain('git checkout -b <new-branch> origin/main');
        expect(message).toContain('CLEAN TREE ONLY');
        expect(message).toContain('UNCOMMITTED CHANGES');
        // The residual: origin/main touched the same files, so git refuses the switch. `git stash` is
        // on the skip list, so naming it here can never prescribe something a sibling guard denies.
        expect(message).toContain('git stash');
    });

    // ---- D3: cache lag, the anti-spin guarantee ------------------------------------------------
    it('allows the instant local main CONTAINS the cached origin/main, without waiting for a cache refresh', () => {
        // Hashes still differ (localMain 'local-sha' !== originMain 'origin-sha') — an equality check
        // would keep blocking here and spin the agent forever. Ancestry says we are current.
        state.ancestorRc = 0;
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when git cannot answer the ancestry question (pruned/bad object)', () => {
        state.ancestorRc = 128;
        expect(rule().check(ctx()).length).toBe(0);
    });

    // ---- D9: the escape hatch ------------------------------------------------------------------
    it('always allows reading webpieces.config.json so mode OFF stays reachable', () => {
        expect(rule().check(ctx('webpieces.config.json')).length).toBe(0);
    });

    // ---- D4/D5/D7/D12: no data -----------------------------------------------------------------
    it('fails open when there is no cache yet', () => {
        state.status = null;
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when the cache is for a different branch', () => {
        state.status = status({ branch: 'dean/x' });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when origin/main is unknown (offline)', () => {
        state.status = status({ originMain: '' });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when the branch cannot be determined (not a git repo)', () => {
        state.branchThrows = true;
        expect(rule().check(ctx()).length).toBe(0);
    });

});

// ---- state B: an already-merged feature branch ---------------------------------------------------
// Same damage as a stale main (the AI reads a PRE-MERGE snapshot), so the same tool gets blocked.
// State A and state B are now judged alike on a dirty tree — both block, because both cure with a
// fresh branch that carries uncommitted work along.
// On a feature branch, cache for THAT branch, PR merged. `main`-only axes (ancestorRc, localMain)
// are irrelevant on this path.
function mergedStatus(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    return status(Object.assign(
        { branch: 'dean/x', branchAlreadyMerged: true, mergedPr: '432' },
        over,
    ));
}

function onMergedBranch(over: Partial<MainSyncStatus> = {}): void {
    state.branch = 'dean/x';
    state.status = mergedStatus(over);
}

describe('read-stale-guard — merged feature branch', () => {
    beforeEach(reset);

    it('blocks a read on a branch whose PR is already merged', () => {
        onMergedBranch();
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('already merged into main');
        expect(violations[0].message).toContain('merged PR #432');
    });

    it('tells the agent to branch off origin/main (never `git checkout main`, which fatals in a worktree)', () => {
        onMergedBranch();
        const message = rule().check(ctx())[0].message ?? '';
        expect(message).toContain('git checkout -b <new-feature-branch> origin/main');
        expect(message).toContain('git fetch origin main');
    });

    /**
     * ONE merged allowance list, not this guard's private view of the world. It used to promise
     * "EVERY Bash command (the git commands above, installs, builds, all git/gh)" — true of THIS guard
     * and false of the session, because merged-branch-bash-guard fires on the very same state and
     * blocks most Bash. Both claims reached the agent in the same turn.
     */
    it('names what is still allowed with the ONE shared list, not a per-guard fiction', () => {
        onMergedBranch();
        const message = rule().check(ctx())[0].message ?? '';
        expect(message).not.toContain('EVERY Bash command');
        expect(message).toContain('Still allowed while this block is up');
        expect(message).toContain('pnpm wp-cleanup');
        expect(message).toContain('webpieces.config.json');
        // …and it is honest about what the SIBLING guards block on the same branch.
        expect(message).toContain('merged-branch-bash-guard');
    });

    /*
     * The merged-branch dirty valve is closed too, and this one never had an argument behind it: row
     * 8's cure is `git fetch origin main && git checkout -b <new> origin/main`, which carries
     * uncommitted work with you. The valve was drift from the documented design — this class's own
     * docblock described the strict behaviour the whole time the code did the opposite.
     */
    it('BLOCKS when the tree is dirty — the fresh-branch cure brings your edits along', () => {
        onMergedBranch();
        // As in state A: the fixture documents the scenario; the guard no longer reads porcelain.
        state.porcelain = ' M src/a.ts\n';
        expect(rule().check(ctx()).length).toBe(1);
        state.porcelain = '';
        expect(rule().check(ctx()).length, 'clean and dirty must be judged alike').toBe(1);
    });

    it('does not spawn git on this path either (.git/HEAD fast path)', () => {
        onMergedBranch();
        state.gitHead = 'ref: refs/heads/dean/x\n';
        expect(rule().check(ctx()).length).toBe(1);
        expect(state.execBranchCalls).toBe(0);
    });

    it('blocks with PR#? when the merged PR number is unknown', () => {
        onMergedBranch({ mergedPr: '' });
        expect(rule().check(ctx()).length).toBe(1);
    });
});

// The state-B fail-open valves. Same doctrine as state A: never block on data we do not have.
// The worktree flavour of the merged-branch block. Split into its own describe so the block above
// stays inside the max-method-lines budget.
describe('read-stale-guard — merged LINKED WORKTREE', () => {
    beforeEach(reset);

    // A merged LINKED WORKTREE is the state this guard exists for that the old main-only guard could
    // never see: a worktree can never have `main` checked out, so state A never fires in one. The cure
    // must be the worktree cure — `git checkout -b` is right for the primary clone, and telling a
    // worktree to `git checkout main` would hand it a command git refuses outright.
    it('gives a merged WORKTREE the worktree cure, not the branch one', () => {
        onMergedBranch();
        // A linked worktree's `.git` is a FILE (a gitdir: pointer), which is exactly how
        // WorktreeService.isLinkedWorktree tells the two trees apart.
        state.gitHead = 'gitdir: /repo/.git/worktrees/x\n';
        state.gitIsDir = false;
        const message = rule().check(ctx())[0].message ?? '';
        expect(message).toContain('git worktree add');
        expect(message).not.toContain('git checkout -b');
        // `git checkout main` may be NAMED here — the worktree message warns that it fatals, and that
        // warning is worktree-scoped on purpose (in the primary clone the same command is the easy
        // exit). What must never happen is emitting it as a RUNNABLE step, since that is the part an
        // AI copies and runs. Runnable steps are the indented `  git …` lines.
        const runnable = message.split('\n').filter((line: string): boolean => /^\s+git\s/.test(line));
        expect(runnable.some((line: string): boolean => line.includes('git checkout main'))).toBe(false);
        expect(message).toContain('fatals here');
    });

    it('tells a merged worktree to reap itself, so it stops spending the worktree budget', () => {
        onMergedBranch();
        state.gitHead = 'gitdir: /repo/.git/worktrees/x\n';
        state.gitIsDir = false;
        const message = rule().check(ctx())[0].message ?? '';
        expect(message).toContain('git worktree remove');
        expect(message).toContain('git branch -D');
    });
});

describe('read-stale-guard — merged feature branch, fail-open', () => {
    beforeEach(reset);

    it('still allows reading webpieces.config.json so mode OFF stays reachable', () => {
        onMergedBranch();
        expect(rule().check(ctx('webpieces.config.json')).length).toBe(0);
    });

    it('allows a clean, unmerged feature branch', () => {
        onMergedBranch({ branchAlreadyMerged: false, mergedPr: '' });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when there is no cache yet', () => {
        state.branch = 'dean/x';
        state.status = null;
        expect(rule().check(ctx()).length).toBe(0);
    });

    // This is also what un-blocks the agent the moment it follows the cure: the new branch has no
    // cache entry of its own yet, so the merged flag from the OLD branch can never leak onto it.
    it('fails open when the cache is for a different branch', () => {
        state.branch = 'dean/fresh';
        state.status = mergedStatus();
        expect(rule().check(ctx()).length).toBe(0);
    });
});

// ---- config -------------------------------------------------------------------------------------
describe('read-stale-guard — config', () => {
    beforeEach(reset);

    it('does not run when mode is OFF', () => {
        const cfg = new BranchStateGuardConfig();
        cfg.mode = 'OFF';
        expect(new ReadStaleGuardRule(cfg).shouldRun()).toBe(false);
    });
});
