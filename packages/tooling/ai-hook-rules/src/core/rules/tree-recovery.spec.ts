import { describe, it, expect, vi, beforeEach } from 'vitest';

// What WorktreeService.isLinkedWorktree reports for the root under test.
const state = vi.hoisted(() => ({ linked: false }));

vi.mock('@webpieces/rules-config', () => ({
    WorktreeService: class {
        isLinkedWorktree(): boolean { return state.linked; }
    },
}));

import { TreeRecovery } from './tree-recovery';

beforeEach(() => {
    state.linked = false;
});

// The whole point of this class: an AI runs these strings literally, so a command that fatals in the
// tree it is handed to is a bug, not a wording nit.
const FATAL_IN_WORKTREE = 'git checkout main';

describe('TreeRecovery.kindOf', () => {
    it('reports the primary clone as a branch tree', () => {
        expect(new TreeRecovery().kindOf('/repo')).toBe('branch');
    });

    it('reports a linked worktree as a worktree tree', () => {
        state.linked = true;
        expect(new TreeRecovery().kindOf('/work/feature')).toBe('worktree');
    });
});

describe('TreeRecovery.freshStartSteps', () => {
    it('gives a worktree ONLY the `git worktree add` form', () => {
        const text = new TreeRecovery().freshStartSteps('worktree', 'dean/x').join('\n');
        expect(text).toContain('git worktree add ../dean-x -b dean/x origin/main');
        expect(text).not.toContain('git checkout -b');
    });

    it('gives the primary clone ONLY the `git checkout -b` form', () => {
        const text = new TreeRecovery().freshStartSteps('branch', 'dean/x').join('\n');
        expect(text).toContain('git checkout -b dean/x origin/main');
        expect(text).not.toContain('git worktree add');
    });

    // When detection failed we must not guess — a labelled menu is recoverable, a wrong command is not.
    it('gives BOTH forms, labelled, when the tree kind is unknown', () => {
        const text = new TreeRecovery().freshStartSteps('unknown', 'dean/x').join('\n');
        expect(text).toContain('git checkout -b dean/x origin/main');
        expect(text).toContain('git worktree add ../dean-x -b dean/x origin/main');
        expect(text).toContain('primary clone');
        expect(text).toContain('linked worktree');
    });

    // Prose may NAME the fatal command to warn about it; what must never happen is emitting it as a
    // runnable step (an indented command line), because that is the part an AI copies and runs.
    it('never emits `git checkout main` as a runnable step, in any tree kind', () => {
        for (const kind of ['worktree', 'branch', 'unknown'] as const) {
            // A runnable step is an indented line that STARTS with the command (label lines that
            // merely mention it, like "- in a linked worktree (`git checkout main` fatals)", are prose).
            const commandLines = new TreeRecovery().freshStartSteps(kind)
                .filter((line: string): boolean => /^\s+git\s/.test(line));
            expect(commandLines.some((line: string): boolean => line.includes(FATAL_IN_WORKTREE))).toBe(false);
        }
    });

    /**
     * The parenthetical "never `git checkout main`" is a WORKTREE-only truth (main is checked out in
     * the primary clone, so the checkout fatals there). It had leaked into the `branch` arm — the
     * primary clone, where that command is not merely safe but the shortest exit off a merged branch.
     * An agent read the prohibition literally, concluded its only way out was a new branch, hit the
     * branch cap, and escaped by editing webpieces.config.json. A human ended it with the one command
     * the guard had told the agent never to run.
     */
    it('does NOT forbid `git checkout main` in the primary clone', () => {
        const text = new TreeRecovery().freshStartSteps('branch', 'dean/x').join('\n');
        expect(text).not.toContain('never `git checkout main`');
        expect(text).not.toContain('git checkout main');
    });

    it('still warns a WORKTREE that `git checkout main` fatals there', () => {
        const worktree = new TreeRecovery().freshStartSteps('worktree', 'dean/x').join('\n');
        expect(worktree).toContain('`git checkout main` fatals here');
        const unknown = new TreeRecovery().freshStartSteps('unknown', 'dean/x').join('\n');
        expect(unknown).toContain('in a linked worktree (`git checkout main` fatals there)');
    });

    // The worktree DIRECTORY cannot contain the branch's slashes.
    it('flattens a slashed branch name into a sibling directory name', () => {
        const text = new TreeRecovery().freshStartSteps('worktree', 'dean/some/deep/name').join('\n');
        expect(text).toContain('../dean-some-deep-name');
    });
});

