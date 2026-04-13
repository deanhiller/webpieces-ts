import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-destr-'));
    fs.writeFileSync(path.join(dir, 'webpieces.ai-hooks.json'), JSON.stringify({
        rules: { 'no-any-unknown': { enabled: false }, 'max-file-lines': { enabled: false },
            'file-location': { enabled: false }, 'require-return-type': { enabled: false },
            'no-unmanaged-exceptions': { enabled: false } },
        rulesDir: [],
    }));
    return dir;
}

describe('no-destructure rule', () => {
    it('blocks const { x } = obj', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const { x } = obj;')]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('no-destructure');
    });

    it('blocks let { x } = obj', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'let { a, b } = obj;')]), w);
        expect(r).not.toBeNull();
    });

    it('allows const x = obj.x (no destructure)', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const x = obj.x;')]), w);
        expect(r).toBeNull();
    });

    it('respects ai-hook-disable', () => {
        const w = ws();
        const content = '// ai-hook-disable no-destructure -- needed for spread\nconst { a, ...rest } = obj;';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('allows object literal (not destructure)', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', 'const obj = { x: 1, y: 2 };')]), w);
        expect(r).toBeNull();
    });
});
