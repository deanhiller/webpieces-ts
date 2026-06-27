/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { runBash } from '../../runner';

function makeWorkspace(onMain = false): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-no-update-'));
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
                'no-direct-main-update': { mode: 'ON' },
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
    if (!onMain) {
        execSync('git checkout -b feature/my-work', { cwd: ws });
    }
    return ws;
}

describe('no-direct-main-update', () => {
    describe('blocks on feature branches', () => {
        it('blocks git merge origin/main', () => {
            const ws = makeWorkspace();
            const result = runBash('git merge origin/main', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('no-direct-main-update');
            expect(result!.report).toContain('3-point fork-point');
        });

        it('blocks git merge main', () => {
            const ws = makeWorkspace();
            const result = runBash('git merge main', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('no-direct-main-update');
        });

        it('blocks git rebase origin/main', () => {
            const ws = makeWorkspace();
            const result = runBash('git rebase origin/main', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('no-direct-main-update');
        });

        it('blocks git rebase main', () => {
            const ws = makeWorkspace();
            const result = runBash('git rebase main', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('no-direct-main-update');
        });

        it('blocks git pull origin main', () => {
            const ws = makeWorkspace();
            const result = runBash('git pull origin main', ws);
            expect(result).not.toBeNull();
            expect(result!.report).toContain('no-direct-main-update');
        });
    });

    describe('allows on main branch', () => {
        it('allows git merge origin/main when on main', () => {
            const ws = makeWorkspace(true);
            expect(runBash('git merge origin/main', ws)).toBeNull();
        });

        it('allows git pull origin main when on main', () => {
            const ws = makeWorkspace(true);
            expect(runBash('git pull origin main', ws)).toBeNull();
        });
    });

    describe('allows unrelated commands', () => {
        it('allows git merge feature-branch (not main)', () => {
            const ws = makeWorkspace();
            expect(runBash('git merge other-feature', ws)).toBeNull();
        });

        it('allows git rebase feature-branch', () => {
            const ws = makeWorkspace();
            expect(runBash('git rebase other-feature', ws)).toBeNull();
        });

        it('allows git status', () => {
            const ws = makeWorkspace();
            expect(runBash('git status', ws)).toBeNull();
        });
    });

    it('returns null when rule is disabled', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-no-update-off-'));
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
                    'no-direct-main-update': { mode: 'OFF' },
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
        expect(runBash('git merge main', ws)).toBeNull();
    });
});
