/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { run } from '../runner';
import { NormalizedToolInput, NormalizedEdit } from '../types';

function makeWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-runner-test-'));
}

function writeFile(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

describe('core runner', () => {
    it('returns null when no config in tree', () => {
        const ws = makeWorkspace();
        const input = new NormalizedToolInput(
            path.join(ws, 'foo.ts'),
            [new NormalizedEdit('', 'const x: number = 1;')],
        );
        const result = run('Write', input, ws);
        expect(result).toBeNull();
    });

    it('returns null when all rules disabled', () => {
        const ws = makeWorkspace();
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                },
                rulesDir: [],
            }),
        );
        const input = new NormalizedToolInput(
            path.join(ws, 'foo.ts'),
            [new NormalizedEdit('', 'const x: number = 1;')],
        );
        const result = run('Write', input, ws);
        expect(result).toBeNull();
    });

    it('blocks custom edit-scope rule on proposed content', () => {
        const ws = makeWorkspace();
        const rulesDir = path.join(ws, 'ai-hooks-rules');
        writeFile(
            path.join(rulesDir, 'ban-foo.js'),
            `module.exports = {
                name: 'ban-foo',
                description: 'Ban foo',
                scope: 'edit',
                files: ['**/*.ts'],
                defaultOptions: {},
                fixHint: ['use bar instead'],
                check(ctx) {
                    const violations = [];
                    ctx.strippedLines.forEach((line, i) => {
                        if (/\\bfoo\\b/.test(line)) {
                            violations.push({ line: i + 1, snippet: ctx.lines[i].trim(), message: 'foo is banned' });
                        }
                    });
                    return violations;
                },
            };`,
        );
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'ban-foo': { enabled: true },
                },
                rulesDir: ['ai-hooks-rules'],
            }),
        );
        const input = new NormalizedToolInput(
            path.join(ws, 'evil.ts'),
            [new NormalizedEdit('', 'const x = foo;\nconst y = bar;')],
        );
        const result = run('Write', input, ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('ban-foo');
        expect(result!.report).toContain('L1');
        expect(result!.report).toContain('foo is banned');
        expect(result!.report).not.toContain('L2');
    });

    it('disable directive suppresses violation', () => {
        const ws = makeWorkspace();
        const rulesDir = path.join(ws, 'ai-hooks-rules');
        writeFile(
            path.join(rulesDir, 'ban-foo.js'),
            `module.exports = {
                name: 'ban-foo',
                description: 'Ban foo',
                scope: 'edit',
                files: ['**/*.ts'],
                defaultOptions: {},
                fixHint: [],
                check(ctx) {
                    const violations = [];
                    ctx.strippedLines.forEach((line, i) => {
                        if (/\\bfoo\\b/.test(line) && !ctx.isLineDisabled(i + 1, 'ban-foo')) {
                            violations.push({ line: i + 1, snippet: ctx.lines[i].trim(), message: 'no foo' });
                        }
                    });
                    return violations;
                },
            };`,
        );
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'ban-foo': { enabled: true },
                },
                rulesDir: ['ai-hooks-rules'],
            }),
        );
        const input = new NormalizedToolInput(
            path.join(ws, 'allowed.ts'),
            [new NormalizedEdit('', 'const x = foo; // ai-hook-disable ban-foo -- legacy')],
        );
        const result = run('Write', input, ws);
        expect(result).toBeNull();
    });

    it('file-scope rule sees projectedFileLines', () => {
        const ws = makeWorkspace();
        const rulesDir = path.join(ws, 'ai-hooks-rules');
        writeFile(
            path.join(rulesDir, 'max-five.js'),
            `module.exports = {
                name: 'max-five',
                description: 'File must be <= 5 lines',
                scope: 'file',
                files: ['**/*.ts'],
                defaultOptions: { limit: 5 },
                fixHint: [],
                check(ctx) {
                    if (ctx.projectedFileLines > ctx.options.limit) {
                        return [{ line: 1, snippet: '(file too long)', message: 'Projected ' + ctx.projectedFileLines + ' lines exceeds limit ' + ctx.options.limit }];
                    }
                    return [];
                },
            };`,
        );
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'max-five': { enabled: true },
                },
                rulesDir: ['ai-hooks-rules'],
            }),
        );
        const longContent = Array(10).fill('const x = 1;').join('\n');
        const input = new NormalizedToolInput(
            path.join(ws, 'big.ts'),
            [new NormalizedEdit('', longContent)],
        );
        const result = run('Write', input, ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('max-five');
        expect(result!.report).toContain('Projected 10 lines');
    });

    it('Edit tool uses new_string as added content', () => {
        const ws = makeWorkspace();
        const target = path.join(ws, 'existing.ts');
        writeFile(target, 'const a = 1;\nconst b = 2;\n');
        const rulesDir = path.join(ws, 'ai-hooks-rules');
        writeFile(
            path.join(rulesDir, 'ban-foo.js'),
            `module.exports = {
                name: 'ban-foo',
                description: 'Ban foo',
                scope: 'edit',
                files: ['**/*.ts'],
                defaultOptions: {},
                fixHint: [],
                check(ctx) {
                    const vs = [];
                    ctx.strippedLines.forEach((l, i) => {
                        if (/foo/.test(l)) vs.push({ line: i+1, snippet: ctx.lines[i].trim(), message: 'no foo' });
                    });
                    return vs;
                },
            };`,
        );
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'ban-foo': { enabled: true },
                },
                rulesDir: ['ai-hooks-rules'],
            }),
        );
        const input = new NormalizedToolInput(target, [
            new NormalizedEdit('const a = 1;', 'const a = foo;'),
        ]);
        const result = run('Edit', input, ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('ban-foo');
    });

    it('MultiEdit reports which edit triggered', () => {
        const ws = makeWorkspace();
        const target = path.join(ws, 'multi.ts');
        writeFile(target, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
        const rulesDir = path.join(ws, 'ai-hooks-rules');
        writeFile(
            path.join(rulesDir, 'ban-foo.js'),
            `module.exports = {
                name: 'ban-foo',
                description: 'Ban foo',
                scope: 'edit',
                files: ['**/*.ts'],
                defaultOptions: {},
                fixHint: [],
                check(ctx) {
                    const vs = [];
                    ctx.strippedLines.forEach((l, i) => {
                        if (/foo/.test(l)) vs.push({ line: i+1, snippet: ctx.lines[i].trim(), message: 'no foo' });
                    });
                    return vs;
                },
            };`,
        );
        writeFile(
            path.join(ws, 'webpieces.ai-hooks.json'),
            JSON.stringify({
                rules: {
                    'no-any-unknown': { enabled: false },
                    'max-file-lines': { enabled: false },
                    'file-location': { enabled: false },
                    'no-destructure': { enabled: false },
                    'require-return-type': { enabled: false },
                    'no-unmanaged-exceptions': { enabled: false },
                    'ban-foo': { enabled: true },
                },
                rulesDir: ['ai-hooks-rules'],
            }),
        );
        const input = new NormalizedToolInput(target, [
            new NormalizedEdit('const a = 1;', 'const a = 11;'),
            new NormalizedEdit('const b = 2;', 'const b = foo;'),
            new NormalizedEdit('const c = 3;', 'const c = 33;'),
        ]);
        const result = run('MultiEdit', input, ws);
        expect(result).not.toBeNull();
        expect(result!.report).toContain('edit 2/3');
    });
});
