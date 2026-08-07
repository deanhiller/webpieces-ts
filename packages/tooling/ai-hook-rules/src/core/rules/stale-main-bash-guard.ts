import { execSync, spawnSync } from 'child_process';

import {
    StaleMainBashGuardConfig,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    MainSyncStatus,
} from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { logGuardDecision, GuardDecision, Verdict } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { StaleMainMessage } from './stale-main-message';
import { ContentReadScan } from './content-read-scan';
import { TreeRecovery } from './tree-recovery';

/**
 * The BASH half of the STALE-MAIN protection (read-stale-guard's State A), in two halves of its own:
 * a PREVENTIVE check that stops a session landing on a stale `main`, and the REACTIVE check that
 * contains the damage once it is already there.
 *
 * ── PREVENTIVE: a bare `git checkout main` is blocked; the pull must ride along ──────────────────
 *
 * Everything below this paragraph fires only once the session is ALREADY sitting on a stale `main`.
 * Nothing stopped it ARRIVING there, and arriving is one keystroke. In the incident that added this
 * half, an agent ran `git checkout main` after a merge, in a clone whose local `main` was **157
 * commits behind** origin. That checkout did not merely produce stale files — it reverted:
 *
 *   1. `package.json`'s `@webpieces` pin, to a version OLDER than the installed `node_modules`;
 *   2. `.claude/webpieces/ai-hook.sh` — the version-drift guard ITSELF — to a 157-commit-old copy
 *      whose message stated the drift BACKWARDS ("your installed webpieces is older than required")
 *      and named a single cure, `pnpm install`;
 *   3. and so the agent's judgment: it ran that `pnpm install`, DOWNGRADING `node_modules` to match
 *      the stale pin, and had to undo it with the `git pull` that should have come first.
 *
 * The shim on current main already diagnoses drift correctly — it distinguishes "the pin is newer"
 * from "the pin is stale, and `pnpm install` would downgrade you". None of that helped, because the
 * checkout had replaced the shim with the version that could not say it. **A guard a stale checkout
 * can revert cannot be relied on to catch a stale checkout**, which is why this check is preventive
 * and why it lives here rather than in a second rule: same failure, one step earlier, one switch.
 *
 * It matches on command TEXT alone and asks git nothing. That is not laziness — this runs BEFORE the
 * checkout, so the only `main` it could measure is the one it is about to leave. The interesting
 * `main` does not exist yet, and consulting HEAD-at-hook-time is the exact trap
 * `redirect-how-to-merge-main` documents at length. Pairing is unconditionally correct instead: when
 * `main` is already current the chained pull is a sub-second no-op, so no exception is worth carving.
 *
 *   BLOCKED   `git checkout main`, `git switch main` — with or without flags — when no `git pull`
 *             appears anywhere in the SAME command.
 *   ALLOWED   `git checkout main && git pull origin main`, the pairing this forces, which is the
 *             exact line the post-merge cleanup flow already prescribes.
 *   ALLOWED   `git checkout -b <x> origin/main` (current by construction), `git checkout <sha>`,
 *             `git checkout -- <file>`, and any other branch.
 *
 * ── REACTIVE: content-reading Bash on a stale `main` ─────────────────────────────────────────────
 *
 * read-stale-guard blocks the Read tool when local `main` is behind origin/main — but it looks at
 * nothing else, deliberately: "every cure is a Bash command, so Bash is the escape hatch — never
 * wedge it." That reasoning is right about the CURE and wrong about `cat`/`grep`/`ls`. In the
 * incident this closes, an agent sat on a `main` 18 commits behind origin/main (108 files, +8069
 * −3692 upstream), had its Read tool blocked exactly as designed, and then spent the whole session
 * `ls`-ing, `grep`-ing and `cat`-ing the same stale tree through the side door — describing a CI
 * workflow set that was missing a 186-line workflow which existed upstream. The logs read
 * "read-stale-guard handled", which is worse than no guard: it looks covered.
 *
 * So this guard blocks CONTENT-READING Bash only, never the whole shell. Builds, tests, installs,
 * `git pull`, git METADATA (log/diff/show/status) — all still run. What is blocked is a command that
 * would put stale FILE CONTENT into context: `cat`/`head`/`grep`/`rg`/`sed`/`awk`/`ls`/`find`/… of a
 * path inside this workspace, and `git grep` / `git show <rev>:<path>` against a local rev. The same
 * line merged-branch-bash-guard already draws for State B, scoped tighter because State A's cure is
 * one command away and there is no reason to stop anything else.
 *
 * A piped consumer reads stdin, not the tree: `git log --oneline | grep fix` is allowed, because the
 * bytes came from git metadata, not from a stale file. That is why the scan needs the pipe flag.
 *
 * FAIL-OPEN, with read-stale-guard's own escape valves, so it can never wedge a session:
 *   - branch undeterminable / not on `main` / no cache / cache for another branch → allow
 *   - `originMain` unknown (offline) → allow
 *   - origin/main already an ancestor of HEAD (ancestry, NOT equality) → allow the instant the pull lands
 *   - DIRTY tree → allow: the pull is not a clean fast-forward, and resolving that means reading the
 *     very files in conflict. Never trap the agent away from its own rescue.
 *   - reading `webpieces.config.json` (the mode-OFF escape hatch) and `.webpieces/**` → allow
 */
