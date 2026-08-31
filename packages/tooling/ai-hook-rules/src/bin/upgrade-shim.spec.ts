import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runUpgradeShim } from './upgrade-shim';
import { renderShim, shimPath } from './shim';
import { GUARDS_BIN, readSettings, writeSettings, CLAUDE_REGISTRATION } from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

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

    /**
     * THE HONEST REPORT. `reportRepairs()` prints per REPAIR, not per file: a settings file whose hooks
     * were already current and whose env entry was the only thing missing must NOT be told its
     * registration was rewritten. A cure that misreports its own work is how an agent concludes the
     * wrong thing was fixed — the failure mode this bin's header exists to prevent.
     */
    it('repairs a missing env entry, says exactly that, and does not claim it rewrote the registration', () => {
        const target = shimPath(root);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, renderShim());
        const settingsPath = path.join(root, '.claude', 'settings.json');
        writeSettings(settingsPath, {
            hooks: {
                PreToolUse: [
                    { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN) }] },
                ],
            },
        });
        // Only the env entry is missing here, so the registration must NOT be reported as repaired —
        // that is the whole point of the assertion below.
        expect(runUpgradeShim(root)).toBe(0);

        expect(readSettings(settingsPath).env).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
        const out = logs.join('\n');
        expect(out).toContain(`set env.${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE}`);
        expect(out).toContain('pins the Bash cwd to the project root');
        expect(out).not.toContain('rewrote the hook registration');
    });

    it('says the settings file already matches when nothing needed repairing', () => {
        const target = shimPath(root);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, renderShim());
        expect(runUpgradeShim(root)).toBe(0);
        expect(logs.join('\n')).toContain('already matches this release');
    });

    /**
     * THE CROSS-TREE NOTICE. H1 is registered ABSOLUTE via $CLAUDE_PROJECT_DIR, which never moves off the
     * primary clone — so repairing a LINKED WORKTREE prints four ✅ lines while the session is still
     * governed by the primary's files, binary and pin. The notice answers the question the ✅ lines do
     * not: will the block lift. It is keyed on TREE DIVERGENCE (a main agent in a worktree has the
     * problem; a subagent in the same tree does not), and it is advisory — never an exit code.
     */
    function stageRepairable(): void {
        const target = shimPath(root);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# stale\n');
    }

    it('says nothing about trees when CLAUDE_PROJECT_DIR is unset (a plain CLI run)', () => {
        stageRepairable();
        expect(runUpgradeShim(root)).toBe(0);
        expect(logs.join('\n')).not.toContain('NOT the tree the hooks launch from');
    });

    it('says nothing when CLAUDE_PROJECT_DIR names the tree that was repaired', () => {
        stageRepairable();
        process.env['CLAUDE_PROJECT_DIR'] = root;
        expect(runUpgradeShim(root)).toBe(0);
        expect(logs.join('\n')).not.toContain('NOT the tree the hooks launch from');
    });

    // /tmp is a symlink to /private/tmp on darwin, so the SAME tree arrives under two spellings. Comparing
    // the raw strings would emit the notice on every ordinary run there.
    it('treats a symlinked-but-equivalent path as the same tree', () => {
        stageRepairable();
        const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-link-')), 'tree');
        fs.symlinkSync(root, link, 'dir');
        process.env['CLAUDE_PROJECT_DIR'] = link;   // same tree, a different spelling of it
        expect(runUpgradeShim(root)).toBe(0);
        expect(logs.join('\n')).not.toContain('NOT the tree the hooks launch from');
    });

    it('names BOTH trees, prescribes the primary-tree repair, and still exits 0 when they diverge', () => {
        stageRepairable();
        const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-primary-'));
        process.env['CLAUDE_PROJECT_DIR'] = primary;

        expect(runUpgradeShim(root)).toBe(0);   // advisory only — a verified repair stays a success

        const out = logs.join('\n');
        expect(out).toContain('NOT the tree the hooks launch from');
        expect(out).toContain(root);
        expect(out).toContain(primary);
        expect(out).toContain(`cd ${primary} && pnpm install && pnpm exec wp-upgrade-shim`);
        expect(out).toContain('not wasted work');
        expect(out).not.toContain('subagent');   // the checkable claim is that the TREES differ
        fs.rmSync(primary, { recursive: true, force: true });
    });

    it('returns 1 and explains when there is no managed shim to regenerate', () => {
        const code = runUpgradeShim(root); // no .claude/webpieces/ai-hook.sh anywhere
        expect(code).toBe(1);
        expect(fs.existsSync(shimPath(root))).toBe(false); // it must NOT create one
        expect(logs.join('\n')).toContain('no committed');
    });
});
