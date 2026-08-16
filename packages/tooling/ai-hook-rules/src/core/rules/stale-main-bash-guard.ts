import { execSync } from 'child_process';

import {
    BranchStateGuardConfig,
    BRANCH_STATE_GUARD_KEY,
    DEFAULT_HANG_TIMEOUT_MINUTES,
} from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { hangTimeoutOf } from '../main-sync-timeout';
import { logGuardDecision, GuardDecision, Verdict, matrixL2Row } from '../decision-log';
import { writeBranchStateMatrixDoc, branchStateMatrixPointer } from '../l2-matrix-doc';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { CommandScanner } from '../command-scan';
import { TreeRecovery } from './tree-recovery';
import { BranchSwitchScan } from './branch-switch-scan';
import { RecoveryAllowlist } from './recovery-allowlist';

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
 * ── ROW 5: you are on `main`, and that is the whole finding ──────────────────────────────────────
 *
 * The second half USED to ask the main-sync cache whether `main` was BEHIND, and blocked only
 * CONTENT-READING Bash when it was. Both halves of that were wrong, and the table always said so —
 * row 5 reads `B E` / on `main` / block, with the cure `git checkout -b <new> origin/main`.
 *
 * FRESHNESS IS THE WRONG QUESTION. `main` is not a place to work even when it is perfectly current.
 * Staleness changes what you would READ; it does not change whether this is the branch to work on,
 * and the cure is not `git pull` but a new branch. Gating the block on the cache meant a current
 * `main` was treated as a fine place to run a build, an installer or a codegen step.
 *
 * THE CACHE IS THE WRONG PRECONDITION. It is written by a fire-and-forget refresher that populates it
 * for the NEXT call, so the FIRST call of every session has none — and in a multi-worktree repo
 * another tree can hold the refresh lock indefinitely. A block that needs the cache is off exactly
 * when a session is starting, which is precisely when an agent is still standing on `main`. Row 5's
 * Write/Edit half (feature-branch-guard) has always been one `git rev-parse` for this reason; this is
 * `B` being brought into line with `E`, which is the table's own rule, not a new policy.
 *
 * A CONTENT-READ BLOCKLIST COULD NOT HAVE CAUGHT THE WRITES. Enumerating readers catches `cat` and
 * `grep`; it structurally cannot catch `pnpm install`, `npx expo install`, a formatter, codegen or a
 * `>` redirect — commands whose stated purpose is something else and whose effect is to modify
 * tracked files. On `main` the polarity is therefore DEFAULT-DENY plus row 4's skip list, the same
 * shape merged-branch-bash-guard uses for state B, and via the same shared RecoveryAllowlist.
 *
 *   BLOCKED   anything on `main` that is not on the skip list — builds, tests, installers,
 *             formatters, codegen, `cat`/`grep`/`ls` of the tree, git writes.
 *   ALLOWED   everything that gets you OUT or tells you where you are: `git checkout -b <new>
 *             origin/main`, `git switch`, `git pull`/`fetch`, `git status|log|diff|show|branch`,
 *             `gh pr view|list|status|checks`, `git stash`, every `wp-*` bin, installs.
 *
 * FAIL-OPEN is preserved where it still means anything: branch undeterminable → allow. The cache
 * valves (`no-sync-cache`, `origin-main-unknown`, `dirty-tree-on-main`) are gone from THIS guard
 * because it no longer reads the cache; read-stale-guard still opens them for the Read tool, where a
 * dirty tree genuinely does make the prescribed `git pull` unavailable (see the doc's "Not done").
 * Here the cure is `git checkout -b`, which CARRIES uncommitted work onto the new branch — so a dirty
 * tree traps nobody and needs no valve.
 */
export class StaleMainBashGuardRule extends BashRuleBase<BranchStateGuardConfig> {
    constructor(config: BranchStateGuardConfig) { super(config, 'stale-main-bash-guard', BRANCH_STATE_GUARD_KEY); }

    private readonly scanner = new CommandScanner();
    private readonly recovery = new TreeRecovery();
    private readonly switches = new BranchSwitchScan(this.scanner);
    // ROW 4, the skip list — the SAME instance-shape merged-branch-bash-guard uses, so the two states
    // cannot drift apart about what "gets you out" means. See recovery-allowlist.ts.
    private readonly recoveryList = new RecoveryAllowlist(this.scanner);

    readonly description =
        'Block a bare `git checkout main` (chain the pull into the same command), and block Bash on ' +
        'main outright — allowlisting only the commands that get you off it — so a session neither ' +
        'lands on main nor works there, whether or not main happens to be current.';
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'Landing on `main` without pulling, or working on `main` at all, both put your work somewhere it does not belong.',
        'Get onto a feature branch, or pair the checkout with the pull:',
        [
            // TREE-SHAPED, from the one source of tree-shaped cures. A static rule-level hint has no
            // workspace root, so it renders the 'unknown' kind — TreeRecovery's deliberate answer for
            // "we cannot detect the tree": both forms, each labelled. That matters here because the
            // primary-clone form (`git checkout main && …`) is BLOCKED by redirect-how-to-merge-main
            // inside a linked worktree, so a preferred option naming it unconditionally hands the AI a
            // cure a sibling guard denies. The per-block message (pairingMessage) is detected and
            // prints exactly one form; this is the fallback for the hint that cannot look.
            new Option(this.recovery.updateMainSteps('unknown').join('\n')
                + '\nWhichever form applies, the pull must be in the SAME command as the checkout.', true),
            new Option('Already on main: git pull --ff-only origin main (then re-run). If that fatals with "Cannot fast-forward to multiple branches", .git/FETCH_HEAD has a duplicate line — run git fetch --prune origin main first.'),
            new Option('Still allowed on main: everything that gets you OUT or tells you where you are — git checkout -b <new> origin/main, git switch, git pull/fetch, git status|log|diff|show|branch, gh pr view|list|status|checks, git stash, every wp-* bin, installs, and reading webpieces.config.json.'),
            new Option('Disable in webpieces.config.json under hookGuards → branch-state-guard (mode OFF) if intentional — that one key governs the Write, Read and Bash halves of this policy together.'),
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
        if (branch === null) return this.failOpen(ctx, branch, 'branch-undeterminable');

        // Keep the shared cache warm for the next call. Detached; never blocks this command.
        triggerMainSyncRefresh(ctx.workspaceRoot, hangTimeoutOf(this.config));

        // State A is on `main` only. A merged feature branch is merged-branch-bash-guard's job.
        if (branch !== 'main') return this.allow(ctx, branch, 'not-on-main (state B is another guard)');

        // ROW 4 — the skip list, ahead of the block, so no command that gets you OUT is ever denied.
        if (this.recoveryList.isFullyRecovery(ctx)) {
            return this.allow(ctx, branch, 'not-a-content-read (cure/build/metadata)');
        }

        // ROW 5 — on `main`. NO CACHE IS READ ON THIS PATH, and that is the change.
        //
        // The old ladder asked the cache "is main BEHIND?" and only then blocked, and only content
        // READS. That made the whole Bash half of row 5 conditional on freshness, which is the wrong
        // question twice over:
        //
        //   1. Freshness is irrelevant to whether you should be working here. `main` is not a place to
        //      work even when it is perfectly current — the cure is the same either way, and it is not
        //      `git pull`, it is `git checkout -b`. Row 5's cure has always said so.
        //   2. The cache is populated by a FIRE-AND-FORGET refresher that fills it for the NEXT call,
        //      so on the first call of every session there is none — and in a multi-worktree repo
        //      another tree can hold the refresh lock indefinitely. A block that needs the cache is a
        //      block that is off exactly when a session is starting, which is when an agent is most
        //      likely to still be standing on `main`.
        //
        // So this is now one `git rev-parse` and a text scan, both of which fire on call #1 — the same
        // arrangement that has always governed row 5's Write/Edit half (feature-branch-guard). `B`
        // tracking `E` here is the table's own rule, not a new policy.
        //
        // The polarity flips with it: on `main` this is DEFAULT-DENY plus row 4's skip list, where it
        // used to be default-allow plus a content-read blocklist. That is what makes it catch the
        // commands a blocklist structurally cannot — an installer, a formatter or a codegen step that
        // WRITES tracked files while its stated purpose is something else. Blocking those was never
        // going to come from enumerating readers.
        return this.block(ctx, branch, 'on-main', this.onMainMessage(ctx.workspaceRoot), '-');
    }

    /**
     * The first segment that switches to the `main` BRANCH with no `git pull` anywhere in the same
     * command, or null. The pull is looked for across the WHOLE command, not the matched segment,
     * because `git checkout main && git pull origin main` splits into two segments and the pairing is
     * the point.
     */
    private bareCheckoutOfMain(ctx: BashContext): string | null {
        for (const segment of this.scanner.commandSegments(ctx.command)) {
            // BranchSwitchScan answers "which branch does this land on" for both guards, flag-tolerantly:
            // `git checkout -q main` lands on main exactly as the bare form does, while
            // `git checkout -b x origin/main` (creates), `git checkout -- main` (pathspec) and
            // `git checkout <sha>` do not. See branch-switch-scan.ts for why that lives in one place.
            if (!this.switches.landsOnExistingMain(segment)) continue;
            return this.scanner.commandInvokesAnyGit(ctx.command, ['pull']) ? null : segment;
        }
        return null;
    }

    /**
     * The row 5 deny. Deliberately SHORT, and deliberately NOT about staleness.
     *
     * The old message opened by reporting how many commits behind `main` was, which invited exactly
     * the wrong cure — an agent that reads "behind" reaches for `git pull`, ends up on a CURRENT
     * `main`, and is still on `main`. The finding is the branch, so that is the first thing said.
     */
    private onMainMessage(workspaceRoot: string): string {
        return 'Blocked: you are on `main`. `main` is not a place to work — whether or not it is '
            + 'current — because work here cannot be reviewed, cannot be reverted as a unit, and is '
            + 'one `git checkout` away from being lost. This is judged from the branch alone, so it '
            + 'fires on the first command of a session, before any freshness is known.\n'
            + `Start a branch (uncommitted work comes with you):\n  cd '${workspaceRoot}' && git fetch origin main && git checkout -b <new-branch> origin/main`;
    }

    private pairingMessage(ctx: BashContext): string {
        const steps = this.recovery.updateMainSteps(this.recovery.kindOf(ctx.workspaceRoot)).join('\n');
        // Deliberately SHORT. The incident that bought this guard (a main 157 commits behind; the
        // downgrade the reverted shim then prescribed) is maintainer material and lives in the class
        // docblock above — the reader of THIS text needs only what changes what they type.
        return 'Blocked: a bare `git checkout main` lands you on whatever local `main` you last had — '
            + 'stale files, plus a reverted @webpieces pin and guard shim, so the drift guard then '
            + 'reports the drift BACKWARDS. Chain the pull into the same command:\n' + steps;
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
    private failOpen(ctx: BashContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW_FAIL_OPEN', reason, cache);
        return [];
    }

    private allow(ctx: BashContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: BashContext, branch: string, reason: string, message: string, cache: string): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK_AI_CURE', reason, cache);
        // Deliver the matrix and name the row, the same way an L0 block does. The doc is written
        // LAZILY here rather than up front: only a blocked agent needs it, and this is the one path
        // that knows the row it should be opened at.
        const row = matrixL2Row(reason).row;
        const pointer = branchStateMatrixPointer(writeBranchStateMatrixDoc(ctx.workspaceRoot), row);
        return [new V(1, this.truncate(ctx.command), message + pointer)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, branch: string | null, verdict: Verdict, reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('stale-main-bash-guard', 'Bash', ctx.command, branch ?? 'unknown', verdict, reason, cache, L0_FAULT_NONE, matrixL2Row(reason)),
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
