import { execSync } from 'child_process';

import { BranchStateGuardConfig, BRANCH_STATE_GUARD_KEY, DEFAULT_HANG_TIMEOUT_MINUTES, readMainSyncStatus, Option } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
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
import { MainFreshness } from './main-freshness';
import { CurePrefixScan, CurePrefix } from './cure-prefix-scan';

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
 *   ALLOWED   `git checkout main && git pull origin main`, the pairing this forces — and
 *             `pnpm wp-sync-main`, which IS that pairing with the cleanup and the
 *             orphan-directory sweep welded on. The message prescribes the one command; the raw pair
 *             stays legal because it is plain git and because it is the L0 recovery cure, where
 *             `node_modules` is the thing in doubt and no `pnpm` bin can be relied on.
 *   ALLOWED   `git checkout -b <x> origin/main` (current by construction), `git checkout <sha>`,
 *             `git checkout -- <file>`, and any other branch.
 *
 * ── ROWS 6/7: the block fires only once `main` is KNOWN STALE ────────────────────────────────
 *
 * The finding is not "you are on `main`" — it is **"what you would read here is out of date"**. So the
 * ladder below asks the main-sync cache, exactly as read-stale-guard's State A does, and BLOCKS only
 * when local `main` is known to be BEHIND `origin/main`. Unknown → allow. Current → allow.
 *
 * WHY, when this guard spent a release judging the branch alone: because the branch alone denies
 * everything off a narrow allowlist on a PERFECTLY CURRENT `main`, and a current `main` is exactly
 * where the prescribed cure leaves you. An agent lands a PR, runs `pnpm wp-sync-main` — the
 * command this repo tells it to run — and the next `curl`, `gh pr close` or test run is refused by a
 * guard whose own name says STALE. The tool that got it there could not be the cure for being there,
 * and the refusal had nothing to do with staleness, which is the confusion reported from the field.
 *
 * THE ASYMMETRY WITH `E` IS DELIBERATE, and the docblocks that argued `B` should track `E` were right
 * about the mechanism and wrong about the policy. A WRITE on `main` creates work in the wrong place
 * whatever `main`'s freshness — unreviewable, and unrevertable as a unit — so feature-branch-guard
 * stays unconditional and keeps its one `git rev-parse`. A READ or a BUILD on a CURRENT `main` harms
 * nothing, and blocking it strands the agent at the exact moment the prescribed cure put it there.
 * Same tree, different hazard, so one precondition was never right for both.
 *
 * THE ANCESTRY TEST, NOT HASH EQUALITY. `MainFreshness.containsOriginMain` asks "does local `main`
 * already contain the cached `origin/main`?", so the block lifts the instant a pull lands rather than
 * waiting for the detached refresher to catch up. It is the SAME object read-stale-guard uses — one
 * implementation, so the Read and Bash halves of one state can never disagree about whether the pull
 * took.
 *
 * FAIL-OPEN ON EVERYTHING NOT ESTABLISHED, logged as `ALLOW_FAIL_OPEN` so abstentions stay countable:
 * no cache (the first call of every session), a cache for another branch, an empty `originMain`
 * (offline), no local `main` at all (fresh clone / worktree), branch undeterminable. The refresher is
 * fired detached on every call to keep the cache warm for the NEXT one; it is never waited on, and no
 * synchronous `git fetch` is ever run on the blocking path.
 *
 * THE POLARITY INSIDE THE BLOCKED STATE IS UNCHANGED: default-DENY plus row 4's skip list, the shape
 * merged-branch-bash-guard uses for state B, via the same shared RecoveryAllowlist. A content-read
 * BLOCKLIST could not replace it — enumerating readers catches `cat` and `grep`, and structurally
 * cannot catch `pnpm install`, `npx expo install`, a formatter, codegen or a `>` redirect: commands
 * whose stated purpose is something else and whose effect is to modify tracked files. What changed is
 * WHEN that polarity applies, not the polarity.
 *
 *   BLOCKED   on a `main` known to be BEHIND: anything not on the skip list — builds, tests,
 *             installers, formatters, codegen, `cat`/`grep`/`ls` of the tree, git writes.
 *   ALLOWED   every command on a `main` that is current or whose freshness is unknown — and, in the
 *             blocked state, everything that gets you OUT or tells you where you are:
 *             `git checkout -b <new> origin/main`, `git switch`, `git pull`/`fetch`,
 *             `git status|log|diff|show|branch`, `git stash`, `gh` (it talks to GitHub, not to this
 *             tree), `curl`/`wget`, every `wp-*` bin, installs.
 *
 * ── ROWS 12/13: the cure may be COMPOSED with the work, but only with `&&` ───────────────────────
 *
 * `pnpm wp-sync-main && cat src/app.ts` is allowed and `pnpm wp-sync-main ; cat
 * src/app.ts` is not, and the difference is the shell's rather than this guard's: `&&` short-circuits,
 * so the work cannot run when the cure failed — the exact property the block is here to guarantee. `;`
 * discards the exit code and runs the work anyway. See cure-prefix-scan.ts for the measured shapes.
 *
 * There is no dirty-tree valve here and none in read-stale-guard either: the cure is
 * `git checkout -b`, which CARRIES uncommitted work onto the new branch, so a dirty tree traps nobody
 * in any L2 state. (`git stash` covers the residual where origin/main touched the same files.)
 */
