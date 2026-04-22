/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-loc-'));
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify({
        rules: { 'no-any-unknown': { enabled: false }, 'max-file-lines': { enabled: false },
            'no-destructure': { enabled: false }, 'require-return-type': { enabled: false },
            'no-unmanaged-exceptions': { enabled: false },
            'file-location': { enabled: true, allowedRootFiles: ['jest.setup.ts'], excludePaths: ['scripts', 'tmp'] } },
        rulesDir: [],
    }));
    return dir;
}

describe('file-location rule', () => {
    it('blocks Write to root (orphan)', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'orphan.ts'), [new NormalizedEdit('', 'const x = 1;')]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('file-location');
        expect(r!.report).toContain('not inside any Nx project');
    });

    it('allows Write to allowedRootFiles', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'jest.setup.ts'), [new NormalizedEdit('', 'const x = 1;')]), w);
        expect(r).toBeNull();
    });

    it('allows Write under src/ of a project', () => {
        const w = ws();
        const projectDir = path.join(w, 'packages', 'mylib');
        fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'project.json'), '{}');
        const r = run('Write', new NormalizedToolInput(
            path.join(projectDir, 'src', 'foo.ts'),
            [new NormalizedEdit('', 'const x = 1;')],
        ), w);
        expect(r).toBeNull();
    });

    it('blocks Write outside src/ of a project', () => {
        const w = ws();
        const projectDir = path.join(w, 'packages', 'mylib');
        fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'project.json'), '{}');
        const r = run('Write', new NormalizedToolInput(
            path.join(projectDir, 'stray.ts'),
            [new NormalizedEdit('', 'const x = 1;')],
        ), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('outside its src/ directory');
    });

    it('allows jest.config.ts at project root', () => {
        const w = ws();
        const projectDir = path.join(w, 'packages', 'mylib');
        fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'project.json'), '{}');
        const r = run('Write', new NormalizedToolInput(
            path.join(projectDir, 'jest.config.ts'),
            [new NormalizedEdit('', 'export default {};')],
        ), w);
        expect(r).toBeNull();
    });

    it('skips excluded top-level dirs', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(
            path.join(w, 'scripts', 'tool.ts'),
            [new NormalizedEdit('', 'const x = 1;')],
        ), w);
        expect(r).toBeNull();
    });

    it('does not fire on Edit (file already exists)', () => {
        const w = ws();
        const target = path.join(w, 'orphan.ts');
        fs.writeFileSync(target, 'const old = 1;');
        const r = run('Edit', new NormalizedToolInput(target, [
            new NormalizedEdit('const old = 1;', 'const updated = 2;'),
        ]), w);
        expect(r).toBeNull();
    });
});
