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

    it('uses the plain checkout+delete form in the primary clone', () => {
        const text = new TreeRecovery().cleanupSteps('branch', 'dean/x').join('\n');
        expect(text).toContain('git branch -d dean/x');
        expect(text).not.toContain('git worktree remove');
    });

    it('gives both forms when unknown', () => {
        const text = new TreeRecovery().cleanupSteps('unknown', 'dean/x', '/work/x').join('\n');
        expect(text).toContain('git branch -d dean/x');
        expect(text).toContain('git worktree remove /work/x');
    });
});

describe('TreeRecovery.updateMainSteps', () => {
    it('never tells a worktree to check out main — it fetches instead', () => {
        const text = new TreeRecovery().updateMainSteps('worktree').join('\n');
        expect(text).toContain('git fetch origin main');
        expect(text).not.toContain(FATAL_IN_WORKTREE + ' &&');
        expect(text).not.toContain('git pull origin main');
    });

    it('keeps checkout+pull for the primary clone', () => {
        const text = new TreeRecovery().updateMainSteps('branch').join('\n');
        expect(text).toContain('git checkout main && git pull origin main');
    });

    it('gives both forms when unknown', () => {
        const text = new TreeRecovery().updateMainSteps('unknown').join('\n');
        expect(text).toContain('git checkout main && git pull origin main');
        expect(text).toContain('git fetch origin main');
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