export class StaleMainBashGuardRule extends BashRuleBase<BranchStateGuardConfig> {
    constructor(config: BranchStateGuardConfig) { super(config, 'stale-main-bash-guard', BRANCH_STATE_GUARD_KEY); }

    private readonly scanner = new CommandScanner();
    private readonly recovery = new TreeRecovery();
    private readonly switches = new BranchSwitchScan(this.scanner);
    // ROW 4, the skip list — the SAME instance-shape merged-branch-bash-guard uses, so the two states
    // cannot drift apart about what "gets you out" means. See recovery-allowlist.ts.
    private readonly recoveryList = new RecoveryAllowlist(this.scanner);
    // The ancestry test and the cache summary, shared with read-stale-guard — see main-freshness.ts.
    private readonly freshness = new MainFreshness();
    // ROWS 12/13 — `<cure> && <work>` vs `<cure> ; <work>`. See cure-prefix-scan.ts.
    private readonly curePrefix = new CurePrefixScan(this.scanner);

    readonly description =
        'Block a bare `git checkout main` (use `pnpm wp-sync-main`, or chain the pull into ' +
        'the same command), and — once local main is KNOWN to be behind origin/main — block Bash ' +
        'there, allowlisting only the commands that get you off it. A main that is current, or whose ' +
        'freshness is unknown, is left alone.';
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'Landing on `main` without pulling, or working on `main` at all, both put your work somewhere it does not belong.',
        'Get onto a feature branch, or go to main with the one command that pulls it too:',
        [
            // TREE-SHAPED, from the one source of tree-shaped cures. A static rule-level hint has no
            // workspace root, so it renders the 'unknown' kind — TreeRecovery's deliberate answer for
            // "we cannot detect the tree": both forms, each labelled. That matters here because the
            // primary-clone form goes to `main`, and a linked worktree has no `main` to go to — it is
            // checked out in the primary clone — so a preferred option naming it unconditionally hands
            // the AI a cure that cannot work where it is standing. The per-block message
            // (pairingMessage) is detected and prints exactly one form; this is the fallback for the
            // hint that cannot look.
            new Option(this.recovery.updateMainSteps('unknown').join('\n')
                + '\nIf you hand-roll the git instead, the pull must be in the SAME command as the checkout.', true),
            new Option('Already on main: pnpm wp-sync-main (then re-run) — it pulls main and takes the trash out in the one command this repo prescribes. You may chain your command onto it with && (pnpm wp-sync-main && <your command>), which is skipped if the pull fails; a ; instead runs your command anyway and is refused.'),
            new Option('Still allowed: every BASH command, on a main that is current or whose freshness is not known — this guard only closes once local main is known to be BEHIND origin/main. (Write/Edit on main is a different policy and is blocked by feature-branch-guard however current main is.) In that state you keep the Read tool while main is current (read-stale-guard closes it when main falls behind, because stale reads are worthless) plus everything that gets you OUT or tells you where you are: git checkout -b <new> origin/main, git switch, git pull/fetch, git status|log|diff|show|branch, git stash, gh, curl/wget, every wp-* bin, installs, and reading webpieces.config.json.'),
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

        return this.checkFreshness(ctx, branch);
    }

    /**
     * ROWS 6/7 — block ONLY when local `main` is KNOWN to be behind `origin/main`.
     *
     * Read this beside read-stale-guard.checkStaleMain: it is the same ladder over the same cache, and
     * that is on purpose — the Read and the Bash halves of one state must not disagree about whether
     * `main` is stale. What differs is the VERDICT SHAPE once it is stale, because a Read names one
     * file and a Bash command is opaque: the Read is judged per file, Bash is default-deny plus the
     * row 4 skip list already applied above.
     *
     * Every exit that is not "established BEHIND" is an ALLOW, and the not-established ones are
     * `ALLOW_FAIL_OPEN` so they stay countable. A guard that cannot see the state judges nothing.
     */
    private checkFreshness(ctx: BashContext, branch: string): readonly Violation[] {
        const status = readMainSyncStatus(ctx.workspaceRoot, 'main');
        // The first call of every session, and every call while another worktree holds the refresh
        // lock. The refresher fired above populates it for the NEXT call; nothing waits here.
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = this.freshness.summarize(status);
        // BELT-AND-BRACES since the cache became branch-keyed: we asked for the 'main' entry BY KEY, so
        // a mismatch means the map's key and the entry's own `branch` disagree — a shape bug. Kept so
        // that degrades to an allow. Unreachable in normal operation.
        if (status.branch !== 'main') return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);
        // Offline / origin unresolvable, or no local main to compare against.
        if (status.originMain === '') return this.failOpen(ctx, branch, 'origin-main-unknown', cache);

