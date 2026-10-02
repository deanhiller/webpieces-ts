import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

interface Manifest {
    readonly dependencies?: Readonly<Record<string, string>>;
}

function manifest(relative: string): Manifest {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), relative), 'utf8')) as Manifest;
}

describe('hook runtime dependency boundary', () => {
    it('makes runtime changes reach both products without making ai-hook-rules changes reach pr-gate', () => {
        const hooks = manifest('packages/tooling/ai-hook-rules/package.json').dependencies ?? {};
        const gate = manifest('packages/tooling/pr-gate/package.json').dependencies ?? {};
        expect(hooks['@webpieces/hook-runtime']).toBe('workspace:*');
        expect(gate['@webpieces/hook-runtime']).toBe('workspace:*');
        expect(gate['@webpieces/ai-hook-rules']).toBeUndefined();
    });

    it('keeps the pr-gate production source free of ai-hook-rules imports', () => {
        const root = path.join(process.cwd(), 'packages/tooling/pr-gate/src');
        const pending: string[] = [root];
        const imports: string[] = [];
        while (pending.length > 0) {
            const current = pending.pop();
            if (current === undefined) continue;
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(full);
                else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
                    if (fs.readFileSync(full, 'utf8').includes('@webpieces/ai-hook-rules')) imports.push(full);
                }
            }
        }
        expect(imports).toEqual([]);
    });
});
