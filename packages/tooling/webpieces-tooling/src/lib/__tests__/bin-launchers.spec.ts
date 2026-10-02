import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Aggregate source-shape audit; process behavior stays in each bin owner.
const TOOLING = path.resolve(__dirname, '..', '..', '..', '..');

describe('every declared bin has a process launcher', () => {
    const packagesWithBins = fs.readdirSync(TOOLING).filter((name: string): boolean => fs.existsSync(path.join(TOOLING, name, 'package.json')));

    it('maps every publishConfig.bin target back to a source file carrying `require.main === module`', () => {
        const missing: string[] = [];
        let checked = 0;
        for (const pkg of packagesWithBins) {
            const manifestPath = path.join(TOOLING, pkg, 'package.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
                bin?: Record<string, string>;
                publishConfig?: { bin?: Record<string, string> };
            };
            // A top-level `bin` is itself banned here (see `.claude/rules/packaging-and-bins.md`), but if one
            // ever appears it must
            // still launch something, so both maps are audited.
            const bins = { ...(manifest.publishConfig?.bin ?? {}), ...(manifest.bin ?? {}) };
            for (const [name, target] of Object.entries(bins)) {
                const source = path.join(TOOLING, pkg, target.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
                expect(fs.existsSync(source), `${name} -> ${source}`).toBe(true);
                const text = fs.readFileSync(source, 'utf8');
                checked++;
                // The launcher spellings actually in use across the tooling packages: the
                // dependency-free `require.main === module` guard (agent-workflow-rules bins, which may not
                // import @webpieces/rules-config), a top-level `runMain(...)` (pr-gate's scripts), and a
                // top-level `main()` / `void main()` (code-rules). Anything else is presumed missing —
                // a new bin should copy one of these, not invent a fourth.
                const launched = /require\.main\s*===\s*module/.test(text)
                    || /^\s*(void\s+)?runMain\(/m.test(text)
                    || /^\s*(void\s+)?main\(\);/m.test(text);
                if (!launched) missing.push(`${pkg}:${name} (${target})`);
            }
        }
        expect(checked).toBeGreaterThanOrEqual(17);   // all currently published tooling bins
        expect(missing).toEqual([]);
    });
});

