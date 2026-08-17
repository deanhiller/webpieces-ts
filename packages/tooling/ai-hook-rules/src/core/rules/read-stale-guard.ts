import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
    BranchStateGuardConfig,
    BRANCH_STATE_GUARD_KEY,
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
import { hangTimeoutOf } from '../main-sync-timeout';
import { logGuardDecision, GuardDecision, Verdict, matrixL2Row } from '../decision-log';
import { writeBranchStateMatrixDoc, branchStateMatrixPointer } from '../l2-matrix-doc';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { MergedBranchMessage } from './merged-branch-message';
import { StaleMainMessage } from './stale-main-message';
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
 * That scoping is also this guard's HOLE, and it is closed elsewhere rather than here: leaving Bash
 * entirely alone let a session `cat`/`grep`/`ls` the same stale tree the Read block was rejecting,
 * for a whole session, while the logs read "read-stale-guard handled". stale-main-bash-guard is the
 * State-A Bash counterpart (as merged-branch-bash-guard is State B's) and blocks only CONTENT-reading
 * commands, never the cure — which is why this guard can stay simple and Read-only.
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
export class ReadStaleGuardRule extends FileRuleBase<BranchStateGuardConfig> {
    constructor(config: BranchStateGuardConfig) { super(config, 'read-stale-guard', BRANCH_STATE_GUARD_KEY); }

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
            new Option("If that pull dies with 'fatal: Cannot fast-forward to multiple branches', .git/FETCH_HEAD holds a duplicate line — run 'git fetch --prune origin main' to rewrite it cleanly, then retry the pull."),
            new Option('Still allowed right now: Bash that does not read repo files (installs, upgrades, builds, tests, the pull itself, git/gh metadata), all Write/Edit, and reading webpieces.config.json. Content-reading Bash (cat/grep/ls/…) is blocked too on a stale main — see stale-main-bash-guard.'),
            new Option('Disable in webpieces.config.json under hookGuards → branch-state-guard (mode OFF) if intentional — that one key governs the Write, Read and Bash halves of this policy together.'),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        // Outside the workspace root — no jurisdiction.
        if (ctx.relativePath.startsWith('..')) return [];

        const branch = this.currentBranch(ctx.workspaceRoot);
        if (branch === null) return this.failOpen(ctx, branch, 'branch-undeterminable');

        // Keep the shared cache warm for the next call. Detached; never blocks this read. Fired for
        // BOTH states — the merged-branch signal comes out of that same cache.
        triggerMainSyncRefresh(ctx.workspaceRoot, hangTimeoutOf(this.config));

        // Escape valve 3 — the read half of the config escape hatch. Ahead of BOTH states' blocks so
        // the agent can always read-then-edit the file that turns this guard off.
        if (this.isConfigFile(ctx.relativePath)) return this.allow(ctx, branch, 'webpieces-config-read (escape hatch)');

        return branch === 'main'
            ? this.checkStaleMain(ctx, branch)
            : this.checkMergedBranch(ctx, branch);
    }

    // State A — on main, possibly behind origin/main.
    private checkStaleMain(ctx: FileContext, branch: string): readonly Violation[] {
        const status = readMainSyncStatus(ctx.workspaceRoot, 'main');
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = this.cacheSummary(status);
        // BELT-AND-BRACES since the cache became branch-keyed: we asked for the 'main' entry by key, so
        // a mismatch means the map's key and the entry's own `branch` disagree — a shape bug. Kept so
        // that degrades to an allow. Unreachable in normal operation.
        if (status.branch !== 'main') return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);
        // Offline / origin unresolvable, or no local main to compare against.
        if (status.originMain === '') return this.failOpen(ctx, branch, 'origin-main-unknown', cache);

        // Escape valve 2 — ancestry, NOT equality. See the class comment.
        if (this.contains(ctx.workspaceRoot, status.originMain)) {
            return this.allow(ctx, branch, 'local-main-contains-origin (up to date)', cache);
        }

        // NO DIRTY VALVE. It used to fail open here, on the argument that the prescribed `git pull` is
        // not a clean fast-forward on a dirty tree. That argument was about the MESSAGE, not the row:
        // row 6's cure cell has always offered `git checkout -b <new> origin/main` as an alternative,
        // and THAT works dirty — it carries uncommitted changes onto the new branch and lands you on
        // current code, which is the whole point. The message now leads with it when the tree is dirty
        // (StaleMainMessage.forReads), so the cure an agent reads is one it can actually run.
        // Residual, same as row 8: if origin/main touched the files you edited, git refuses the switch
        // — `git stash` is on the skip list and clears it. Two steps worst case, never a dead end.
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
        const status = readMainSyncStatus(ctx.workspaceRoot, branch);
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = this.cacheSummary(status);
        // BELT-AND-BRACES since the cache became branch-keyed: the entry was looked up BY `branch`, so
        // a mismatch is a shape bug rather than the old "cache is for another branch" state. Kept so
        // such a bug degrades to an allow. Unreachable in normal operation. (A branch the refresh has
        // not seen yet is the `status === null` case above — still fail-open.)
        if (status.branch !== branch) return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);
        // NOT-MERGED, or NOT-ASKED? `branchAlreadyMerged: false` is produced both by "this branch has
        // no merged PR" and by "the forge could not be reached" (`gh` missing, unauthenticated,
        // rate-limited, offline). Same allow either way — never block on data you could not establish
        // — but the LOG must not call the second one an approval, or the trail cannot tell a policy
        // that is protecting something from one that is quietly standing down.
        if (!status.branchAlreadyMerged) {
            return status.forgeReachable
                ? this.allow(ctx, branch, 'clean-feature-branch', cache)
                : this.failOpen(ctx, branch, 'no-forge', cache);
        }
        // NO DIRTY VALVE — and this one never had an argument behind it at all. Row 8's cure is
        // `git fetch origin main && git checkout -b <new> origin/main`, which carries uncommitted work
        // with you, so a dirty tree traps nobody. The valve was code drift from the documented design;
        // read-stale-guard's own class comment said so while the code did the opposite.
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
        return new MergedBranchMessage(workspaceRoot).forReads(
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

    // Shared with stale-main-bash-guard (StaleMainMessage) so the two halves of the State-A block can
    // never prescribe different cures. Its "still allowed" tail no longer promises EVERY Bash command:
    // content-reading Bash is now blocked too, which is the whole point of the Bash counterpart.
    private staleMainMessage(workspaceRoot: string): string {
        return new StaleMainMessage(workspaceRoot).forReads(this.behindCount(workspaceRoot));
    }

    private cacheSummary(status: MainSyncStatus): string {
        const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
        return `cache=${status.branch} localMain=${status.localMain.slice(0, 8)} originMain=${status.originMain.slice(0, 8)} merged=${merged} ts=${status.timestamp}`;
    }

    /**
     * The guard could not ESTABLISH the state it judges on, so it judged nothing.
     *
     * A sibling of allow() rather than a reason string passed to it, because the difference has to
     * reach the LOG as a value: `ALLOW_FAIL_OPEN` vs `ALLOW`. It was previously a `' (fail-open)'`
     * suffix on the free-text reason, which meant an abstention and a real approval were the same
     * verdict and the abstentions could not be counted — so nobody could tell whether these guards
     * were protecting anything or quietly standing down. Never block on data you could not
     * establish; but say out loud, in a field, that you did not establish it.
     */
    private failOpen(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW_FAIL_OPEN', reason, cache);
        return [];
    }

    private allow(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: FileContext, branch: string, reason: string, message: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK_AI_CURE', reason, cache);
        // Deliver the matrix and name the row — see stale-main-bash-guard.block for why it is lazy.
        const pointer = branchStateMatrixPointer(writeBranchStateMatrixDoc(ctx.workspaceRoot), matrixL2Row(reason).row);
        return [new V(1, ctx.relativePath, message + pointer)];
    }

    private logDecision(ctx: FileContext, branch: string | null, verdict: Verdict, reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('read-stale-guard', ctx.tool, ctx.relativePath, branch ?? 'unknown', verdict, reason, cache, L0_FAULT_NONE, matrixL2Row(reason)),
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
