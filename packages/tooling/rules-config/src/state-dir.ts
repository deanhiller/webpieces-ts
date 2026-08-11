import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { PR_REVIEW_DIR, WEBPIECES_TMP_DIR } from './constants';
import { StateDirMigrator } from './state-dir-migration';

// The per-worktree namespace inside the primary clone's `.webpieces/`. A LINKED worktree's local state
// lives at `<primary>/.webpieces/worktrees/<worktreeName>/`; the primary clone keeps using
// `<primary>/.webpieces/` directly, exactly as it always has.
export const WORKTREE_STATE_DIR = 'worktrees';

// The ONE and ONLY directory webpieces writes observability state into — `<state>/logs/`, for the
// primary clone and for each worktree namespace alike. There is no second state directory and no
// split: the L1 binary's logs, the L0 sh shim's log, and the rejection DETAIL files (which are not
// `.log`s but belong to the log that indexes them) are all here.
//
// It used to be two directories — `hooks/`, holding the binary's logs mixed in with dated
// `hooks/<YYYY-MM-DD>/writeInfo-*.md` rejection details, and `logs/`, where the sh shim wrote — so
// "where are the logs?" had two answers and neither was complete. `hooks/` is gone entirely; nothing
// reads or writes it.
//
// Every writer resolves its DIRECTORY through dotWebpieces.logs()/logsFile(), so the layout cannot
// drift apart again. What sits INSIDE it is ai-hook-rules' business (see its log-streams.ts and
// LogStream): one directory per LAYER, and inside that one file per WRITER, named
// <sessionId>-<agentId|coordinator>-<hook>.log — because Claude Code runs all matching PreToolUse
// hooks IN PARALLEL and subagents/windows share a tree, so writers must never share a file.
export const LOGS_STATE_DIR = 'logs';

// The leaves of `.webpieces/` that resolve through `aiWritable()` and therefore live in the WORKTREE's
// own root rather than in the primary clone's namespace. Named here because TWO things must agree about
// them: `aiWritable()`, which puts them there, and `StateDirMigrator`, which must NOT sweep them out
// again (its whole job is draining `<worktree>/.webpieces` into the namespace, and these are the one
// part of that directory that is live rather than legacy).
export const AI_WRITABLE_STATE_DIRS: readonly string[] = [PR_REVIEW_DIR];


// git prints the shared git dir as `<primary>/.git` for a conventional clone. Anything else (a bare
// repo, `--separate-git-dir`) is a layout we decline to derive a working tree from.
const GIT_DIR_NAME = '.git';

/**
 * Data-only carrier for the two paths git is asked for. Per CLAUDE.md: classes for data.
 *
 * `gitDir` is the PER-WORKTREE git dir (`<primary>/.git/worktrees/<name>` in a linked worktree,
 * `<primary>/.git` in the primary clone). `commonDir` is the SHARED one — always `<primary>/.git`.
 * They differ if and only if this is a linked worktree; that is git's own canonical test.
 */
export class GitDirs {
    readonly gitDir: string;
    readonly commonDir: string;

    constructor(gitDir: string, commonDir: string) {
        this.gitDir = gitDir;
        this.commonDir = commonDir;
    }

    get isLinkedWorktree(): boolean {
        return path.resolve(this.gitDir) !== path.resolve(this.commonDir);
    }
}