export class StaleMainBashGuardRule extends BashRuleBase<StaleMainBashGuardConfig> {
    constructor(config: StaleMainBashGuardConfig) { super(config, 'stale-main-bash-guard'); }

    private readonly scanner = new CommandScanner();
    private readonly recovery = new TreeRecovery();

    readonly description =
        'Block a bare `git checkout main` (chain the pull into the same command), and block ' +
        'content-reading Bash (cat/grep/ls/…) while local main is behind origin/main — so a session ' +
        'neither lands on a stale main nor reasons over one through the side door the Read block leaves.';
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'Landing on `main` without pulling, or reading files while main is behind origin/main, both give you stale content.',
        'Pair the checkout with the pull, or update main and re-run:',
        [
            new Option('git checkout main && git pull origin main (the pull must be in the SAME command).', true),
            new Option('Already on main: git pull --ff-only origin main (then re-run). If that fatals with "Cannot fast-forward to multiple branches", .git/FETCH_HEAD has a duplicate line — run git fetch --prune origin main first.'),
            new Option('In a linked worktree `git checkout main` FATALS ("main is already checked out at <primary clone>") — branch off fresh main instead: git fetch origin main && git checkout -b <name> origin/main'),
            new Option('NOT blocked: `git checkout <sha>`, `git checkout -b <x> origin/main`, `git checkout -- <file>`, any other branch. Also still allowed: builds, tests, installs, the pull itself, all git/gh METADATA (status|log|diff|show|branch), every Write/Edit, and reading webpieces.config.json.'),
            new Option('Disable in webpieces.config.json under hookGuards → stale-main-bash-guard (mode OFF) if intentional.'),
        ],
    );

    check(ctx: BashContext): readonly Violation[] {
        // PREVENTIVE half, FIRST and unconditional. Deliberately ahead of every fail-open bailout
        // below: those all ask "is the main we are ON stale?", and this asks about the main we are
        // about to MOVE TO — a different branch, and one no cache can describe yet.
        const bare = this.bareCheckoutOfMain(ctx);
        if (bare !== null) {
            return this.block(ctx, 'any', `bare checkout of main (${bare})`, this.pairingMessage(ctx), '-');
        }

        const branch = this.currentBranch(ctx.workspaceRoot);
        if (branch === null) return this.allow(ctx, branch, 'branch-undeterminable (fail-open)');

        // Keep the shared cache warm for the next call. Detached; never blocks this command.
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        // State A is on `main` only. A merged feature branch is merged-branch-bash-guard's job.
        if (branch !== 'main') return this.allow(ctx, branch, 'not-on-main (state B is another guard)');

        const status = readMainSyncStatus(ctx.workspaceRoot, 'main');
        if (status === null) return this.allow(ctx, branch, 'no-sync-cache (fail-open)', 'cache=none');

        const cache = this.cacheSummary(status);
        // BELT-AND-BRACES since the cache became branch-keyed: we asked for the 'main' entry by key, so
        // a mismatch means the map's key and the entry's own `branch` disagree — a shape bug. Kept so
        // that degrades to an allow. Unreachable in normal operation.
        if (status.branch !== 'main') return this.allow(ctx, branch, 'stale-cross-branch-cache (fail-open)', cache);
        // Offline / origin unresolvable — we have nothing to be stale RELATIVE TO.
        if (status.originMain === '') return this.allow(ctx, branch, 'origin-main-unknown (fail-open)', cache);

        // Ancestry, not equality: the moment the pull lands (or we are simply ahead), we are current.
        if (this.contains(ctx.workspaceRoot, status.originMain)) {
            return this.allow(ctx, branch, 'local-main-contains-origin (up to date)', cache);
        }

        // A dirty tree means the pull is not a clean fast-forward. Do not cut the agent off from the
        // files it must read to resolve that — the same valve read-stale-guard opens.
        if (this.isDirty(ctx.workspaceRoot)) {
            return this.allow(ctx, branch, 'dirty-tree-on-main (fail-open)', cache);
        }

        const reader = this.staleContentRead(ctx);
        if (reader === null) return this.allow(ctx, branch, 'not-a-content-read (cure/build/metadata)', cache);

        return this.block(ctx, branch, `stale-main content read (${reader})`, this.staleMessage(ctx.workspaceRoot), cache);
    }

    /**
     * The first segment that switches to the `main` BRANCH with no `git pull` anywhere in the same
     * command, or null. The pull is looked for across the WHOLE command, not the matched segment,
     * because `git checkout main && git pull origin main` splits into two segments and the pairing is
     * the point.
     */
    private bareCheckoutOfMain(ctx: BashContext): string | null {
        for (const segment of this.scanner.commandSegments(ctx.command)) {
            if (!this.scanner.invokesGit(segment, 'checkout') && !this.scanner.invokesGit(segment, 'switch')) continue;
            if (!this.switchesToMainBranch(segment)) continue;
            return this.scanner.commandInvokesAnyGit(ctx.command, ['pull']) ? null : segment;
        }
        return null;
    }

    /**
     * True only for landing ON the branch. `-b`/`-B`/`-c`/`-C` CREATE a branch, so
     * `git checkout -b x origin/main` is current by construction and never blocked; a `--` turns the
     * rest into pathspecs, so `git checkout -- main` restores a FILE named main and moves no branch.
     */
    private switchesToMainBranch(segment: string): boolean {
        const words = this.scanner.words(segment);
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            if (word === '--') return false;
            if (/^-[bBcC]$/.test(word)) return false;
            if (i > 1 && word === 'main') return true;
        }
        return false;
    }

    private pairingMessage(ctx: BashContext): string {
        const steps = this.recovery.updateMainSteps(this.recovery.kindOf(ctx.workspaceRoot)).join('\n');
        return 'Blocked: a bare `git checkout main` lands you on whatever local `main` you last had. '
            + 'That is not only stale FILES — it also reverts `package.json`\'s @webpieces pin and the '
            + 'guard shim under `.claude/webpieces/`, so the very hook that would diagnose the resulting '
            + 'version drift is replaced by an older copy that reports it BACKWARDS and names the cure '
            + 'that makes it worse. Chain the pull into the same command, leaving no window in which you '
            + 'are on a stale main:\n' + steps;
    }

    // The first segment that would read stale workspace content, or null when none does. The RAW
    // command is scanned, not commandCode: this is a blocklist-shaped guard, so stripping quoted
    // prose can only ever block LESS (see BashContext.commandCode).
    private staleContentRead(ctx: BashContext): string | null {
        const scan = new ContentReadScan(this.scanner, ctx.workspaceRoot, ctx.effectiveCwd);
        for (const segment of this.scanner.segmentsWithPipes(ctx.command)) {
            const hit = scan.readsStaleContent(segment);
            if (hit !== null) return hit;
        }
        return null;
    }

    // Is `commit` already contained in HEAD? Exit code IS the answer, so spawnSync: 0 = ancestor,
    // 1 = genuinely behind, anything else = git could not tell → fail OPEN. (Mirrors read-stale-guard.)
    private contains(workspaceRoot: string, commit: string): boolean {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
        });
        if (result.status === 0) return true;
        if (result.status === 1) return false;
        return true;
    }

    private isDirty(workspaceRoot: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const out = execSync('git status --porcelain', {
                cwd: workspaceRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            });
            return out.trim().length > 0;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return true;  // cannot tell → assume dirty, the fail-OPEN direction here
        }
    }

    private staleMessage(workspaceRoot: string): string {
        return new StaleMainMessage(workspaceRoot).forBash(this.behindCount(workspaceRoot));
    }

    private behindCount(workspaceRoot: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const out = execSync('git rev-list --count HEAD..origin/main', {
                cwd: workspaceRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            return /^\d+$/.test(out) ? out : '?';
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '?';
        }
    }

    private cacheSummary(status: MainSyncStatus): string {
        return `cache=${status.branch} localMain=${status.localMain.slice(0, 8)} originMain=${status.originMain.slice(0, 8)} ts=${status.timestamp}`;
    }

    private allow(ctx: BashContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: BashContext, branch: string, reason: string, message: string, cache: string): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK_AI_CURE', reason, cache);
        return [new V(1, this.truncate(ctx.command), message)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, branch: string | null, verdict: Verdict, reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('stale-main-bash-guard', 'Bash', ctx.command, branch ?? 'unknown', verdict, reason, cache),
        );
    }

    private currentBranch(workspaceRoot: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: workspaceRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }
}
