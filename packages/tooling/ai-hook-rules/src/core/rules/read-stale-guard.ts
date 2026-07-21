import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
    ReadStaleGuardConfig,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    MainSyncStatus,
} from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { logGuardDecision, GuardDecision } from '../decision-log';
import { MergedBranchMessage } from './merged-branch-message';
import { TreeRecovery } from './tree-recovery';

/**
 * Blocks READS while the checked-out branch is a stale place to read from. TWO states:
 *
 *   A. on `main`, and local main is BEHIND origin/main
 *   B. on a feature branch whose PR is ALREADY MERGED (a pre-merge snapshot; origin/main has moved
 *      past it and a squash merge means its HEAD is not even an ancestor of main)
 *
 * WHY READ, of all tools: either state means the AI reads stale FILE CONTENT and then reasons,
 * plans and writes against code that no longer exists upstream. Blocking the write is too late —
 * the bad premise is already in context. So the block lands on the read. (feature-branch-guard
 * blocks the WRITE in state B; this guard is the read-side half of that same protection, and the
 * two share one recovery message via MergedBranchMessage.)
 *
 * THE DIRTY-TREE ASYMMETRY is deliberate. State A fails OPEN on a dirty tree because `git pull` is
 * then not a guaranteed fast-forward and the agent would be trapped away from the files it needs to
 * resolve the conflict. State B blocks ANYWAY, because its cure — `git checkout -b <new>
 * origin/main` — carries uncommitted changes onto the fresh branch, so there is nothing to resolve
 * and nothing to be trapped by.
 *
 * WHY THIS CANNOT WEDGE: the block is scoped to Read ONLY. Every cure — `git pull origin main`,
 * `pnpm install`, any webpieces upgrade — is a Bash command, and this guard never looks at Bash.
 * So there is no command allowlist to maintain and no way to lock the agent out of its own fix.
 * (`git pull origin main` is explicitly permitted on main by redirect-how-to-merge-main, which
 * returns null when the branch IS main — the two guards are complementary, not stacked.)
 *
 * Everything here is FAIL-OPEN. A guard that blocks reads on bad data is far worse than one that
 * misses; every unknown resolves to "allow". The four deliberate escape valves:
 *
 *   1. DIRTY TREE  — uncommitted work on main means `git pull` is not a guaranteed fast-forward.
 *                    Blocking reads there would trap the agent: it could not read the files it
 *                    needs to resolve the very conflict blocking it. Allow. (State A ONLY — see
 *                    the dirty-tree asymmetry above.)
 *   2. CACHE LAG   — we do NOT compare hashes for equality. The cached `originMain` is written by
 *                    the detached refresher and is arbitrarily old, so `local !== origin` stays
 *                    true for a while AFTER a successful pull, which would spin the agent forever.
 *                    Instead: is the cached origin/main an ANCESTOR of local main? If local main
 *                    already contains it, we are not behind. That flips the instant the pull lands,
 *                    with no refresher round-trip. This is the single most important line here.
 *   3. CONFIG READ — webpieces.config.json stays readable so the agent can always read-then-edit
 *                    it to set `mode: OFF`. Its EDIT is already bypassed in runner.ts + hook-core;
 *                    this closes the read half of that same escape hatch.
 *   4. NO DATA     — no cache, cache for another branch, empty originMain (offline), or no local
 *                    main at all (fresh clone / worktree) → allow.
 *
 * Runs from the Read fast path in hook-core (Read is neither a file-edit nor a bash payload, so it
 * never reaches the runner's rule loop). Fires the detached refresher on every call, which is also
 * what makes reads keep the shared main-sync cache warm for feature-branch-guard.
 */
export class ReadStaleGuardRule extends FileRuleBase<ReadStaleGuardConfig> {
    constructor(config: ReadStaleGuardConfig) { super(config, 'read-stale-guard'); }

