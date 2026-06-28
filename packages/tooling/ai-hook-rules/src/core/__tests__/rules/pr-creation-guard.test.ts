/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { runBash } from '../../runner';

function makeWorkspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-pr-guard-'));
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
                'pr-creation-guard': { mode: 'ON' },
            },
            rulesDir: [],
        }),
    );
    return ws;
}

describe('pr-creation-guard', () => {
    it('does not trigger on non-PR commands', () => {
        const ws = makeWorkspace();
        expect(runBash('git status', ws)).toBeNull();
        expect(runBash('git push origin HEAD', ws)).toBeNull();
        expect(runBash('gh pr list', ws)).toBeNull();
    });

    it('shows crash violation (fails visible) when fetch throws due to no remote', () => {
        const ws = makeWorkspace();
        execSync('git init', { cwd: ws });
        execSync('git config user.email "test@test.com"', { cwd: ws });
        execSync('git config user.name "Test"', { cwd: ws });
        fs.writeFileSync(path.join(ws, 'README.md'), 'test');
        execSync('git add .', { cwd: ws });
        execSync('git commit -m "init"', { cwd: ws });
        // No remote — fetch throws. Rule crash is surfaced as a visible violation so AI sees it.
        const result = runBash('gh pr create --title "test"', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('crashed:');
    });

    it('returns null when rule is disabled', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-pr-off-'));
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
                    'pr-creation-guard': { mode: 'OFF' },
                },
                rulesDir: [],
            }),
        );
        expect(runBash('gh pr create --title "test"', ws)).toBeNull();
    });
});
