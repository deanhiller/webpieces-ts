import { ExcludePaths } from '@webpieces/rules-config';

import { filterByExcludedPaths, isGitOrGhCommand } from './runner';
import { Rule } from './types';

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
