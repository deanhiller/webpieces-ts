import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as nodePath from 'path';
import { GoldenRepoBuilder, GOLDEN_FIXTURES } from '../adapters/hook-app-fixtures';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from '@webpieces/hook-runtime';
import { run } from './runner';

/**
 * Issue #1371 — on a `/hotfix/` branch the edit-time code rules stand down, matching `hotfix-ci`
 * (compile + tests only). The CONTROL cases pin the predicate's exactness: it is BranchIdentity's one
 * case-sensitive `/hotfix/` SEGMENT, so a branch that merely mentions hotfix is still judged.
 */
describe('run — the edit-time code rules on a /hotfix/ branch', () => {
    // `const { a } = b;` trips no-destructure, so this content is provably judged when the rules run.
    const offending = 'const { a } = b;\n';

    function repoOn(branch: string): string {
        const repo = new GoldenRepoBuilder().build(GOLDEN_FIXTURES[0]).repo;
        execSync(`git -C "${repo}" -c core.hooksPath=/dev/null checkout -q -b "${branch}"`, { stdio: 'ignore' });
        return repo;
    }

    function write(repo: string): BlockedResult | null {
        const input = new NormalizedToolInput(nodePath.join(repo, 'src', 'x.ts'), [new NormalizedEdit('', offending, false)]);
        return run('Write', input, repo, 'rules');
    }

    it('runs no code rule on a branch carrying the exact /hotfix/ segment', () => {
        expect(write(repoOn('prod/dean/hotfix/2026-10-22/ONE-3461-test-log-line'))).toBeNull();
    });

    it('CONTROL — a feature branch that only MENTIONS hotfix is still judged', () => {
        expect(write(repoOn('feature/hotfix-thing'))).toBeInstanceOf(BlockedResult);
    });

    it('CONTROL — the segment is case-sensitive, so /HotFix/ is still judged', () => {
        expect(write(repoOn('x/HotFix/y'))).toBeInstanceOf(BlockedResult);
    });
});
