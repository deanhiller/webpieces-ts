import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

/**
 * What `git rev-parse --abbrev-ref HEAD` prints on a detached HEAD, and therefore what
 * `GitCheckout.branch()` returns there. Callers that treat a detached HEAD as "no branch" compare against
 * this rather than spelling the literal again.
 */
export const DETACHED_HEAD = 'HEAD';

/**
 * The three location answers for one directory — what `git rev-parse --git-dir --git-common-dir
 * --show-toplevel` prints, read from the filesystem instead. Data only (CLAUDE.md rule 1).
 *
 * `gitDir` is the PER-WORKTREE git dir (`<primary>/.git/worktrees/<name>` in a linked worktree,
 * `<primary>/.git` in the primary clone); `commonDir` is the SHARED one; `toplevel` is the working tree
 * root. Each is absolute with symlinks resolved (as git prints them), or null when there is no answer:
 * all three for a directory outside any repository, only `toplevel` inside a `.git` directory or a bare
 * repository (git has no work tree there). `gitDir` and `commonDir` are null together.
 */
export class GitCheckoutFacts {
    readonly gitDir: string | null;
    readonly commonDir: string | null;
    readonly toplevel: string | null;

    constructor(gitDir: string | null, commonDir: string | null, toplevel: string | null) {
        this.gitDir = gitDir;
        this.commonDir = commonDir;
        this.toplevel = toplevel;
    }

    /** git's own test: a LINKED worktree is exactly the checkout whose git dir is not the common dir. */
    get isLinkedWorktree(): boolean {
        if (this.gitDir === null || this.commonDir === null) return false;
        return path.resolve(this.gitDir) !== path.resolve(this.commonDir);
    }
}

const NOT_A_REPOSITORY = new GitCheckoutFacts(null, null, null);

// THE process-wide answer table, at MODULE scope on purpose (#1355). It used to live on each resolver
// INSTANCE, and every caller built its own — DotWebpieces had a DI singleton AND a module-level `const`,
// the guards each spawned their own `git rev-parse --abbrev-ref HEAD` — so one guard-hook invocation ran
// 14-15 `git` processes to answer 5 questions. A module-scope table is shared by every instance that can
// ever exist in the process, so no future `new GitCheckout()` can reintroduce a private cache.
const factsByDir = new Map<string, GitCheckoutFacts>();

// `gitdir: <path>` — the one line of a `.git` FILE (a linked worktree, a submodule).
const GITDIR_POINTER = /^gitdir:\s*(.+)$/;
// `ref: refs/heads/<branch>` — HEAD naming a local branch.
const SYMBOLIC_BRANCH = /^ref:\s*refs\/heads\/(.+)$/;
// `ref: <other ref>` — HEAD naming something that is not a local branch.
const SYMBOLIC_OTHER = /^ref:\s*refs\/(?:remotes\/|tags\/)?(.+)$/;
// A raw object id (sha1 or sha256): a detached HEAD.
const DETACHED_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// The placeholder HEAD a reftable repository keeps on disk; the real HEAD lives in the reftable.
const REFTABLE_PLACEHOLDER = '.invalid';

/**
 * THE ONE resolver for "where is this checkout and what is checked out in it" — branch, git dir, common
 * git dir and working-tree root. Every webpieces caller asks here (#1355).
 *
 * ─── Cost: ZERO processes ──────────────────────────────────────────────────────────────────────────
 * The guard hook runs on EVERY tool call, so git work belongs in the async refresher, never on this
 * path. Everything here is a filesystem read, done the way git's own discovery does it:
 *   • walk UP from the directory; at each level a `.git` DIRECTORY is the git dir AND common dir (the
 *     primary clone), a `.git` FILE holds `gitdir: <path>` (a linked worktree or a submodule) whose
 *     `commondir` file, relative to that git dir, names the shared one; and a level that IS a git dir
 *     (inside `.git`, a bare repository) answers the two dirs and no toplevel;
 *   • the branch is read from `<gitDir>/HEAD` on every call — never memoized, so a long-running `wp-*`
 *     command that checks out another branch sees the new one.
 * The locations are memoized process-wide (see `factsByDir`), and filed under the toplevel too.
 *
 * ─── Semantics, kept from the `git rev-parse` calls this replaced ─────────────────────────────────
 *   • a detached HEAD answers DETACHED_HEAD (`HEAD`), as `--abbrev-ref` printed;
 *   • a linked worktree reads ITS OWN HEAD (it lives in the per-worktree git dir);
 *   • a directory outside any repository answers null everywhere;
 *   • an UNBORN branch answers its NAME, as `git branch --show-current` does;
 *   • HEAD naming a non-branch ref answers its short name, as `--abbrev-ref` did (`origin/x`).
 * Not modelled, because no webpieces checkout uses them: `GIT_DIR` / `GIT_WORK_TREE` / ceiling
 * environment overrides, `core.worktree`, and a REFTABLE repository's HEAD (it answers null — "cannot
 * say" — which every caller already treats as fail-open or a readable refusal).
 */
@injectable(bindingScopeValues.Singleton)
export class GitCheckout {
    /** The three location answers for `startDir`, memoized for the life of the process. */
    facts(startDir: string): GitCheckoutFacts {
        const dir = path.resolve(startDir);
        const cached = factsByDir.get(dir);
        if (cached !== undefined) return cached;
        // `git -C <missing dir>` fails, so a directory that does not exist is in no repository. Not
        // memoized: a worktree being created later in the same process must then be found.
        if (!this.isDirectory(dir)) return NOT_A_REPOSITORY;

        const facts = this.discover(this.real(dir));
        factsByDir.set(dir, facts);
        if (facts.toplevel !== null && !factsByDir.has(facts.toplevel)) factsByDir.set(facts.toplevel, facts);
        return facts;
    }

