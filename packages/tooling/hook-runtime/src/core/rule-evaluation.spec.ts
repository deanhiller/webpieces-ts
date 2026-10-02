import { specTempDirs } from '@webpieces/tooling-testkit';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { ExcludePaths, RuleFailError, Option } from '@webpieces/rules-config';



import { runRuleCheck } from '@webpieces/hook-runtime';
import { filterByExcludedPaths } from '@webpieces/hook-runtime';
import { GovernedPath } from '@webpieces/hook-runtime';
import { Rule, Violation, BashContext, BlockedResult, NormalizedToolInput, NormalizedEdit } from '@webpieces/hook-runtime';

// filterByExcludedPaths reads only `rule.name` (for the assertions below), so a minimal stand-in is
// enough. `configKey` is carried too because the SIBLING helper filterByMode classifies on that field
// rather than on the name — a stand-in with only a name would classify the guard as a code rule.
function ruleNamed(name: string, configKey: string): Rule {
    return { name, configKey } as unknown as Rule;
}

const codeRule = ruleNamed('max-file-lines', 'max-file-lines');
// A CLASS name whose config key is the branch-state POLICY — the exact pair the collapse creates.
const guard = ruleNamed('feature-branch-guard', 'branch-state-guard');

function names(rules: readonly Rule[]): string[] {
    return rules.map((r: Rule): string => r.name);
}

// The PRIMARY-CLONE shape of a GovernedPath: the governed root and the owning tree are the same
// directory, so both spellings of the path are the same string. That is what these cases are about —
// the worktree shape, where they DIFFER, is pinned in target-tree.spec.ts against real git worktrees,
// because it is only interesting when git says the two roots are not the same tree.
function samePath(relative: string): GovernedPath {
    return new GovernedPath(relative, relative, '/repo');
}

describe('filterByExcludedPaths', () => {
    // ONE list now: an excluded path is hands-off for code rules and guards alike. The old two-list
    // form let them vary independently; no consumer ever did, and a per-rule carve-out is served by
    // the rule's OWN excludePaths instead.
    it('drops EVERY rule — code rules and guards — on an excluded path', () => {
        const ex = new ExcludePaths(['repositories/**']);
        expect(filterByExcludedPaths([codeRule, guard], samePath('repositories/foo/bar.ts'), ex)).toEqual([]);
    });

    it('keeps every rule for a path that matches no exclusion', () => {
        const ex = new ExcludePaths(['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], samePath('src/app/service.ts'), ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('keeps every rule when the list is empty (enforce everywhere, bar the one hard-coded skip below)', () => {
        const kept = filterByExcludedPaths([codeRule, guard], samePath('vendor/lib/x.ts'), new ExcludePaths([]));
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('keeps everything when the list is empty even on a would-be-excluded path', () => {
        const kept = filterByExcludedPaths([codeRule, guard], samePath('repositories/foo/bar.ts'), new ExcludePaths([]));
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    // The `.webpieces/` skip is HARD-CODED, ahead of the config list, and these cases are the reason:
    // every one of them was a live block against the tooling's own gitignored state. The motivating
    // one is the third — wp-review-upsert-pr tells a reviewer subagent to write its verdict under
    // `<primary>/.webpieces/worktrees/…`, feature-branch-guard resolved that to the PRIMARY clone and
    // judged the primary's branch, so the reviewer was denied whenever the primary sat on main.
    it('drops EVERY rule under .webpieces/ even with an EMPTY excludePaths', () => {
        const ex = new ExcludePaths([]);
        expect(filterByExcludedPaths([codeRule, guard], samePath('.webpieces/tasks.md'), ex)).toEqual([]);
    });

    it('drops EVERY rule for the BARE .webpieces directory — the form a `.webpieces/**` glob misses', () => {
        expect(filterByExcludedPaths([codeRule, guard], samePath('.webpieces'), new ExcludePaths([]))).toEqual([]);
    });

    it('drops EVERY rule for a reviewer verdict written into a worktree namespace', () => {
        const path = '.webpieces/worktrees/agent-abc123/pr-review/dean-feature/review-1.json';
        expect(filterByExcludedPaths([codeRule, guard], samePath(path), new ExcludePaths([]))).toEqual([]);
    });

    // FIRST SEGMENT ONLY. A sibling whose name merely starts with the same characters, and a nested
    // `.webpieces` belonging to something else, both stay governed — the skip is about THE state dir
    // at the workspace root, not about the string.
    it('keeps every rule for a path that only LOOKS like the state dir', () => {
        const ex = new ExcludePaths([]);
        expect(names(filterByExcludedPaths([codeRule, guard], samePath('.webpieces-notes/x.ts'), ex))).toEqual(['max-file-lines', 'feature-branch-guard']);
        expect(names(filterByExcludedPaths([codeRule, guard], samePath('packages/.webpieces/x.ts'), ex))).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    // '' is what the BASH path passes when the command has no leading `cd` (effectiveCwd === root).
    // A skip that matched it would exempt every bash guard in the repo.
    it('keeps every rule for the repo root itself', () => {
        expect(names(filterByExcludedPaths([codeRule, guard], samePath(''), new ExcludePaths([])))).toEqual(['max-file-lines', 'feature-branch-guard']);
    });
});

describe('runRuleCheck (N-legs: a rule may return violations OR throw; never propagates)', () => {
    const ctx = {} as unknown as BashContext; // a throwing/returning check ignores the context

    function ruleThatThrows(name: string, err: Error): Rule {
        return { name, check: (): readonly Violation[] => { throw err; } } as unknown as Rule;
    }

    it('passes through returned violations unchanged', () => {
        const rule = { name: 'r', check: (): readonly Violation[] => [new Violation(3, 'x', 'msg')] } as unknown as Rule;
        const vs = runRuleCheck(rule, ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.message).toBe('msg');
    });

    it('converts a thrown RuleFailError into a Violation with its line/snippet and folds in its cures', () => {
        const err = new RuleFailError('no-any-unknown', 'Avoid any here', 42, 'const x: any',
            [new Option('use unknown', true), new Option('add a type')]);
        const vs = runRuleCheck(ruleThatThrows('no-any-unknown', err), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(42);
        expect(vs[0]?.snippet).toBe('const x: any');
        expect(vs[0]?.message).toContain('Avoid any here');
        // Framework-owned numbering + "(preferred)" tag — the SAME renderer report.ts uses for a
        // rule's static FixHint, so a thrown cure and a declared cure read identically to the AI.
        expect(vs[0]?.message).toContain('Fix Option 1: (preferred) use unknown');
        expect(vs[0]?.message).toContain('Fix Option 2: add a type');
    });

    it('converts a thrown plain Error (a bug) into a visible "crashed" Violation, not a propagated throw', () => {
        const vs = runRuleCheck(ruleThatThrows('buggy-rule', new Error('boom')), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(0);
        expect(vs[0]?.message).toContain("Rule 'buggy-rule' crashed: boom");
    });
});

