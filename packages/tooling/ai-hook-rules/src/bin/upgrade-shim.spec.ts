import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runUpgradeShim } from './upgrade-shim';
import { renderShim, shimPath } from './shim';

/**
 * wp-upgrade-shim — the cure the committed-shim self-guard allows through. It must rewrite an existing
 * managed shim back to renderShim() (so the self-guard, which compares the committed shim to the shipped
 * template === renderShim(), clears), and it must NOT invent one where none is managed.
 */
describe('runUpgradeShim', () => {
    let root = '';
    const logs: string[] = [];
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let savedProjectDir: string | undefined;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upgrade-'));
        logs.length = 0;
        // findShimRoot falls back to $CLAUDE_PROJECT_DIR — under Claude Code that points at the REAL repo,
        // whose committed shim the "no managed shim" case would otherwise find (and rewrite). Clear it so
        // each test is judged only by its temp tree.
        savedProjectDir = process.env['CLAUDE_PROJECT_DIR'];
        delete process.env['CLAUDE_PROJECT_DIR'];
        logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
        errSpy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    });
    afterEach(() => {
        logSpy.mockRestore();
        errSpy.mockRestore();
        if (savedProjectDir === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
        else process.env['CLAUDE_PROJECT_DIR'] = savedProjectDir;
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rewrites a reverted committed shim back to renderShim() and returns 0', () => {
        const target = shimPath(root);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# reverted junk\n');

        const code = runUpgradeShim(root);

        expect(code).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe(renderShim()); // re-armed, byte-for-byte
        expect((fs.statSync(target).mode & 0o777)).toBe(0o755);      // executable bit forced on overwrite
        expect(logs.join('\n')).toContain('regenerated the managed shim');
    });

    it('finds the managed shim from a nested subdir (not just the repo root)', () => {
        const target = shimPath(root);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# stale\n');
        const subdir = path.join(root, 'packages', 'deep');
        fs.mkdirSync(subdir, { recursive: true });

        expect(runUpgradeShim(subdir)).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe(renderShim());
    });

    it('returns 1 and explains when there is no managed shim to regenerate', () => {
        const code = runUpgradeShim(root); // no .claude/webpieces/ai-hook.sh anywhere
        expect(code).toBe(1);
        expect(fs.existsSync(shimPath(root))).toBe(false); // it must NOT create one
        expect(logs.join('\n')).toContain('no committed');
    });
});
