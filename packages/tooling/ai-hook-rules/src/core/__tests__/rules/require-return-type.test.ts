import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-type-'));
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify({
        rules: { 'no-any-unknown': { enabled: false }, 'max-file-lines': { enabled: false },
            'file-location': { enabled: false }, 'no-destructure': { enabled: false },
            'no-unmanaged-exceptions': { enabled: false } },
        rulesDir: [],
    }));
    return dir;
}

describe('require-return-type rule', () => {
    it('blocks function without return type', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [
            new NormalizedEdit('', 'function foo(x: number) {\n  return x;\n}'),
        ]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('require-return-type');
    });

    it('allows function with return type', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [
            new NormalizedEdit('', 'function foo(x: number): number {\n  return x;\n}'),
        ]), w);
        expect(r).toBeNull();
    });

    it('blocks async method without return type', () => {
        const w = ws();
        const content = '    async fetchData(id: string) {\n        return null;\n    }';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).not.toBeNull();
    });

    it('allows async method with return type', () => {
        const w = ws();
        const content = '    async fetchData(id: string): Promise<string> {\n        return "";\n    }';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('skips constructors', () => {
        const w = ws();
        const content = '    constructor(private x: number) {\n        this.x = x;\n    }';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('blocks arrow function without return type', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [
            new NormalizedEdit('', 'const fn = (x: number) => x + 1;'),
        ]), w);
        expect(r).not.toBeNull();
    });

    it('allows arrow function with return type', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [
            new NormalizedEdit('', 'const fn = (x: number): number => x + 1;'),
        ]), w);
        expect(r).toBeNull();
    });

    it('respects ai-hook-disable', () => {
        const w = ws();
        const content = '// ai-hook-disable require-return-type -- generated\nfunction foo(x: number) {\n  return x;\n}';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });
});
