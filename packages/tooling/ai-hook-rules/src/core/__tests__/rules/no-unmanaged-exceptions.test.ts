import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-exc-'));
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify({
        rules: { 'no-any-unknown': { enabled: false }, 'max-file-lines': { enabled: false },
            'file-location': { enabled: false }, 'no-destructure': { enabled: false },
            'require-return-type': { enabled: false }, 'catch-error-pattern': { enabled: false } },
        rulesDir: [],
    }));
    return dir;
}

describe('no-unmanaged-exceptions rule', () => {
    it('blocks try/catch without disable comment', () => {
        const w = ws();
        const content = 'try {\n    doSomething();\n} catch (e) {\n    console.error(e);\n}';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('no-unmanaged-exceptions');
    });

    it('allows try with eslint-disable-next-line', () => {
        const w = ws();
        const content = '// eslint-disable-next-line @webpieces/no-unmanaged-exceptions\ntry {\n    doSomething();\n} catch (e) {}';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('allows try with ai-hook-disable', () => {
        const w = ws();
        const content = '// ai-hook-disable no-unmanaged-exceptions -- tested externally\ntry {\n    doSomething();\n} catch (e) {}';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('does not fire on the word try in a string', () => {
        const w = ws();
        const content = 'const msg = "try again later";';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('does not fire on the word try in a comment', () => {
        const w = ws();
        const content = '// try this approach instead\nconst x = 1;';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'f.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });
});