/**
 * WHERE a piece of `.webpieces/` state belongs — the ONE resolver every reader and writer must go
 * through, with THREE named methods because there are exactly three answers and a call site must DECLARE
 * which one it means.
 *
 *   dotWebpieces.shared(dir)     → <primary>/.webpieces                    (repo-wide facts)
 *   dotWebpieces.local(dir)      → <primary>/.webpieces/worktrees/<name>   (this worktree only, tooling-written)
 *                                → <primary>/.webpieces                    (…in the primary clone)
 *   dotWebpieces.aiWritable(dir) → <worktree>/.webpieces                   (this worktree only, AI-WRITTEN)
 *                                → <primary>/.webpieces                    (…in the primary clone)
 *
 * ─── The bug ───────────────────────────────────────────────────────────────────────────────────────
 * `.webpieces/` is gitignored, and it was anchored at the directory holding webpieces.config.json —
 * which in a linked worktree is the WORKTREE. So a repo with seven worktrees had SEVEN independent
 * copies of files that describe the WHOLE REPO. `merged-branches.json` holds verdicts for every branch
 * AND every worktree in the repo; N copies is N divergent truths, and the guards read them as fact.
 * Observed in the field: branch-creation-guard asserted "8 parked local branches" while
 * `git branch --list` showed ONE — it was reading a cache written before deletions performed from a
 * DIFFERENT worktree — and it then blocked a legitimate `git worktree add` on that fiction.
 *
 * ─── Why two explicit methods and not a symlink ────────────────────────────────────────────────────
 * A `<worktree>/.webpieces` → `<primary>/…/worktrees/<name>` symlink would have left every call site
 * untouched, which is seductive and wrong. Nothing hooks `git worktree add`, so the link needs LAZY
 * creation that also has to handle "link already exists", "link points somewhere else", and "a real
 * directory is already there" — invisible filesystem magic with a Windows failure mode. Worse, the safe
 * way to write a shared file under concurrency is temp-file-then-`rename()`, and `rename(2)` acts on
 * the PATH, not the link: it REPLACES a symlink with a real file. That silently works for one writer
 * and diverges for everyone else — the exact bug being fixed, but invisible. An explicit call is
 * greppable, testable, and forces each site to say which scope it means.
 *
 * ─── Which scope is which (the scope assignment is deliberate, not incidental) ─────────────────────
 * shared():
 *   • merged-branches.json — verdicts for every branch and worktree in the repo. Atomically written.
 *   • main-sync-status.json AND main-sync.lock.json — there is one `main` and one `.git`, so there is
 *     one refresher. A lock inside a per-worktree directory locks nothing.
 * local():
 *   • logs/*.log, INCLUDING branch-mutations.log. A shared append-only log genuinely corrupts:
 *     `O_APPEND` writes are indivisible only under PIPE_BUF, which is 512 bytes on macOS, and a
 *     `recover=git worktree add -b <branch> <abs-path> <tag>` line with real paths exceeds that. A
 *     per-worktree log has exactly ONE writer and cannot tear, and under this layout it already
 *     survives the worktree's deletion — recovery is one glob over
 *     `<primary>/.webpieces/worktrees/＊/logs/branch-mutations.log`.
 *   • merge-info/staged|merged/<branch>/ and its index.json, instruct-ai/, and every other per-tree
 *     scratch file that the TOOLING writes.
 * aiWritable():
 *   • pr-review/<branch>/ — and ONLY that, today. See the section below.
 *
 * ─── Why aiWritable() is a third scope and not a spelling of local() ──────────────────────────────
 * `pr-review/<branch>/` is the one state directory a CODING AGENT writes into with its own file-write
 * tool: `review.json` is authored by the agent running the flow, and `review-<id>.json` by each reviewer
 * subagent. A worktree-isolated agent may write ONLY inside its own worktree — its harness refuses any
 * Write/Edit whose path is under the shared checkout, with "This agent is isolated in the worktree …;
 * edit the worktree copy of this file instead". That refusal is not ours to relax.
 *
 * So `local()` — correct for everything the tooling writes — is UNREACHABLE for the two files the flow
 * asks an agent to write. Stage ② printed a `<primary>/.webpieces/worktrees/<name>/pr-review/…` path,
 * the agent's Write was refused at exactly that path, and the only way through was `cp`/`>` from Bash
 * (which is NOT blocked, so the refusal looks arbitrary rather than structural). Three separate agents
 * hit it, each concluded the tooling was printing a path it did not use, and each invented its own
 * workaround. Worse, the same refusal lands on every reviewer subagent's `review-<id>.json`, and
 * `wp-finish-upsert-pr` REFUSES the PR while a required checklist has no verdict — so this was a
 * correctness bug, not an ergonomics one.
 *
 * The invariant, stated once: ANY `.webpieces/` path an AI AGENT is instructed to WRITE must resolve
 * inside that agent's own working tree. `aiWritable()` is that rule, made greppable. Do not add a
 * fourth scope; do not route a tooling-written file through this one.
 *
 * What it costs is what `local()` bought: a `pr-review/` under the worktree dies with the worktree.
 * That is the right trade for THIS directory and only this one — a review is spent the moment the PR is
 * posted, and `pnpm wp-review-upsert-pr` regenerates the whole directory from git in one run. An
 * in-flight `merge-info/staged/<branch>/` is not regenerable, which is exactly why it stays on local().
 *
 * ─── The boundary that must not be blurred ─────────────────────────────────────────────────────────
 * ONLY the gitignored `.webpieces/` STATE relocates. `webpieces.config.json` is TRACKED IN GIT and is
 * therefore part of the BRANCH: a branch may legitimately change its own rules and that must keep
 * working. Config resolution is untouched — still per-worktree, via findConfigFile /
 * RepoRootFinder.resolveRepoRoot. Nothing in this class reads or moves config.
 *
 * ─── Why `--git-dir` / `--git-common-dir`, and not one of the existing services ────────────────────
 * They are git's own answers, from any subdirectory, in one cheap local call, with no `.git`-file
 * parsing by hand (which gets `--separate-git-dir` and submodules wrong). Two existing mechanisms do
 * distinguish primary from linked, and neither is the right authority here:
 *   • `WorktreeService` answers "what worktrees exist and what do they hold" — a repo-wide ENUMERATION
 *     (`git worktree list --porcelain`) for the caps and the reaper. Using it for a path lookup would
 *     run an enumeration on the hook's blocking path for every state access, and it fails SOFT to `[]`,
 *     which here would read as "there is no primary clone" on exactly the degraded repo where the
 *     answer matters most. It also does not expose the worktree's git NAME, which is the namespace key.
 *   • `EffectiveTreeResolver` (#524) answers "which tree does this COMMAND act on" — it takes a command
 *     string and is a policy input to the bash guards, not a filesystem-path resolver.
 * Both remain authoritative for their own questions. This asks the narrowest one — two path strings —
 * and lives in rules-config, UNDER both, which is where a primitive that pr-gate, ai-hook-rules and
 * code-rules all need has to sit.
 *
 * Fails CLOSED to the pre-change behaviour: when git cannot answer, every path here collapses to
 * `<startDir-root>/.webpieces` exactly as before. Degrading to merely-suboptimal beats throwing on a
 * hook's blocking path.
 */
