import { run } from '../../runner';
import { NormalizedToolInput, NormalizedEdit } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ws(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-sym-'));
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify({
        rules: { 'no-any-unknown': { mode: 'OFF' }, 'max-file-lines': { mode: 'OFF' },
            'validate-ts-in-src': { mode: 'OFF' }, 'require-return-type': { mode: 'OFF' },
            'no-unmanaged-exceptions': { mode: 'OFF' } },
        rulesDir: [],
    }));
    return dir;
}

describe('no-symbol-di-tokens rule', () => {
    it('blocks = Symbol(...) in a regular file', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'src/tokens.ts'), [new NormalizedEdit('', "export const MY_TOKEN = Symbol('MY_TOKEN');")]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('no-symbol-di-tokens');
    });

    it('blocks = Symbol.for(...) in a regular file', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'src/tokens.ts'), [new NormalizedEdit('', "export const MY_TOKEN = Symbol.for('MY_TOKEN');")]), w);
        expect(r).not.toBeNull();
        expect(r!.report).toContain('no-symbol-di-tokens');
    });

    it('allows Symbol in libraries/apis/ path', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'libraries/apis/my-api/tokens.ts'), [new NormalizedEdit('', "export const MY_TOKEN = Symbol('MY_TOKEN');")]), w);
        expect(r).toBeNull();
    });

    it('allows Symbol in libraries/apis-external/ path', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'libraries/apis-external/stripe/tokens.ts'), [new NormalizedEdit('', "export const STRIPE_TOKEN = Symbol('STRIPE');")]), w);
        expect(r).toBeNull();
    });

    it('allows Symbol in packages/http/http-api/ path', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'packages/http/http-api/src/HeaderTypes.ts'), [new NormalizedEdit('', "export const MULTI = Symbol.for('multi');")]), w);
        expect(r).toBeNull();
    });

    it('respects webpieces-disable comment', () => {
        const w = ws();
        const content = '// webpieces-disable no-symbol-di-tokens -- framework primitive\nexport const MY_TOKEN = Symbol(\'MY_TOKEN\');';
        const r = run('Write', new NormalizedToolInput(path.join(w, 'src/tokens.ts'), [new NormalizedEdit('', content)]), w);
        expect(r).toBeNull();
    });

    it('allows non-DI Symbol usage (e.g. Symbol() as map key not in = assignment)', () => {
        const w = ws();
        const r = run('Write', new NormalizedToolInput(path.join(w, 'src/utils.ts'), [new NormalizedEdit('', 'const key = Symbol; // not an assignment')]), w);
        expect(r).toBeNull();
    });
});
