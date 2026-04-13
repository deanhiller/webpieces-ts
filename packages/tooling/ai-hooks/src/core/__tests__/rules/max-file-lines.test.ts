import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(limit: number = 10): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-file-'));
    fs.writeFileSync(path.join(dir, 'webpieces.ai-hooks.json'), JSON.stringify({
        rules: { 'no-any-unknown': { enabled: false }, 'file-location': { enabled: false },
            'no-destructure': { enabled: false }, 'require-return-type': { enabled: false },
            'no-unmanaged-exceptions': { enabled: false },
            'max-file-lines': { enabled: true, limit } },
        rulesDir: [],
    }));
    return dir;
}

describe('max-file-lines rule', () => {
    it('blocks a file that exceeds the limit', () => {
        const w = ws(5);
        const content = Array(10).fill('const x = 1;').join('\n');
        const r = run('Write', new NormalizedToolInput(path.join(w, 'big.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('max-file-lines');
        expect(r!.report).toContain('10 lines');
    });

    it('allows a file within the limit', () => {
        const w = ws(20);
        const content = Array(5).fill('const x = 1;').join('\n');
        const r = run('Write', new NormalizedToolInput(path.join(w, 'small.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('computes projected lines for Edit (current + added - removed)', () => {
        const w = ws(5);
        const target = path.join(w, 'existing.ts');
        fs.writeFileSync(target, Array(4).fill('const x = 1;').join('\n'));
        const r = run('Edit', new NormalizedToolInput(target, [
            new NormalizedEdit('const x = 1;', 'const a = 1;\nconst b = 2;\nconst c = 3;'),
        ]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('6 lines');
    });

    it('ignores non-ts files', () => {
        const w = ws(3);
        const content = Array(10).fill('line').join('\n');
        const r = run('Write', new NormalizedToolInput(path.join(w, 'big.md'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });
});
