import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MatchRuleConfig } from '@webpieces/rules-config';
import { findViolationsInFile } from '../validate-match-rules';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-rules-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): string {
    const fullPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return relativePath;
}

// A no-fetch-style guard (fetch + axios), allowlisting the client factory.
function noFetch(disableAllowed = true): MatchRuleConfig {
    return new MatchRuleConfig(
        'no-fetch',
        ['(?<![.\\w])fetch\\s*\\(', '\\baxios\\b'],
        'Use the generated client.',
        'NEW_AND_MODIFIED_CODE',
        0,
        [],
        disableAllowed,
        ['packages/http/http-client/**'],
    );
}

describe('findViolationsInFile (match-rules / code-rules layer)', () => {
    it('flags raw fetch and axios', () => {
        const file = writeFile('src/a.ts', "const r = await fetch(url);\nconst c = axios.get(url);\n");
        const v = findViolationsInFile(file, tmpDir, noFetch());
        expect(v.map(x => x.line)).toEqual([1, 2]);
        expect(v.every(x => !x.hasDisableComment)).toBe(true);
    });

    it('does not flag member-access fetch or the generated client', () => {
        const file = writeFile('src/a.ts', "this.fetch(url);\nsvc.fetchValue(req);\ncreateApiClient(Api, cfg);\n");
        expect(findViolationsInFile(file, tmpDir, noFetch())).toHaveLength(0);
    });

    it('exempts allowlisted paths and test files', () => {
        const factory = writeFile('packages/http/http-client/src/ClientFactory.ts', 'await fetch(url);\n');
        expect(findViolationsInFile(factory, tmpDir, noFetch())).toHaveLength(0);
        const spec = writeFile('src/a.spec.ts', 'await fetch(url);\n');
        expect(findViolationsInFile(spec, tmpDir, noFetch())).toHaveLength(0);
    });

    it('marks a line disabled by // webpieces-disable no-fetch (same line or line above)', () => {
        const file = writeFile('src/a.ts', [
            'await fetch(url); // webpieces-disable no-fetch -- external health check',
            '// webpieces-disable no-fetch -- legacy',
            'await fetch(url2);',
        ].join('\n'));
        const v = findViolationsInFile(file, tmpDir, noFetch());
        expect(v).toHaveLength(2);
        expect(v.every(x => x.hasDisableComment)).toBe(true);
    });

    it('ignores the disable comment when disableAllowed is false', () => {
        const file = writeFile('src/a.ts', 'await fetch(url); // webpieces-disable no-fetch -- nope\n');
        const v = findViolationsInFile(file, tmpDir, noFetch(false));
        expect(v).toHaveLength(1);
        expect(v[0]!.hasDisableComment).toBe(false);
    });

    it('returns [] for a missing file', () => {
        expect(findViolationsInFile('src/missing.ts', tmpDir, noFetch())).toHaveLength(0);
    });
});
