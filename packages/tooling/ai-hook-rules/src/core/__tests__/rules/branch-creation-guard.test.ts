/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { runBash } from '../../runner';

function makeWorkspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-branch-guard-'));
    fs.writeFileSync(
        path.join(ws, 'webpieces.config.json'),
        JSON.stringify({
            rules: {
                'no-any-unknown': { mode: 'OFF' },
                'max-file-lines': { mode: 'OFF' },
                'validate-ts-in-src': { mode: 'OFF' },
                'no-destructure': { mode: 'OFF' },
                'require-return-type': { mode: 'OFF' },
                'no-unmanaged-exceptions': { mode: 'OFF' },
                'catch-error-pattern': { mode: 'OFF' },
                'branch-creation-guard': { mode: 'ON' },
            },
            rulesDir: [],
        }),
    );

    execSync('git init', { cwd: ws });
    execSync('git config user.email "test@test.com"', { cwd: ws });
    execSync('git config user.name "Test"', { cwd: ws });
    fs.writeFileSync(path.join(ws, 'README.md'), 'test');
    execSync('git add .', { cwd: ws });
    execSync('git commit -m "init"', { cwd: ws });
    execSync('git branch -M main', { cwd: ws });
    return ws;
}

describe('branch-creation-guard', () => {
    describe('when not a branch-creation command', () => {
        it('allows git checkout of an existing branch', () => {
            const ws = makeWorkspace();
            expect(runBash('git checkout my-branch', ws)).toBeNull();
        });

        it('allows git branch --list', () => {
            const ws = makeWorkspace();
            expect(runBash('git branch --list', ws)).toBeNull();
        });

        it('allows git branch -d feature', () => {
            const ws = makeWorkspace();
            expect(runBash('git branch -d feature', ws)).toBeNull();
        });

        it('allows git status', () => {
            const ws = makeWorkspace();
            expect(runBash('git status', ws)).toBeNull();
        });
    });

    describe('when on a non-main branch', () => {
        function makeNonMainWorkspace(): string {
            const ws = makeWorkspace();
            execSync('git checkout -b feature/my-work', { cwd: ws });
            return ws;
        }

        it('blocks git checkout -b from a non-main branch', () => {
            const ws = makeNonMainWorkspace();
            const result = runBash('git checkout -b new-branch', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('branch-creation-guard');
            expect(result!.report).toContain('only branch off main');
            expect(result!.report).toContain('human');
        });

        it('blocks git switch -c from a non-main branch', () => {
            const ws = makeNonMainWorkspace();
            const result = runBash('git switch -c new-branch', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('only branch off main');
            expect(result!.report).toContain('human');
        });

        it('blocks git checkout -b even with sub/ prefix from a non-main branch', () => {
            const ws = makeNonMainWorkspace();
            const result = runBash('git checkout -b sub/new-branch', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('only branch off main');
        });

        it('blocks git switch -c even with sub/ prefix from a non-main branch', () => {
            const ws = makeNonMainWorkspace();
            const result = runBash('git switch -c sub/child-branch', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('only branch off main');
        });
    });

    describe('when on main without a remote', () => {
        it('shows crash violation (fails visible) when fetch throws due to no remote', () => {
            const ws = makeWorkspace();
            // No remote — fetch throws. Rule crash is surfaced as a visible violation so AI sees it.
            const result = runBash('git checkout -b new-branch', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain("crashed:");
        });
    });

    it('returns null when rule is disabled', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-branch-off-'));
        fs.writeFileSync(
            path.join(ws, 'webpieces.config.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { mode: 'OFF' },
                    'max-file-lines': { mode: 'OFF' },
                    'validate-ts-in-src': { mode: 'OFF' },
                    'no-destructure': { mode: 'OFF' },
                    'require-return-type': { mode: 'OFF' },
                    'no-unmanaged-exceptions': { mode: 'OFF' },
                    'catch-error-pattern': { mode: 'OFF' },
                    'branch-creation-guard': { mode: 'OFF' },
                },
                rulesDir: [],
            }),
        );
        execSync('git init', { cwd: ws });
        execSync('git config user.email "test@test.com"', { cwd: ws });
        execSync('git config user.name "Test"', { cwd: ws });
        fs.writeFileSync(path.join(ws, 'README.md'), 'test');
        execSync('git add .', { cwd: ws });
        execSync('git commit -m "init"', { cwd: ws });
        execSync('git checkout -b feature', { cwd: ws });
        expect(runBash('git checkout -b another-branch', ws)).toBeNull();
    });
});