    readonly description = 'Block reads on a branch that is stale to read from — a `main` behind origin/main, or a feature branch whose PR is already merged.';
    override readonly files = ['**/*'];
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'This branch is stale to read from — reading it would give you pre-merge/out-of-date content.',
        'Get onto current code before reading anything else:',
        [
            new Option('On main, behind origin/main → git pull origin main. On an already-merged branch → git fetch origin main && git checkout -b <new-branch> origin/main. Then retry the read.', true),
            new Option('Still allowed right now: EVERY Bash command (installs, upgrades, builds), all Write/Edit, and reading webpieces.config.json.'),
            new Option('Disable in webpieces.config.json under hookGuards → read-stale-guard (mode OFF) if intentional.'),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        // Outside the workspace root — no jurisdiction.
        if (ctx.relativePath.startsWith('..')) return [];

        const branch = this.currentBranch(ctx.workspaceRoot);
        if (branch === null) return this.allow(ctx, branch, 'branch-undeterminable (fail-open)');

        // Keep the shared cache warm for the next call. Detached; never blocks this read. Fired for
        // BOTH states — the merged-branch signal comes out of that same cache.
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        // Escape valve 3 — the read half of the config escape hatch. Ahead of BOTH states' blocks so
        // the agent can always read-then-edit the file that turns this guard off.
        if (this.isConfigFile(ctx.relativePath)) return this.allow(ctx, branch, 'webpieces-config-read (escape hatch)');

        return branch === 'main'
            ? this.checkStaleMain(ctx, branch)
            : this.checkMergedBranch(ctx, branch);
    }

    // State A — on main, possibly behind origin/main.
    private checkStaleMain(ctx: FileContext, branch: string): readonly Violation[] {
        const status = readMainSyncStatus(ctx.workspaceRoot);
        if (status === null) return this.allow(ctx, branch, 'no-sync-cache (fail-open)', 'cache=none');

        const cache = this.cacheSummary(status);
        if (status.branch !== 'main') return this.allow(ctx, branch, 'stale-cross-branch-cache (fail-open)', cache);
        // Offline / origin unresolvable, or no local main to compare against.
        if (status.originMain === '') return this.allow(ctx, branch, 'origin-main-unknown (fail-open)', cache);

        // Escape valve 2 — ancestry, NOT equality. See the class comment.
        if (this.contains(ctx.workspaceRoot, status.originMain)) {
            return this.allow(ctx, branch, 'local-main-contains-origin (up to date)', cache);
        }

        // Escape valve 1 — a dirty tree means the pull is not a clean fast-forward; do not trap
        // the agent away from the files it needs to resolve it.
        if (this.isDirty(ctx.workspaceRoot)) {
            return this.allow(ctx, branch, 'dirty-tree-on-main (fail-open)', cache);
        }

        return this.block(ctx, branch, 'on-stale-main', this.staleMainMessage(ctx.workspaceRoot), cache);
    }

    /**
     * State B — a feature branch whose PR is already merged. Reads a PRE-MERGE snapshot, so every
     * plan built from it is built on code origin/main has moved past.
     *
     * `branchAlreadyMerged` comes straight from the shared cache (the refresher's `gh pr list --state
     * merged`), so this path spawns nothing. No `gh` / offline → `mergedPr` is '' → not merged → allow,
     * which is the fail-open direction for free.
     *
     * The DIRTY-TREE escape valve is the same one state A has, for the same reason: uncommitted work
     * on a merged branch is work that exists nowhere else, and rescuing it means READING the files it
     * touches. `git checkout -b <new> origin/main` usually carries those changes across — but when it
     * does not (an overlapping change landed in main), a blocked read is an agent that cannot even
     * see what it is about to lose. feature-branch-guard still blocks the EDITS, so the state is
     * surfaced loudly either way; we just refuse to cut off the rescue path.
     */
    private checkMergedBranch(ctx: FileContext, branch: string): readonly Violation[] {
        const status = readMainSyncStatus(ctx.workspaceRoot);
        if (status === null) return this.allow(ctx, branch, 'no-sync-cache (fail-open)', 'cache=none');

        const cache = this.cacheSummary(status);
        // Cache written for a DIFFERENT branch (just switched; the refresh for this one hasn't landed).
        // Never block on another branch's signals — this is also what un-blocks the instant the agent
        // follows the cure and checks out a fresh branch.
        if (status.branch !== branch) return this.allow(ctx, branch, 'stale-cross-branch-cache (fail-open)', cache);
        if (!status.branchAlreadyMerged) return this.allow(ctx, branch, 'clean-feature-branch', cache);
        if (this.isDirty(ctx.workspaceRoot)) {
            return this.allow(ctx, branch, 'dirty-merged-branch (fail-open)', cache);
        }

        const pr = status.mergedPr !== '' ? status.mergedPr : '?';
        return this.block(
            ctx,
            branch,
            `already-merged PR#${pr}`,
            this.mergedMessage(ctx.workspaceRoot, branch, status.mergedPr),
            cache,
        );
    }

    // The merged-branch text, told in the flavour of the tree we are standing in: a linked worktree
    // is told to open a NEW worktree off origin/main and reap this dead one; the primary clone is
    // told to branch off origin/main. Neither is ever told to `git checkout main` (fatal in a
    // worktree). Detection is one statSync — see WorktreeService.isLinkedWorktree.
    private mergedMessage(workspaceRoot: string, branch: string, mergedPr: string): string {
        const recovery = new TreeRecovery();
        return new MergedBranchMessage().forReads(
            branch, mergedPr, recovery.kindOf(workspaceRoot), workspaceRoot,
        );
    }

