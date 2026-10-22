import { checkoutLayout, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DotWebpieces } from '@webpieces/tooling-common';

import { RepoRootFinder } from './repo-root';

// Checkouts are laid out on disk exactly as git lays them out (checkoutLayout) — no git process (#1381).

function writeFile(root: string, relPath: string, content: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/**
 * `.webpieces/` MUST live at the ONE repo root, never in a CWD-dependent subdir. RepoRootFinder is the
 * single anchor every `.webpieces` writer resolves through; these pin the resolution order that keeps
 * a tool invoked from a subdirectory (or a nested/embedded git clone) from scattering a stray tree.
 */
describe('RepoRootFinder.resolveRepoRoot', () => {
    let root: string;
    const finder = new RepoRootFinder();

    beforeEach(() => {
        // realpathSync: macOS os.tmpdir() is a symlink; the git-dir resolver reports the real path, so
        // we must compare against the resolved path.
        root = specTempDirs.makeReal('repo-root-');
    });

    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('walks UP for webpieces.config.json — a subdir resolves to the config dir (not the subdir)', () => {
        writeFile(root, 'webpieces.config.json', '{}\n');
        const subdir = path.join(root, 'libraries', 'node', 'server-auth');
        fs.mkdirSync(subdir, { recursive: true });
        expect(finder.resolveRepoRoot(subdir)).toBe(root);
    });

    it('anchors a NESTED git clone (no own config) at the OUTER webpieces root, not the nested root', () => {
        // The exact scatter scenario: an embedded clone under the monorepo. config-walk-up must cross
        // the nested .git boundary and land on the outer webpieces.config.json — so a tool run from
        // inside the clone still writes `.webpieces` at the outer root.
        writeFile(root, 'webpieces.config.json', '{}\n');
        const nested = path.join(root, 'repositories', 'some-clone');
        fs.mkdirSync(nested, { recursive: true });
        checkoutLayout.primary(nested, 'main');
        expect(new DotWebpieces().treeRoot(nested)).toBe(nested); // sanity: git-toplevel IS the nested root
        expect(finder.resolveRepoRoot(nested)).toBe(root);        // …but resolveRepoRoot climbs past it
    });

    it('falls back to git toplevel when there is no webpieces.config.json anywhere above', () => {
        checkoutLayout.primary(root, 'main');
        const subdir = path.join(root, 'src', 'deep');
        fs.mkdirSync(subdir, { recursive: true });
        expect(finder.resolveRepoRoot(subdir)).toBe(root);
    });

    it('last-resort: returns startDir when neither a config nor a git repo is found', () => {
        const subdir = path.join(root, 'plain');
        fs.mkdirSync(subdir, { recursive: true });
        // `root` itself is a bare temp dir (no config, not a git repo) → best-effort startDir.
        expect(finder.resolveRepoRoot(subdir)).toBe(subdir);
    });
});
