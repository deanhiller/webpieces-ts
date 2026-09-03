import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StaleBinRemoval, StaleBinSweeper } from './stale-bin-sweep';
import { TemplateWriter } from './load-template';

/**
 * The sweep exists because pnpm never removes a `.bin` entry for a bin an EARLIER version of the same
 * package shipped. 18 distinct dangling `wp-*` names were found across nine clones on one machine, so the
 * predicate is structural (a `wp-` symlink whose target is gone) and never a list of retired names — a list
 * would go stale exactly the way the symlinks did.
 */
function binDirWith(entries: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-stalebin-'));
    const bin = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const [name, target] of Object.entries(entries)) {
        fs.symlinkSync(target, path.join(bin, name));
    }
    return root;
}

// A real file inside the tree, so a link to it RESOLVES.
function realTarget(root: string, name: string): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, '#!/usr/bin/env node\n');
    return file;
}

describe('StaleBinSweeper', () => {
    it('removes every dangling wp-* symlink and reports each one', () => {
        const root = binDirWith({
            'wp-authorize': '../@webpieces/pr-gate/src/scripts/wp-authorize.js',
            'wp-check-auth': '../@webpieces/pr-gate/src/scripts/wp-check-auth.js',
            'wp-merge-start': '../@webpieces/pr-gate/src/scripts/wp-merge-start.js',
        });
        const removed = new StaleBinSweeper().sweep(root);
        expect(removed.map((r: StaleBinRemoval): string => r.name).sort())
            .toEqual(['wp-authorize', 'wp-check-auth', 'wp-merge-start']);
        expect(fs.readdirSync(new StaleBinSweeper().binDir(root))).toEqual([]);
    });

    // The prefix IS the safety story: another package's dangling bin is not ours to reap.
    it('never touches a non-wp-* entry, dangling or not', () => {
        const root = binDirWith({ 'tsc': '../typescript/bin/does-not-exist', 'nx': '../nx/bin/gone.js' });
        expect(new StaleBinSweeper().sweep(root)).toEqual([]);
        expect(fs.readdirSync(new StaleBinSweeper().binDir(root)).sort()).toEqual(['nx', 'tsc']);
    });

    /**
     * THE MOTIVATING SHAPE: a HARD RENAME, which is what makes this defect ongoing rather than historical.
     * A release renames a `wp-*` command with no alias; the next `pnpm install` adds the new link and
     * leaves the predecessor's, dangling. Measured on this repo's own 0.4.728 upgrade, in two separate
     * trees, during the session that wrote this file (PR #743 is the rename).
     *
     * The fixture uses a MADE-UP predecessor name, not the real one. `no-old-sync-main-name` forbids the
     * dead spelling in tracked source — correctly, and it blocked an earlier draft of this test — and the
     * test is better for it anyway: what is being asserted is that a renamed-away link goes and its
     * replacement stays, which must not depend on any particular retired name.
     */
    it('takes the renamed-away link and keeps the one that replaced it', () => {
        const root = binDirWith({});
        const bin = new StaleBinSweeper().binDir(root);
        fs.symlinkSync(realTarget(root, 'wp-sync-main.js'), path.join(bin, 'wp-sync-main'));
        fs.symlinkSync('../@webpieces/pr-gate/src/scripts/wp-old-name.js', path.join(bin, 'wp-old-name'));

        const removed = new StaleBinSweeper().sweep(root);
        expect(removed.map((r: StaleBinRemoval): string => r.name)).toEqual(['wp-old-name']);
        expect(fs.readdirSync(bin)).toEqual(['wp-sync-main']);
    });

    it('leaves a wp-* link whose target EXISTS strictly alone', () => {
        const root = binDirWith({});
        const target = realTarget(root, 'wp-build.js');
        fs.symlinkSync(target, path.join(new StaleBinSweeper().binDir(root), 'wp-build'));
        expect(new StaleBinSweeper().sweep(root)).toEqual([]);
        expect(fs.existsSync(path.join(new StaleBinSweeper().binDir(root), 'wp-build'))).toBe(true);
    });

    // A regular file named wp-something is not a stale link — it is somebody's script.
    it('ignores a wp-* entry that is a real file rather than a symlink', () => {
        const root = binDirWith({});
        fs.writeFileSync(path.join(new StaleBinSweeper().binDir(root), 'wp-local'), 'echo hi\n');
        expect(new StaleBinSweeper().sweep(root)).toEqual([]);
    });

    it('is a no-op with no node_modules/.bin at all — the linked-worktree case', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-stalebin-empty-'));
        expect(new StaleBinSweeper().sweep(root)).toEqual([]);
    });

    // This runs on EVERY wp-* command. Removing nothing has to be silent, or every command gains noise.
    it('reports nothing for an empty sweep, and names what went otherwise', () => {
        const sweeper = new StaleBinSweeper();
        expect(sweeper.report([])).toEqual([]);
        const lines = sweeper.report([new StaleBinRemoval('wp-gone', '../x/wp-gone.js')]);
        expect(lines[0]).toContain('removed 1 dangling');
        expect(lines.join('\n')).toContain('wp-gone -> ../x/wp-gone.js');
    });

    /**
     * A removal that FAILED must be stated, not lost. The removal is an `fs.rmSync`, so an unwritable `.bin`
     * (EACCES, a read-only mount) would otherwise heal silently-never while the tree kept advertising a
     * command that does not exist — the precise defect the sweep exists to remove.
     */
    it('states a failed removal separately, and never as a success', () => {
        const lines = new StaleBinSweeper().report([
            new StaleBinRemoval('wp-gone', '../x/wp-gone.js'),
            new StaleBinRemoval('wp-stuck', '../x/wp-stuck.js', 'EACCES: permission denied'),
        ]).join('\n');
        expect(lines).toContain('removed 1 dangling');
        expect(lines).toContain('could NOT be removed');
        expect(lines).toContain('wp-stuck -> ../x/wp-stuck.js (target missing; EACCES: permission denied)');
        // The one that DID go must not be counted among the failures, or the report reads as a total loss.
        expect(lines).not.toContain('wp-gone -> ../x/wp-gone.js (target missing; ');
    });

    // writeTemplate is called once per instruct-ai doc, several times per command; the report must not repeat.
    it('sweepOnce sweeps a root exactly once per process', () => {
        const root = binDirWith({ 'wp-authorize': '../gone.js' });
        const sweeper = new StaleBinSweeper();
        expect(sweeper.sweepOnce(root)).toHaveLength(1);
        expect(sweeper.sweepOnce(root)).toEqual([]);
    });
});

/**
 * THE LOAD-BEARING CALL SITE. The sweep only reaches every clone on every developer's machine because it
 * rides the pass every `wp-*` command takes — regenerating `.webpieces/instruct-ai/*`. A test that only
 * covered `StaleBinSweeper` directly would pass while the self-heal reached nobody.
 */
describe('TemplateWriter sweeps stale wp-* bins on the wp-* startup path', () => {
    it('removes a dangling wp-* symlink as a side effect of writeTemplate', () => {
        const root = binDirWith({ 'wp-authorize': '../@webpieces/pr-gate/src/scripts/wp-authorize.js' });
        const bin = new StaleBinSweeper().binDir(root);
        // A FRESH sweeper, not the shared singleton: the singleton's once-per-root memo is process-wide and
        // another spec in this process may already have swept.
        // An explicit instructDir keeps the docs inside the fixture, so this asserts the SWEEP and needs no
        // git repo to resolve `.webpieces` against.
        new TemplateWriter(undefined, undefined, undefined, new StaleBinSweeper())
            .writeTemplate(root, 'webpieces.git-workflow.md', 'instruct-out');
        expect(fs.existsSync(path.join(bin, 'wp-authorize'))).toBe(false);
    });
});
