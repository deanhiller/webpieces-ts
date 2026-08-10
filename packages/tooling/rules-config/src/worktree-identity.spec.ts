import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RepoRootFinder } from './repo-root';
import { DotWebpieces } from './state-dir';
import { WorktreeService } from './worktrees';

/**
 * TWO named questions, and this file is what stops them being "helpfully" collapsed into one. Real git
 * worktrees, no mocks: the drift it pins down only shows up against git's actual answers.
 *
 *   • GIT / TREE ROOT — "which checkout am I standing in?" Per-worktree. `webpieces.config.json` is the
 *     legitimate anchor here BECAUSE it is TRACKED IN GIT and therefore part of the BRANCH: a branch may
 *     change its own rules and that must keep working. So `RepoRootFinder.resolveRepoRoot` answering
 *     with the WORKTREE is correct, and stays that way.
 *   • GOVERNING ROOT — "where does `.webpieces` state live so it OUTLIVES the worktree?" Always the
 *     PRIMARY clone: `DotWebpieces.shared()` → `<primary>/.webpieces`, `DotWebpieces.local()` →
 *     `<primary>/.webpieces/worktrees/<name>`, which is still inside the primary and so survives the
 *     worktree being reaped.
 *
 * state-dir.ts's own header carries the full argument for both, including why `--git-dir` /
 * `--git-common-dir` is the authority for identity rather than `WorktreeService` (a repo-wide
 * enumeration that fails SOFT to `[]` on the hook's blocking path) or the config walk-up (which
 * deliberately climbs PAST a nested clone's `.git` — see repo-root.spec.ts — and would therefore hand
 * the guards someone else's repo).
 *
 * `EffectiveTreeResolver.classify` (ai-hook-rules) consumes the identity primitive proved here.
 */

function gitIn(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-b', 'main');
    gitIn(dir, 'config', 'core.hooksPath', '/dev/null');
    gitIn(dir, 'config', 'user.email', 'test@example.com');
    gitIn(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
}

let primary: string;
let inRepoWorktree: string;
let siblingWorktree: string;
let nestedClone: string;

beforeAll(() => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-identity-')));
    primary = path.join(home, 'primary');
    initRepo(primary);
    fs.writeFileSync(path.join(primary, 'webpieces.config.json'), '{}');
    // The layout Claude Code creates for an agent: a linked worktree INSIDE the governed root.
    inRepoWorktree = path.join(primary, '.claude', 'worktrees', 'agent-a9d8eab30bdce959d');
    gitIn(primary, 'worktree', 'add', inRepoWorktree, '-b', 'agent-branch');
    // The layout a human creates by hand: a sibling directory outside the repo.
    siblingWorktree = path.join(home, 'wt-feature');
    gitIn(primary, 'worktree', 'add', siblingWorktree, '-b', 'feature-x');
    nestedClone = path.join(primary, 'repositories', 'vendored');
    initRepo(nestedClone);
});

// The authoritative answer to "is this a LINKED worktree", from git's own canonical test.
function gitSaysLinked(dir: string): boolean {
    const dirs = new DotWebpieces().gitDirs(dir);
    return dirs !== null && dirs.isLinkedWorktree;
}

describe('tree identity is decided by the git dirs, and placement has no say in it', () => {

    it('every checkout of ONE repo shares a common dir — in-repo worktree, sibling worktree, primary', () => {
        const dot = new DotWebpieces();
        const common = (dir: string): string => path.resolve(dot.gitDirs(dir)?.commonDir ?? '');
        expect(common(inRepoWorktree)).toBe(common(primary));
        expect(common(siblingWorktree)).toBe(common(primary));
    });

    it('a nested clone has a DIFFERENT common dir — which is what keeps `foreign` reachable for it', () => {
        const dot = new DotWebpieces();
        expect(dot.gitDirs(nestedClone)?.commonDir).not.toBe(dot.gitDirs(primary)?.commonDir);
    });

    it('`gitDir !== commonDir` separates linked from primary, wherever the worktree sits', () => {
        expect(gitSaysLinked(inRepoWorktree)).toBe(true);
        expect(gitSaysLinked(siblingWorktree)).toBe(true);
        expect(gitSaysLinked(primary)).toBe(false);
        expect(gitSaysLinked(nestedClone)).toBe(false);
    });

    it('treeRoot answers with the WORKTREE\'s own root, from a subdirectory of it', () => {
        const sub = path.join(inRepoWorktree, 'packages');
        fs.mkdirSync(sub, { recursive: true });
        expect(new DotWebpieces().treeRoot(sub)).toBe(inRepoWorktree);
        expect(new DotWebpieces().treeRoot(primary)).toBe(primary);
    });
});

/**
 * The agreement test the drift risk actually needs. `WorktreeService.isLinkedWorktree` is a single
 * statSync of `.git` (FILE vs DIRECTORY) — a CHEAP FAST PATH kept for the read path, not a second
 * authority. If git ever changes that layout, this fails HERE rather than in the field, and it is
 * asserted for all three placements at once because a fast path checked only in the case someone
 * happened to think of is exactly how these drift apart.
 */
describe('isLinkedWorktree — the statSync fast path AGREES with `gitDir !== commonDir`', () => {
    const service = (): WorktreeService => new WorktreeService();

    it('agrees for the primary clone (.git is a DIRECTORY)', () => {
        expect(service().isLinkedWorktree(primary)).toBe(gitSaysLinked(primary));
        expect(service().isLinkedWorktree(primary)).toBe(false);
    });

    it('agrees for an IN-REPO `.claude/worktrees/**` worktree (.git is a FILE)', () => {
        expect(service().isLinkedWorktree(inRepoWorktree)).toBe(gitSaysLinked(inRepoWorktree));
        expect(service().isLinkedWorktree(inRepoWorktree)).toBe(true);
    });

    it('agrees for a SIBLING worktree outside the repo', () => {
        expect(service().isLinkedWorktree(siblingWorktree)).toBe(gitSaysLinked(siblingWorktree));
        expect(service().isLinkedWorktree(siblingWorktree)).toBe(true);
    });

    it('agrees for a nested clone: not a linked worktree by either answer', () => {
        expect(service().isLinkedWorktree(nestedClone)).toBe(gitSaysLinked(nestedClone));
        expect(service().isLinkedWorktree(nestedClone)).toBe(false);
    });
});

/**
 * The two questions keep their two DIFFERENT answers. This half must not be unified either — a worktree
 * with its own checked-out config governs itself, while its `.webpieces` state stays in the primary.
 */
describe('git root vs governing root — deliberately different answers', () => {

    it('a worktree carrying its own webpieces.config.json resolves to ITSELF (branch-scoped rules)', () => {
        fs.writeFileSync(path.join(inRepoWorktree, 'webpieces.config.json'), '{}');
        expect(new RepoRootFinder().resolveRepoRoot(inRepoWorktree)).toBe(inRepoWorktree);
    });

    it('…while its `.webpieces` state lives under the PRIMARY, so it outlives the worktree', () => {
        const dot = new DotWebpieces();
        expect(dot.shared(inRepoWorktree)).toBe(path.join(primary, '.webpieces'));
        expect(dot.local(inRepoWorktree).startsWith(path.join(primary, '.webpieces'))).toBe(true);
        expect(dot.primaryRoot(inRepoWorktree)).toBe(primary);
    });

    it('config walk-up climbs PAST a nested clone — right for governance, fatal for identity', () => {
        expect(new RepoRootFinder().resolveRepoRoot(nestedClone)).toBe(primary);
        expect(gitSaysLinked(nestedClone)).toBe(false);
    });
});
