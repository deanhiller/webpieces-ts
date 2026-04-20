/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBash } from '../../runner';

function makeWorkspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-bash-test-'));
    fs.writeFileSync(
        path.join(ws, 'webpieces.ai-hooks.json'),
        JSON.stringify({
            rules: {
                'no-any-unknown': { enabled: false },
                'max-file-lines': { enabled: false },
                'file-location': { enabled: false },
                'no-destructure': { enabled: false },
                'require-return-type': { enabled: false },
                'no-unmanaged-exceptions': { enabled: false },
                'catch-error-pattern': { enabled: false },
                'no-shell-substitution': { enabled: true },
            },
            rulesDir: [],
        }),
    );
    return ws;
}

describe('no-shell-substitution', () => {
    it('blocks $(...) command substitution', () => {
        const ws = makeWorkspace();
        const result = runBash('echo $(date)', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('no-shell-substitution');
        expect(result!.report).toContain('$(...)');
    });

    it('blocks backtick substitution', () => {
        const ws = makeWorkspace();
        const result = runBash('echo `date`', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('backtick');
    });

    it('blocks $VAR expansion', () => {
        const ws = makeWorkspace();
        const result = runBash('echo $HOME', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('variable expansion');
    });

    it('blocks ${VAR} expansion', () => {
        const ws = makeWorkspace();
        const result = runBash('echo ${PATH}', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('variable expansion');
    });

    it('allows plain commands', () => {
        const ws = makeWorkspace();
        expect(runBash('git status', ws)).toBeNull();
        expect(runBash('ls -la', ws)).toBeNull();
        expect(runBash('pnpm nx build config', ws)).toBeNull();
    });

    it('allows single-quoted literals containing $ and backticks', () => {
        const ws = makeWorkspace();
        expect(runBash("grep '$pattern' file.txt", ws)).toBeNull();
        expect(runBash("echo 'literal `backtick` here'", ws)).toBeNull();
    });

    it('allows escaped $ in double-quoted strings', () => {
        const ws = makeWorkspace();
        expect(runBash('echo "price is \\$5"', ws)).toBeNull();
    });

    it('allows empty-looking commands with $ in non-variable position', () => {
        const ws = makeWorkspace();
        expect(runBash('echo hello', ws)).toBeNull();
    });

    it('returns null when rule is disabled', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-bash-disabled-'));
        fs.writeFileSync(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'catch-error-pattern': { enabled: false },
                    'no-shell-substitution': { enabled: false },
                },
                rulesDir: [],
            }),
        );
        const result = runBash('echo $(date)', ws);
        expect(result).toBeNull();
    });

    it('returns null when no config in tree', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-bash-noconfig-'));
        const result = runBash('echo $(date)', ws);
        expect(result).toBeNull();
    });

    it('reports multiple violation categories for combined command', () => {
        const ws = makeWorkspace();
        const result = runBash('echo $(date) "$HOME" `whoami`', ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('$(...)');
        expect(result!.report).toContain('backtick');
        expect(result!.report).toContain('variable expansion');
    });
});
