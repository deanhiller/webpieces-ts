import { isWebpiecesStateDir } from './exclude-hook-paths';

/**
 * `.webpieces/` — the tooling's OWN gitignored state dir — is exempt from every hook guard
 * UNCONDITIONALLY, not by config. This is the predicate that decides it; `filterByExcludedPaths` calls
 * it ahead of the `excludePaths` list precisely so no consumer config can put the directory back under
 * governance, and so a repo whose `excludePaths` key already exists (which the installer never
 * rewrites) is repaired by upgrading the pin alone.
 *
 * The first-segment test is deliberate rather than a glob. The repo's own glob matcher compiles
 * `.webpieces/**` to an ANCHORED `/^\.webpieces\/.*$/`, which does NOT match the BARE directory
 * `.webpieces` — the exact value the Bash path passes after a `cd .webpieces`. A predicate that split
 * on '/' has no such gap, which is why the skip is code and not a seeded glob.
 */
describe('isWebpiecesStateDir', () => {
    it('matches the bare state directory', () => {
        expect(isWebpiecesStateDir('.webpieces')).toBe(true);
    });

    it('matches anything under it, at any depth', () => {
        expect(isWebpiecesStateDir('.webpieces/tasks.md')).toBe(true);
        expect(isWebpiecesStateDir('.webpieces/worktrees/agent-abc/pr-review/f/review-1.json')).toBe(true);
    });

    it('matches the Windows-separator spelling of the same path', () => {
        expect(isWebpiecesStateDir('.webpieces\\logs\\hook.log')).toBe(true);
    });

    it('does NOT match the repo root (the Bash path with no leading cd)', () => {
        expect(isWebpiecesStateDir('')).toBe(false);
    });

    it('does NOT match a path that escapes the workspace', () => {
        expect(isWebpiecesStateDir('../.webpieces/tasks.md')).toBe(false);
    });

    it('does NOT match a nested .webpieces owned by something else', () => {
        expect(isWebpiecesStateDir('packages/foo/.webpieces/x')).toBe(false);
    });

    it('does NOT match a sibling whose name merely starts the same way', () => {
        expect(isWebpiecesStateDir('.webpieces-notes/x')).toBe(false);
        expect(isWebpiecesStateDir('.webpiecesrc')).toBe(false);
    });
});
