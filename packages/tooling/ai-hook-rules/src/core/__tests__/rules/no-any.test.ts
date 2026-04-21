import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-any-'));
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify({
        rules: { 'max-file-lines': { enabled: false }, 'file-location': { enabled: false },
            'no-destructure': { enabled: false }, 'require-return-type': { enabled: false },
            'no-unmanaged-exceptions': { enabled: false } },
        rulesDir: [],
    }));
    return dir;
}

describe('no-any rule', () => {
    it('blocks : any', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x: any = 1;')]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('no-any-unknown');
    });

    it('blocks as any', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x = y as any;')]), w);
        expect(r).not.toBeNull();
    });

    it('blocks Array<any>', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x: Array<any> = [];')]), w);
        expect(r).not.toBeNull();
    });

    it('allows any in a string', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x = "has any keyword";')]), w);
        expect(r).toBeNull();
    });

    it('allows any in a comment', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', '// any is fine here\nconst x = 1;')]), w);
        expect(r).toBeNull();
    });

    it('respects ai-hook-disable', () => {
        const w = ws();
        const content = '// ai-hook-disable no-any-unknown -- legacy\nconst x: any = 1;';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('allows unknown keyword', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x: unknown = 1;')]), w);
        expect(r).toBeNull();
    });

    it('ignores non-ts files', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.md'), [new NormalizedEdit('', 'const x: any = 1;')]), w);
        expect(r).toBeNull();
    });
});
