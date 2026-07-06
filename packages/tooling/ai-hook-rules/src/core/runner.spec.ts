import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { ExcludePaths, RuleFailError } from '@webpieces/rules-config';

import { filterByExcludedPaths, isGitOrGhCommand, runRuleCheck, runBash } from './runner';
import { Rule, Violation, BashContext, BlockedResult } from './types';

// The helper only reads `rule.name` to classify a rule as guard vs code rule (via isHookGuard), so
// a minimal stand-in is enough. 'feature-branch-guard' is a hook guard; 'max-file-lines' is a code rule.
function ruleNamed(name: string): Rule {
    return { name } as unknown as Rule;
}

const codeRule = ruleNamed('max-file-lines');
const guard = ruleNamed('feature-branch-guard');

function names(rules: readonly Rule[]): string[] {
    return rules.map((r: Rule): string => r.name);
}

describe('filterByExcludedPaths', () => {
    it('drops code rules on an excluded rules path but keeps guards (lists vary independently)', () => {
        const ex = new ExcludePaths(['repositories/**'], []);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['feature-branch-guard']);
    });

    it('drops guards on an excluded guards path but keeps code rules (lists vary independently)', () => {
        const ex = new ExcludePaths([], ['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines']);
    });

    it('keeps every rule for a path that matches no exclusion', () => {
        const ex = new ExcludePaths(['repositories/**'], ['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'src/app/service.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('drops both categories when both lists match the path', () => {
        const ex = new ExcludePaths(['vendor/**'], ['vendor/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'vendor/lib/x.ts', ex);
        expect(kept).toEqual([]);
    });

    it('keeps everything when both lists are empty (default behavior)', () => {
        const ex = new ExcludePaths([], []);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
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

    it('converts a thrown RuleFailError into a Violation with its line/snippet and folds in fix hints', () => {
        const err = new RuleFailError('no-any-unknown', 'Avoid any here', 42, 'const x: any', ['use unknown', 'add a type']);
        const vs = runRuleCheck(ruleThatThrows('no-any-unknown', err), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(42);
        expect(vs[0]?.snippet).toBe('const x: any');
        expect(vs[0]?.message).toContain('Avoid any here');
        expect(vs[0]?.message).toContain('Fix: use unknown');
        expect(vs[0]?.message).toContain('Fix: add a type');
    });

    it('converts a thrown plain Error (a bug) into a visible "crashed" Violation, not a propagated throw', () => {
        const vs = runRuleCheck(ruleThatThrows('buggy-rule', new Error('boom')), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(0);
        expect(vs[0]?.message).toContain("Rule 'buggy-rule' crashed: boom");
    });
});

describe('isGitOrGhCommand (drives force-to-root)', () => {
    it('matches a plain git/gh command', () => {
        expect(isGitOrGhCommand('git commit -m x')).toBe(true);
        expect(isGitOrGhCommand('gh pr create')).toBe(true);
    });

    it('matches git/gh after a shell separator', () => {
        expect(isGitOrGhCommand('cd sub && git status')).toBe(true);
        expect(isGitOrGhCommand('echo hi; git push')).toBe(true);
        expect(isGitOrGhCommand('foo | gh pr list')).toBe(true);
    });

    it('does NOT match words that merely contain git/gh', () => {
        expect(isGitOrGhCommand('echo github.com')).toBe(false);
        expect(isGitOrGhCommand('ls digital/')).toBe(false);
        expect(isGitOrGhCommand('cat gitignore-notes.md')).toBe(false);
    });
});

describe('runBash installer bypass (deadlock escape: installs pass even with no/invalid config)', () => {
    // A dir with NO webpieces.config.json anywhere above it → a normal command is blocked with the
    // CONFIG_MISSING report. Installer commands must slip past that (and past config validation) so
    // `pnpm install` can re-enable the guards when the config is ahead of the installed validator.
    function tmpDirOutsideRepo(): string {
        return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-ai-hook-'));
    }

    it('lets `pnpm install` / `npm i` through (null = allow) where a normal command is blocked', () => {
        const dir = tmpDirOutsideRepo();
        expect(runBash('pnpm install', dir, 'guards')).toBeNull();
        expect(runBash('  npm i --frozen-lockfile ', dir, 'guards')).toBeNull();
        // Contrast: a non-installer command in the same config-less dir is NOT bypassed.
        expect(runBash('ls', dir, 'guards')).toBeInstanceOf(BlockedResult);
    });

    it('does NOT bypass a chained command that merely starts with an installer', () => {
        const dir = tmpDirOutsideRepo();
        // Falls through to config handling instead of short-circuiting to allow.
        expect(runBash('pnpm install && rm -rf /', dir, 'guards')).toBeInstanceOf(BlockedResult);
    });
});
