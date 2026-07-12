import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RepoRootFinder } from './repo-root';

// core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repos.
function git(cwd: string, cmd: string): string {
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

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
        // realpathSync: macOS os.tmpdir() is a symlink; git rev-parse returns the real path, so we
        // must compare against the resolved path.
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-')));
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
        git(nested, 'init -q -b main');
        expect(git(nested, 'rev-parse --show-toplevel')).toBe(nested); // sanity: git-toplevel IS the nested root
        expect(finder.resolveRepoRoot(nested)).toBe(root);             // …but resolveRepoRoot climbs past it
    });

    it('falls back to git toplevel when there is no webpieces.config.json anywhere above', () => {
        git(root, 'init -q -b main');
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