@injectable(bindingScopeValues.Singleton)
export class DotWebpieces {
    // treeRoot → git's answer. One `git rev-parse` pair per root per process; every later path lookup
    // in that invocation is a Map hit.
    private readonly gitDirsByRoot = new Map<string, GitDirs | null>();
    // startDir → `git rev-parse --show-toplevel`, cached on the same terms as gitDirsByRoot.
    private readonly treeRootByDir = new Map<string, string | null>();
    // Roots whose legacy per-worktree `.webpieces/` has already been considered for migration.
    private readonly migrated = new Set<string>();

    constructor(private readonly migrator: StateDirMigrator = new StateDirMigrator()) {}

    /**
     * REPO-WIDE state: `<primary>/.webpieces`. Use ONLY for facts about the repo rather than about one
     * worktree — today that is merged-branches.json and the main-sync status + lock. Identical from
     * every worktree, and never behind an indirection, so an atomic `rename()` into it is safe.
     */
    shared(startDir: string): string {
        return path.join(this.primaryRoot(startDir), WEBPIECES_TMP_DIR);
    }

    /** A path beneath the repo-wide state dir. */
    sharedFile(startDir: string, ...segments: string[]): string {
        return path.join(this.shared(startDir), ...segments);
    }

    /**
     * THIS WORKTREE's private state: `<primary>/.webpieces/worktrees/<name>` for a linked worktree, and
     * `<primary>/.webpieces` for the primary clone, which keeps its state exactly where it has always
     * been. Fully isolated — two worktrees never write the same path, so nothing here needs a lock.
     *
     * The first call for a linked worktree also MIGRATES a legacy real `<worktree>/.webpieces/`
     * directory into the namespace, so in-flight merge / pr-review state written under the old scheme
     * (or by an older PUBLISHED build during the transition) is picked up rather than orphaned.
     */
    local(startDir: string): string {
        const dirs = this.gitDirs(startDir);
        if (dirs === null || !dirs.isLinkedWorktree) return this.shared(startDir);

        const target = path.join(this.shared(startDir), WORKTREE_STATE_DIR, path.basename(dirs.gitDir));
        this.migrateOnce(startDir, target);
        return target;
    }