    /**
     * The branch checked out in `startDir`'s worktree: its name, DETACHED_HEAD on a detached HEAD, or null
     * when `startDir` is not in a repository or its HEAD cannot be read. Read fresh on every call.
     */
    branch(startDir: string): string | null {
        const gitDir = this.facts(startDir).gitDir;
        if (gitDir === null) return null;
        const head = this.readLine(path.join(gitDir, 'HEAD'));
        if (head === null) return null;
        const branch = SYMBOLIC_BRANCH.exec(head);
        if (branch) return branch[1] === REFTABLE_PLACEHOLDER ? null : branch[1];
        if (DETACHED_SHA.test(head)) return DETACHED_HEAD;
        const other = SYMBOLIC_OTHER.exec(head);
        return other ? other[1] : null;
    }

    /**
     * `branch()` for a caller that cannot proceed without one: the same answer, or an InformAiError naming
     * the directory when there is none — what the `execSync` this replaced threw, made readable.
     */
    requireBranch(startDir: string): string {
        const branch = this.branch(startDir);
        if (branch !== null) return branch;
        throw new InformAiError(
            `Failed to determine the current git branch in ${startDir}: it is not inside a git repository, or its HEAD cannot be read. Run the command from inside the repository's checkout.`,
        );
    }

    /** True when `startDir` sits in a LINKED worktree rather than the primary clone. */
    isLinkedWorktree(startDir: string): boolean {
        return this.facts(startDir).isLinkedWorktree;
    }

    // git's discovery order at each level: the `.git` entry first, then "is this directory itself a git
    // dir", then the parent — until the filesystem root, which means "not a repository".
    private discover(dir: string): GitCheckoutFacts {
        let current = dir;
        for (;;) {
            const dotGit = path.join(current, '.git');
            if (this.isDirectory(dotGit)) return new GitCheckoutFacts(dotGit, this.commonDirOf(dotGit), current);
            if (this.isFile(dotGit)) return this.fromPointer(dotGit, current);
            if (this.isGitDir(current)) return new GitCheckoutFacts(current, this.commonDirOf(current), null);
            const parent = path.dirname(current);
            if (parent === current) return NOT_A_REPOSITORY;
            current = parent;
        }
    }

    // A `.git` FILE: `gitdir: <path>`, relative to the directory holding the file. A pointer to nowhere is
    // what git calls "not a git repository", so it answers exactly that.
    private fromPointer(dotGitFile: string, toplevel: string): GitCheckoutFacts {
        const line = this.readLine(dotGitFile);
        const pointer = line === null ? null : GITDIR_POINTER.exec(line);
        if (pointer === null) return NOT_A_REPOSITORY;
        const gitDir = path.resolve(toplevel, pointer[1].trim());
        if (!this.isDirectory(gitDir)) return NOT_A_REPOSITORY;
        const real = this.real(gitDir);
        return new GitCheckoutFacts(real, this.commonDirOf(real), toplevel);
    }

    // `<gitDir>/commondir` names the shared git dir (relative to gitDir); without it, gitDir IS shared.
    private commonDirOf(gitDir: string): string {
        const line = this.readLine(path.join(gitDir, 'commondir'));
        if (line === null || line === '') return gitDir;
        return this.real(path.resolve(gitDir, line));
    }

    // The same test git applies before treating a directory as a git dir: a HEAD, and objects of its own
    // or a pointer to the shared ones.
    private isGitDir(dir: string): boolean {
        if (!this.isFile(path.join(dir, 'HEAD'))) return false;
        return this.isDirectory(path.join(dir, 'objects')) || this.isFile(path.join(dir, 'commondir'));
    }

    private isDirectory(file: string): boolean {
        const stats = this.stat(file);
        return stats !== null && stats.isDirectory();
    }

    private isFile(file: string): boolean {
        const stats = this.stat(file);
        return stats !== null && stats.isFile();
    }

    private stat(file: string): fs.Stats | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(file);
        } catch (err: unknown) { // webpieces-disable catch-must-propagate -- a missing entry is the ordinary "not here, look further up" answer of the discovery walk
            const error = toError(err);
            void error;
            return null;
        }
    }

    // The first line of a small git bookkeeping file, trimmed, or null when it cannot be read.
    private readLine(file: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readFileSync(file, 'utf8').split('\n')[0].trim();
        } catch (err: unknown) { // webpieces-disable catch-must-propagate -- an unreadable HEAD/commondir/pointer is the documented "cannot say" answer, which callers fail open on
            const error = toError(err);
            void error;
            return null;
        }
    }

    // Symlinks resolved, as git prints its paths (`/var` → `/private/var` on macOS); unresolvable → as given.
    private real(dir: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.realpathSync(dir);
        } catch (err: unknown) { // webpieces-disable catch-must-propagate -- a directory that does not exist (yet) is discovered from its literal path, as git's -C would fail on it
            const error = toError(err);
            void error;
            return dir;
        }
    }
}

// The process-wide instance for the non-DI call sites. Any other instance shares its table (above).
export const gitCheckout = new GitCheckout();