        // ANCESTRY, not equality — the line that makes a pull take effect immediately. See
        // MainFreshness.containsOriginMain.
        if (this.freshness.containsOriginMain(ctx.workspaceRoot, status.originMain)) {
            return this.allow(ctx, branch, 'local-main-contains-origin (up to date)', cache);
        }

        // ESTABLISHED BEHIND. Now — and only now — the default-deny polarity applies.
        return this.judgeComposition(ctx, branch, cache);
    }

    /**
     * ROWS 12/13 — `<cure> && <work>` is allowed; `<cure> ; <work>` is not.
     *
     * The distinction is the shell's, not this guard's invention. `&&` short-circuits, so the work
     * cannot run when the cure exits non-zero — which is precisely the property the block exists to
     * guarantee, already enforced by the interpreter. Refusing it bought nothing and cost a round
     * trip, and the fleet audit files that as a TOOLING defect.
     *
     * `;` discards the exit code and runs the work regardless, and it was measured with
     * `>/dev/null 2>&1` on the cure in 7 of 9 observed cases — so the failure was invisible as well as
     * ignored. The two-step is genuinely safer there: the NEXT tool call is a fresh evaluation that
     * recomputes `localMain` against `originMain`, so a pull that failed re-blocks. An allowed `;`
     * compound never gets that second look.
     */
    private judgeComposition(ctx: BashContext, branch: string, cache: string): readonly Violation[] {
        const prefix = this.curePrefix.classify(ctx.command);
        if (prefix.kind === 'short-circuits') {
            return this.allow(ctx, branch, 'cure-prefixed, && short-circuits the work', cache);
        }
        if (prefix.kind === 'runs-anyway') {
            return this.block(ctx, branch, 'cure-prefixed, work runs anyway', this.compositionMessage(prefix), cache);
        }
        return this.block(ctx, branch, 'on-stale-main', this.staleMainMessage(ctx.workspaceRoot), cache);
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
     * The stale-`main` deny. Deliberately SHORT, and now deliberately ABOUT STALENESS — which is what
     * the guard's name promised all along.
     *
     * The two versions before this one are both instructive. The oldest opened with how many commits
     * behind `main` was, which invited the wrong cure: an agent that reads "behind" reaches for a pull,
     * lands on a CURRENT `main`, and is still on `main`. The one after it swung the other way and said
     * `main` is not a place to work "whether or not it is current" — true of a WRITE, but this guard
     * does not see writes, and it made every refusal on a freshly-pulled `main` unanswerable.
     *
     * So the text says what is now actually true and nothing more: local `main` is BEHIND, so what you
     * read here is out of date; Bash is default-deny in this state rather than a list of readers,
     * because a command's stated purpose never says whether it also WRITES; and the branch cure fetches,
     * so it makes the reads true as well as moving the work somewhere reviewable. Reading `main` to PLAN
     * stays legitimate — on a CURRENT `main` nothing here fires at all.
     *
     * ONE cure, and it is the dirty-safe one, the same call feature-branch-guard made: `git checkout -b`
     * carries uncommitted work onto the new branch. (Row 6 also lists the pull, and read-stale-guard
     * prints it, because a Read really can be cured by staying put. A Bash session cannot — the next
     * command is as likely to write as to read.)
     */
    private staleMainMessage(workspaceRoot: string): string {
        return 'Blocked: local `main` is BEHIND origin/main, so what you would read here is out of '
            + 'date and a plan built on it is built on code upstream has moved past. A CURRENT main is '
            + 'not blocked — reading main to PLAN is fine, and this fires only once being behind is '
            + 'established. Bash is default-deny in this state rather than a list of readers, because a '
            + "command's stated purpose never says whether it also WRITES. The feature branch is the "
            + 'unit of work in any case: reviewable, revertable — and the cure fetches, so it makes '
            + 'your reads true as well as moving you off main.\n'
            + `Start a branch (uncommitted work comes with you):\n  cd '${workspaceRoot}' && git fetch origin main && git checkout -b <new-branch> origin/main`;
    }

    /**
     * ROW 13's deny. It NAMES the operator the agent typed, because the fix is a one-character edit
     * and an agent told only "use `&&`" has to diff the two spellings itself to find where.
     */
    private compositionMessage(prefix: CurePrefix): string {
        return `Your cure is joined with \`${prefix.operator}\` — the work runs even if the pull fails. `
            + 'Use `&&` so it is skipped:\n'
            + '\n    pnpm wp-sync-main && <your command>\n\n'
            + 'Or run the cure alone and re-issue your command in the next call.';
    }

    private pairingMessage(ctx: BashContext): string {
        const steps = this.recovery.updateMainSteps(this.recovery.kindOf(ctx.workspaceRoot)).join('\n');
        // Deliberately SHORT. The incident that bought this guard (a main 157 commits behind; the
        // downgrade the reverted shim then prescribed) is maintainer material and lives in the class
        // docblock above — the reader of THIS text needs only what changes what they type.
        return 'Blocked: a bare `git checkout main` lands you on whatever local `main` you last had — '
            + 'stale files, plus a reverted @webpieces pin and guard shim, so the drift guard then '
            + 'reports the drift BACKWARDS. Go to main with the one command that also pulls it:\n' + steps;
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