    /** A path beneath this worktree's private state dir. */
    localFile(startDir: string, ...segments: string[]): string {
        return path.join(this.local(startDir), ...segments);
    }

    /**
     * State an AI AGENT writes with its own file-write tool: `<worktree>/.webpieces` — the worktree's
     * OWN root, which is the only place a worktree-isolated agent is permitted to write. Identical to
     * `shared()`/`local()` in the primary clone, so nothing changes for a repo without worktrees.
     *
     * See the "Why aiWritable() is a third scope" section above before adding a call site: this is for
     * files the flow ASKS AN AGENT TO WRITE, not for tooling output that an agent merely reads.
     */
    aiWritable(startDir: string): string {
        const toplevel = this.treeRoot(startDir);
        // Fails CLOSED to shared() when git cannot answer, on the same terms as every other path here.
        if (toplevel === null) return this.shared(startDir);
        return path.join(toplevel, WEBPIECES_TMP_DIR);
    }

    /** A path beneath the AI-writable state dir. */
    aiWritableFile(startDir: string, ...segments: string[]): string {
        return path.join(this.aiWritable(startDir), ...segments);
    }

    /**
     * THE log directory — `<local()>/logs` — and the only place webpieces writes a `.log` or a log's
     * detail files, in the primary clone and in every worktree namespace alike.
     *
     * There is NO migration here, deliberately. A lazy once-per-process relocation of an older
     * release's `hooks/*.log` used to run on this path, and it was itself the defect it claimed to
     * cure: it only fires in the trees a process happens to re-enter, so it guarantees two answers to
     * "where are the logs" indefinitely rather than converging on one. New writes go to `logs/` and
     * nothing else; a stale `hooks/` left by an older release is inert and can be deleted by hand.
     */
    logs(startDir: string): string {
        return path.join(this.local(startDir), LOGS_STATE_DIR);
    }

    /** A path beneath the log directory — `dotWebpieces.logsFile(root, CALLS_STREAM, writerFile)`. */
    logsFile(startDir: string, ...segments: string[]): string {
        return path.join(this.logs(startDir), ...segments);
    }

    /** True when `startDir` sits in a LINKED worktree rather than the primary clone. */
    isLinkedWorktree(startDir: string): boolean {
        const dirs = this.gitDirs(startDir);
        return dirs !== null && dirs.isLinkedWorktree;
    }

    /**
     * git's two dir answers for `startDir`, memoized — null when it is not a git repo / git is
     * unavailable.
     *
     * PUBLIC because TREE IDENTITY is decided from these two strings and nothing else. `commonDir`
     * is the same for every checkout of ONE repo, so `commonDir(a) === commonDir(b)` is "same repo,
     * different placement" — the test that tells a linked worktree (ours, wherever it sits, including
     * inside the repo at `.claude/worktrees/**`) from a nested clone under `repositories/**` (not
     * ours). `gitDirs.isLinkedWorktree` then separates primary from linked. See
     * `EffectiveTreeResolver.classify`, the caller that runs this on the hook's blocking path, which is
     * why it goes through this cache rather than spawning its own `rev-parse`.
     */
    gitDirs(startDir: string): GitDirs | null {
        const cached = this.gitDirsByRoot.get(startDir);
        if (cached !== undefined) return cached;

        const gitDir = this.revParse(startDir, '--git-dir');
        const commonDir = this.revParse(startDir, '--git-common-dir');
        const dirs = gitDir === null || commonDir === null ? null : new GitDirs(gitDir, commonDir);
        this.gitDirsByRoot.set(startDir, dirs);
        return dirs;
    }