describe('TreeRecovery.cleanupSteps', () => {
    // Load-bearing ORDER: prune clears worktrees whose dir is gone (remove FAILS on those), and the
    // branch delete must come last because git refuses to delete a branch a worktree still holds.
    it('reaps a worktree prune → remove → delete, in that order', () => {
        const text = new TreeRecovery().cleanupSteps('worktree', 'dean/x', '/work/x').join('\n');
        const prune = text.indexOf('git worktree prune');
        const remove = text.indexOf('git worktree remove /work/x');
        const del = text.indexOf('git branch -D dean/x');
        expect(prune).toBeGreaterThanOrEqual(0);
        expect(prune).toBeLessThan(remove);
        expect(remove).toBeLessThan(del);
    });

    /**
     * The primary-clone form is the ONE command `pnpm wp-sync-main`, never a bare
     * `git branch -d`. An agent treats a raw delete flag as destructive and stops to ask, so the branch
     * survives the turn — which is precisely how local branches piled up while this advice was being
     * printed correctly.
     *
     * And it is no longer the hand-chained `git checkout main && git pull origin main && pnpm
     * wp-cleanup`: that is the same intention minus the orphan-directory sweep, so printing both was two
     * spellings where one silently did less, and the sweep consequently never ran for anybody. The
     * `not.toContain` on the raw pair is the pin for that — the WORKFLOW layer must stop teaching it.
     * (L0 recovery still uses the raw pair; that is a different layer and has its own tests.)
     */
    it('uses the one-command form in the primary clone, never a raw branch delete or the hand-rolled pair', () => {
        const text = new TreeRecovery().cleanupSteps('branch', 'dean/x').join('\n');
        expect(text).toContain('pnpm wp-sync-main');
        expect(text).not.toContain('git checkout main && git pull origin main');
        expect(text).not.toContain('git branch -d');
        expect(text).not.toContain('git worktree remove');
    });

    // The worktree arm keeps its explicit `git branch -D`: wp-cleanup deliberately spares
    // worktree-held branches, so it cannot finish that job.
    it('gives both forms when unknown', () => {
        const text = new TreeRecovery().cleanupSteps('unknown', 'dean/x', '/work/x').join('\n');
        expect(text).toContain('pnpm wp-sync-main');
        expect(text).toContain('git worktree remove /work/x');
        expect(text).toContain('git branch -D dean/x');
    });
});

describe('TreeRecovery.updateMainSteps', () => {
    it('never tells a worktree to check out main — it fetches instead', () => {
        const text = new TreeRecovery().updateMainSteps('worktree').join('\n');
        expect(text).toContain('git fetch origin main');
        expect(text).not.toContain(FATAL_IN_WORKTREE + ' &&');
        expect(text).not.toContain('git pull origin main');
    });

    /**
     * The primary clone gets `pnpm wp-sync-main` — checkout, pull, cleanup and the
     * orphan-directory sweep as one intention — and NOT the raw pair it used to print. The negative
     * assertion is the load-bearing half: the raw pair is still allowed to RUN (it is plain git, and it
     * is the L0 recovery cure), so the only thing that makes the one-command form win is that the
     * guards stop teaching the other one.
     */
    it('prescribes the one command for the primary clone, not the hand-rolled pair', () => {
        const text = new TreeRecovery().updateMainSteps('branch').join('\n');
        expect(text).toContain('pnpm wp-sync-main');
        expect(text).not.toContain('git checkout main && git pull origin main');
    });

    it('gives both forms when unknown', () => {
        const text = new TreeRecovery().updateMainSteps('unknown').join('\n');
        expect(text).toContain('pnpm wp-sync-main');
        expect(text).toContain('git fetch origin main');
        expect(text).not.toContain('git checkout main && git pull origin main');
    });
});

describe('TreeRecovery placeholder rendering', () => {
    // Regression: sanitizing the default `<new-feature-branch>` produced `../-new-feature-branch-`,
    // which reads like a real directory and is exactly what an agent pastes verbatim.
    it('keeps the worktree directory a readable placeholder when the branch name is one', () => {
        const text = new TreeRecovery().freshStartSteps('worktree').join('\n');
        expect(text).toContain('git worktree add ../<feature-dir> -b <new-feature-branch> origin/main');
        expect(text).not.toContain('-new-feature-branch-');
    });
});
