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
import { logGuardDecision, GuardDecision } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { StaleMainMessage } from './stale-main-message';
import { ContentReadScan } from './content-read-scan';

/**
 * The BASH half of the STALE-MAIN protection (read-stale-guard's State A).
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

    readonly description =
        'Block content-reading Bash (cat/grep/ls/…) while local main is behind origin/main, so a ' +
        'session cannot reason over a stale tree through the side door the Read-tool block leaves open.';
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'You are on main and main is behind origin/main — reading files here gives you stale content.',
        'Update main first, then re-run your command:',
        [
            new Option('git pull --ff-only origin main (then re-run). If that fatals with "Cannot fast-forward to multiple branches", .git/FETCH_HEAD has a duplicate line — run git fetch --prune origin main first.', true),
            new Option('Still allowed right now: builds, tests, installs, the pull itself, all git/gh METADATA (status|log|diff|show|branch), every Write/Edit, and reading webpieces.config.json.'),
            new Option('Disable in webpieces.config.json under hookGuards → stale-main-bash-guard (mode OFF) if intentional.'),
        ],
    );

    check(ctx: BashContext): readonly Violation[] {
        const branch = this.currentBranch(ctx.workspaceRoot);
        if (branch === null) return this.allow(ctx, branch, 'branch-undeterminable (fail-open)');

        // Keep the shared cache warm for the next call. Detached; never blocks this command.
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        // State A is on `main` only. A merged feature branch is merged-branch-bash-guard's job.
        if (branch !== 'main') return this.allow(ctx, branch, 'not-on-main (state B is another guard)');

        const status = readMainSyncStatus(ctx.workspaceRoot);
        if (status === null) return this.allow(ctx, branch, 'no-sync-cache (fail-open)', 'cache=none');

        const cache = this.cacheSummary(status);
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
        this.logDecision(ctx, branch, 'BLOCK', reason, cache);
        return [new V(1, this.truncate(ctx.command), message)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, branch: string | null, verdict: 'ALLOW' | 'BLOCK', reason: string, cache: string): void {
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