    /**
     * The WORKING TREE root containing `startDir` (`git rev-parse --show-toplevel`), memoized, or null
     * when `startDir` is not in a git repo. In a linked worktree this is the WORKTREE's own root, which
     * is exactly what a caller judging "which checkout am I standing in" needs.
     *
     * THE ONE tree-root resolver. There used to be three byte-identical `spawnSync … --show-toplevel`
     * copies — this one, `RepoRootFinder`'s and `effective-tree.ts`'s — each commenting that it
     * "mirrors" one of the others, and one of those comments was already stale. Both copies are deleted;
     * everything that needs a tree root calls this. Do not add a fourth.
     */
    treeRoot(startDir: string): string | null {
        const cached = this.treeRootByDir.get(startDir);
        if (cached !== undefined) return cached;
        // `status !== 0` IS the expected "not a repo" answer (spawnSync does not throw on a non-zero
        // exit), so nothing here swallows a real git crash.
        const root = this.revParse(startDir, '--show-toplevel');
        this.treeRootByDir.set(startDir, root);
        return root;
    }

    /**
     * git's own name for this linked worktree — the basename of `<primary>/.git/worktrees/<name>`, and
     * the namespace key under `worktrees/`. Empty for the primary clone. git's name rather than the
     * directory's basename, so two worktrees checked out into same-named directories under different
     * parents cannot collide.
     */
    worktreeName(startDir: string): string {
        const dirs = this.gitDirs(startDir);
        if (dirs === null || !dirs.isLinkedWorktree) return '';
        return path.basename(dirs.gitDir);
    }

    /** The primary clone's root, from any worktree. Falls back to git's toplevel-less best guess. */
    primaryRoot(startDir: string): string {
        const dirs = this.gitDirs(startDir);
        if (dirs === null) return startDir;
        if (path.basename(dirs.commonDir) !== GIT_DIR_NAME) return startDir;
        const primary = path.dirname(dirs.commonDir);
        return fs.existsSync(primary) ? primary : startDir;
    }

    /**
     * The PRE-change location, `<treeRoot>/.webpieces` — what every call site used to compute. Public
     * because the migrator and its specs must be able to name the thing being migrated FROM, and
     * because the transition-window fallback readers need it.
     */
    legacyDir(treeRoot: string): string {
        return path.join(treeRoot, WEBPIECES_TMP_DIR);
    }

    // Drain a legacy per-worktree `.webpieces/` into this worktree's namespace, at most once per tree
    // per process. Migration is idempotent, but it touches the filesystem on the hook's blocking path.
    private migrateOnce(startDir: string, target: string): void {
        // Guard on the CHEAP key first. `local()` is called many times per invocation, and resolving the
        // worktree toplevel costs a `git rev-parse` — doing that before the once-check would put a
        // process spawn on the hook's blocking path for every single state-path lookup.
        if (this.migrated.has(startDir)) return;
        this.migrated.add(startDir);
        const toplevel = this.treeRoot(startDir);
        if (toplevel === null) return;
        this.migrator.migrate(this.legacyDir(toplevel), target, AI_WRITABLE_STATE_DIRS);
    }

    // One `git rev-parse <flag>`, resolved to an absolute path (git prints a bare `.git`, relative to
    // the tree, in the primary clone, and an absolute path from a linked worktree).
    private revParse(cwd: string, flag: string): string | null {
        const result = spawnSync('git', ['-C', cwd, 'rev-parse', flag], { encoding: 'utf8' });
        if (result.status !== 0) return null;
        const printed = (result.stdout ?? '').trim();
        if (printed === '') return null;
        return path.resolve(cwd, printed);
    }
}

// Process-wide instance for the many non-DI call sites (hooks, detached refreshers, wp-* bins, eslint
// rules). Sharing one instance is what makes the git-resolution cache and the once-per-tree migration
// worth having; inversify still injects the singleton wherever a container is in play.
export const dotWebpieces = new DotWebpieces();
