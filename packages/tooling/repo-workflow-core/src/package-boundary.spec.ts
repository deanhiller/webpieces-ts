import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** The shared mechanics must never acquire consumer policy or PR review state. */
describe('repo-workflow-core production boundary', () => {
    it('depends only on generic tooling primitives and platform libraries', () => {
        const imports: string[] = [];
        for (const file of fs.readdirSync(__dirname)) {
            if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
            const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
            for (const match of source.matchAll(/from\s+['"](@webpieces\/[^'"]+)['"]/g)) {
                imports.push(match[1]!);
            }
        }
        expect([...new Set(imports)]).toEqual(['@webpieces/tooling-common']);
    });
});