    // Is `commit` an ancestor of (i.e. already contained in) HEAD? Local-only and fast — no network.
    //
    // spawnSync, not execSync, precisely because the EXIT CODE is the answer and we must tell three
    // outcomes apart: 0 = ancestor (up to date), 1 = cleanly NOT an ancestor (genuinely behind),
    // anything else = git could not answer (bad/pruned object, not a repo) which must fail OPEN.
    // execSync collapses 1 and "git broke" into the same thrown Error, so it cannot make that call.
    // Arg-array form also means the commit hash is never parsed by a shell.
    private contains(workspaceRoot: string, commit: string): boolean {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
        });
        if (result.status === 0) return true;
        if (result.status === 1) return false;
        return true; // unknown/failed → treat as "contained" so the guard allows
    }

    private isDirty(workspaceRoot: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const out = execSync('git status --porcelain', {
                cwd: workspaceRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return out.trim().length > 0;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            // Cannot tell → assume dirty, which is the fail-OPEN direction for this guard.
            return true;
        }
    }

    private isConfigFile(relativePath: string): boolean {
        return relativePath === 'webpieces.config.json';
    }

    // How far behind we are, for the message. Best-effort — a bare "behind" reads fine without it.
    private behindCount(workspaceRoot: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const out = execSync('git rev-list --count HEAD..origin/main', {
                cwd: workspaceRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            return /^\d+$/.test(out) ? out : '?';
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '?';
        }
    }

    private staleMainMessage(workspaceRoot: string): string {
        return [
            `You are on main and main is ${this.behindCount(workspaceRoot)} commit(s) behind origin/main.`,
            'Reading files right now would give you STALE content and everything you plan from it',
            'would be built on code that no longer exists upstream. Reads are blocked until you update.',
            '',
            'Run exactly this, then retry the read:',
            '  git pull origin main',
            '',
            'Still allowed while this block is up:',
            '  - EVERY Bash command (pnpm install, any webpieces upgrade, builds, all git/gh)',
            '  - All Write/Edit (feature-branch-guard governs those separately)',
            '  - Reading and editing webpieces.config.json (set read-stale-guard mode OFF to disable)',
        ].join('\n');
    }

    private cacheSummary(status: MainSyncStatus): string {
        const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
        return `cache=${status.branch} localMain=${status.localMain.slice(0, 8)} originMain=${status.originMain.slice(0, 8)} merged=${merged} ts=${status.timestamp}`;
    }

    private allow(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: FileContext, branch: string, reason: string, message: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK', reason, cache);
        return [new V(1, ctx.relativePath, message)];
    }

    private logDecision(ctx: FileContext, branch: string | null, verdict: 'ALLOW' | 'BLOCK', reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('read-stale-guard', ctx.tool, ctx.relativePath, branch ?? 'unknown', verdict, reason, cache),
        );
    }

    /**
     * The current branch, WITHOUT spawning git on the common path.
     *
     * This runs on EVERY read, so it is the one call whose cost actually matters. Spawning
     * `git rev-parse --abbrev-ref HEAD` measures ~12ms — essentially all process-spawn overhead —
     * whereas `.git/HEAD` is a single tiny file whose read is microseconds. On a feature branch
     * (the overwhelmingly common case) that file read is the ONLY work this guard does before
     * short-circuiting, so reads stay effectively free.
     *
     * Falls back to spawning git whenever `.git/HEAD` cannot answer authoritatively:
     *   - `.git` is a FILE, not a dir → we are in a worktree and HEAD lives elsewhere
     *   - detached HEAD → the file holds a raw sha, not a `ref:` line
     *   - anything unreadable/unexpected
     * The fallback is correct in all those cases; it is just slower, and they are rare.
     */
    private currentBranch(workspaceRoot: string): string | null {
        const fromHead = this.branchFromGitHead(workspaceRoot);
        if (fromHead !== null) return fromHead;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: workspaceRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    // Parse `.git/HEAD` ("ref: refs/heads/<branch>"). null = cannot answer, caller must fall back.
    private branchFromGitHead(workspaceRoot: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const gitPath = path.join(workspaceRoot, '.git');
            // A worktree/submodule has `.git` as a file pointing at the real gitdir — HEAD is not here.
            if (!fs.statSync(gitPath).isDirectory()) return null;
            const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
            const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
            return match ? match[1] : null; // no match = detached HEAD → fall back
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }
}
