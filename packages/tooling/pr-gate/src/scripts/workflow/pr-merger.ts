import { spawnSync } from 'child_process';
import { MERGE_MODE_AUTO, MERGE_MODE_NONE } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * The five terminal shapes a merge attempt can take. The CALLER branches on these — a `message` string
 * is for humans to read, never for code to pattern-match, and the banner that frames it must be able to
 * tell "done" from "stranded" without parsing prose.
 */
export const MERGE_RESULT_MERGED = 'MERGED';
/** Not merged YET, but queued: auto-merge is enabled and lands it when the checks pass. Self-healing. */
export const MERGE_RESULT_AUTO_QUEUED = 'AUTO_QUEUED';
/** Not merged BY DESIGN: pr-gate.mergeMode is not AUTO, so a person merges. Nothing is owed here. */
export const MERGE_RESULT_LEFT_TO_HUMAN = 'LEFT_TO_HUMAN';
/**
 * Not merged and it NEVER will be without action: `gh pr view --json mergeStateStatus` says BEHIND, i.e.
 * the head branch is out of date with base. Unlike BLOCKED (waiting on checks — self-healing), BEHIND
 * cannot resolve itself; the branch must be re-synced from main. This is the case that used to print a
 * green "✅ PR finished" and get abandoned.
 */
export const MERGE_RESULT_BEHIND = 'BEHIND';
/**
 * BEHIND *and* GitHub says the tree merges cleanly (`mergeable: MERGEABLE`). Nobody touched the same
 * lines — somebody simply landed on main first. One clean re-run of ①②③ converges. Split out from the
 * conflicting case because the two need completely different sentences: this one is not the author's
 * problem to solve, it is a queue collision, and telling them "resolve the conflict" is a lie.
 */
export const MERGE_RESULT_BEHIND_CLEAN = 'BEHIND_CLEAN';
/**
 * BEHIND *and* `mergeable: CONFLICTING` — the landed work and this branch touch the same lines. Real
 * human/AI judgement is owed, and if others keep landing first it genuinely repeats. That is inherent to
 * concurrent editing, not a defect, and the banner says so rather than pretending a re-run is free.
 */
export const MERGE_RESULT_BEHIND_CONFLICTING = 'BEHIND_CONFLICTING';
/**
 * BEHIND but `mergeable: UNKNOWN` (or unreadable). GitHub computes mergeability ASYNCHRONOUSLY and we ask
 * moments after a force-push, so UNKNOWN is the EXPECTED answer, not an error. Diagnosing from it would be
 * guessing, so this outcome asks for a re-check instead of prescribing a remedy.
 */
export const MERGE_RESULT_BEHIND_UNKNOWN = 'BEHIND_UNKNOWN';
/** Not merged for some other reason (config mismatch, gh error, no PR at all). Read `message`. */
export const MERGE_RESULT_FAILED = 'FAILED';

// The `mergeStateStatus` value GitHub reports for "head branch is not up to date with the base branch".
const GH_STATE_BEHIND = 'BEHIND';
// `mergeable` values. GitHub returns UNKNOWN while it is still computing the merge — which is most of the
// time in the seconds after a push — so UNKNOWN must never be read as "no conflicts".
const GH_MERGEABLE_CLEAN = 'MERGEABLE';
const GH_MERGEABLE_CONFLICTING = 'CONFLICTING';

// What actually happened when we tried to land the squash merge. `message` is printed VERBATIM in the
// final wp-finish-upsert-pr summary, so a merge that did not happen can never be reported as done —
// the old code ignored `spawnSync().status` entirely and printed "✅ PR finished" even when `gh pr
// merge` had errored out, which is what hid the auto-merge-disabled failure for weeks. `result` is the
// machine-readable half of the same honesty: the banner picks its HEADER from it, so the frame around
// the message can no longer say "finished" while the message says "did NOT merge".
export class MergeOutcome {
    merged: boolean;
    autoMergeEnabled: boolean;
    message: string;
    result: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(merged: boolean, autoMergeEnabled: boolean, message: string, result: string) {
        this.merged = merged;
        this.autoMergeEnabled = autoMergeEnabled;
        this.message = message;
        this.result = result;
    }

    // TRUE for every flavour of "the branch is out of date with main", so the banner can ask that one
    // question once instead of listing four constants at each branch point. Kept here rather than as a
    // module function because `no-function-outside-class` forbids the latter — and PrMergeState below
    // already sets the precedent that a verdict class answers questions about itself.
    isBehind(): boolean {
        return this.result === MERGE_RESULT_BEHIND
            || this.result === MERGE_RESULT_BEHIND_CLEAN
            || this.result === MERGE_RESULT_BEHIND_CONFLICTING
            || this.result === MERGE_RESULT_BEHIND_UNKNOWN;
    }
}

// GitHub's own verdict on the PR, straight from `gh pr view --json mergeable,mergeStateStatus,state`.
// All '' when gh could not be asked — an unreadable answer must never be treated as a diagnosis.
export class PrMergeState {
    mergeable: string;
    mergeStateStatus: string;
    state: string;

    constructor(mergeable: string, mergeStateStatus: string, state: string) {
        this.mergeable = mergeable;
        this.mergeStateStatus = mergeStateStatus;
        this.state = state;
    }

    isBehind(): boolean {
        return this.mergeStateStatus === GH_STATE_BEHIND;
    }

    /**
     * WHICH kind of BEHIND this is, from the `mergeable` field we have always fetched and never read.
     *
     * This is the whole point of the split. "Out of date" and "conflicting" are different situations with
     * different costs, and collapsing them told every author the expensive story: a clean queue collision
     * — nobody touched your lines, somebody just landed first — got reported in the same alarming words as
     * a genuine textual conflict.
     *
     * UNKNOWN is its own answer, never folded into CLEAN. GitHub computes mergeability asynchronously and
     * we ask seconds after a force-push, so UNKNOWN is the ordinary reply in exactly our situation.
     * Treating it as "no conflicts" would promise a clean re-run we cannot see.
     */
    behindKind(): string {
        if (this.mergeable === GH_MERGEABLE_CLEAN) return MERGE_RESULT_BEHIND_CLEAN;
        if (this.mergeable === GH_MERGEABLE_CONFLICTING) return MERGE_RESULT_BEHIND_CONFLICTING;
        return MERGE_RESULT_BEHIND_UNKNOWN;
    }

    // One-line rendering for the failure message, or '' when GitHub could not be asked.
    describe(): string {
        if (this.mergeStateStatus === '') return '';
        return `mergeable=${this.mergeable}, mergeStateStatus=${this.mergeStateStatus}, state=${this.state}`;
    }
}

/**
 * Lands — or queues — the squash merge with an EXPLICIT subject/body, on BOTH kinds of repo:
 *
 * - auto-merge ALLOWED (`allow_auto_merge: true`): a PR whose checks are still running falls back to
 *   the auto-merge queue, carrying the same subject/body so it lands when the checks pass.
 * - auto-merge DISALLOWED (`allow_auto_merge: false`, a deliberate policy control in many orgs): the
 *   direct merge still works the moment the PR is mergeable, because `gh pr merge --squash --subject
 *   --body-file` does not depend on that setting at all. When the PR is NOT yet mergeable there is no
 *   queue to fall back to, so we say so loudly instead of firing a `--auto` that can only fail.
 *
 * WHICH of those a repo gets is not guessed — `pr-gate.mergeMode` is REQUIRED config. AUTO means the
 * tooling lands PRs; NONE means it only posts them and a person merges. No mode can force a queue the
 * repo has turned off, so AUTO on a repo with allow_auto_merge=false is a CONFIG error, reported as
 * one rather than papered over.
 *
 * Every `gh` status is checked. Nothing here is allowed to fail silently.
 */
@injectable(bindingScopeValues.Singleton)
export class PrMerger {
    /**
     * @param subject       the squash-commit subject, normally `<PR title> (#N)`
     * @param mergeBodyFile file holding the squash-commit body (risk/flags/PR link)
     * @param mergeMode     pr-gate.mergeMode from webpieces.config.json — AUTO or NONE. Anything else
     *                      (including a repo still on a published rules-config that predates the field)
     *                      is treated as NONE: when the policy is unreadable, do NOT touch main.
     */
    merge(baseBranch: string, subject: string, mergeBodyFile: string, mergeMode: string): MergeOutcome {
        // Anything that is not an explicit AUTO leaves the PR alone. The PR itself is already
        // posted/updated by this point, which is the whole job in this mode.
        if (mergeMode !== MERGE_MODE_AUTO) {
            return new MergeOutcome(false, false,
                `did NOT merge — pr-gate.mergeMode is ${mergeMode === MERGE_MODE_NONE ? 'NONE' : `"${mergeMode}"`}, so the PR is left for a human to merge.\n` +
                `      Subject GitHub will use is its own (squash_merge_commit_title), NOT: "${subject}"`,
                MERGE_RESULT_LEFT_TO_HUMAN);
        }

        // A direct `gh pr merge --squash --subject --body-file` writes exactly this subject/body to
        // main's history regardless of the repo's squash_merge_commit_title/message defaults — and
        // regardless of allow_auto_merge. It is the ONLY path that guarantees the good commit message.
        //
        // Its output is CAPTURED, not inherited: this attempt fails BY DESIGN on any repo whose policy
        // forbids a direct merge, and gh's raw `X Pull request #N is not mergeable: …` on the terminal
        // read as a hard failure to every human and agent who saw it. We reprint the reason ourselves,
        // framed as the expected first step of a two-step dance (see announceDirectFailure).
        const direct = this.ghCapture(['pr', 'merge', baseBranch, '--squash', '--subject', subject, '--body-file', mergeBodyFile]);
        if (direct.status === 0) {
            process.stdout.write(direct.output);
            return new MergeOutcome(true, false, `squash-merged the PR as: "${subject}"`, MERGE_RESULT_MERGED);
        }

        // Past here the PR is not mergeable yet. WHY matters enormously and gh's exit status does not
        // say: checks-still-running (BLOCKED) is self-healing once auto-merge is on, while out-of-date
        // (BEHIND) can NEVER land unattended. Ask GitHub itself — one cheap, failure-tolerant call, made
        // only on the failure path, so a run whose direct merge succeeded costs no extra API call.
        const state = this.prMergeState(baseBranch);
        this.announceDirectFailure(direct.output, state);
        return this.fallBackToAutoMerge(baseBranch, subject, mergeBodyFile, state);
    }

    /**
     * The auto-merge queue: the only way to still land a not-yet-mergeable PR unattended. Returns the
     * BEHIND outcome regardless of how queuing went whenever GitHub says the branch is out of date —
     * queuing a BEHIND PR is not an error (a repo that auto-updates branches will still land it), but it
     * is NOT success either, and reporting it as such is precisely the bug this whole file guards.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private fallBackToAutoMerge(baseBranch: string, subject: string, mergeBodyFile: string, state: PrMergeState): MergeOutcome {
        if (!this.autoMergeAllowed()) {
            if (state.isBehind()) return this.behindOutcome(state, false);
            return new MergeOutcome(false, false,
                '⚠️  did NOT merge, and queued NOTHING — CONFIG MISMATCH: pr-gate.mergeMode is AUTO, but\n' +
                '      this repo has allow_auto_merge=false, so there is no queue to fall back to and the\n' +
                '      PR is not mergeable yet. `gh pr merge --auto` cannot override a repo that says no.\n' +
                '      Fix it at ONE of the two ends: turn on "Allow auto-merge" in the repo settings, or\n' +
                '      set commands.pr-gate.mergeMode to "NONE" (and set that repo\'s\n' +
                '      squash_merge_commit_title to PR_TITLE so a human merge still gets a real subject).',
                MERGE_RESULT_FAILED);
        }

        process.stdout.write('   … retrying with --auto (the auto-merge queue)\n');
        // gh records the merge subject/body only at the moment auto-merge is FIRST enabled; a second
        // `--auto` on an already-enabled PR silently keeps the OLD body. Disabling first re-stamps the
        // current subject/body on every re-run (a harmless no-op when auto-merge is not enabled).
        this.gh(['pr', 'merge', baseBranch, '--disable-auto'], true);
        const auto = this.gh(['pr', 'merge', baseBranch, '--auto', '--squash', '--subject', subject, '--body-file', mergeBodyFile]);
        if (auto !== 0) {
            if (state.isBehind()) return this.behindOutcome(state, false);
            return new MergeOutcome(false, false,
                '⚠️  did NOT merge and could NOT enable auto-merge either (see the gh error above) —\n' +
                '      NOTHING is queued. Re-run once the PR is healthy.',
                MERGE_RESULT_FAILED);
        }
        if (state.isBehind()) return this.behindOutcome(state, true);
        return new MergeOutcome(false, true,
            `enabled auto-merge — it will squash-merge as "${subject}" when the checks pass`,
            MERGE_RESULT_AUTO_QUEUED);
    }

    /**
     * The one outcome that looks queued but is stranded. `queued` says whether auto-merge did get enabled,
     * because "parked forever" and "not queued at all" need different sentences — but neither is done.
     *
     * The `result` now carries WHICH kind of behind, so the banner can stop describing a queue collision
     * in the vocabulary of a merge conflict. The wording here is deliberately blame-free: nothing the
     * author did caused this, and the PR itself is in perfectly good shape — pushed, bodied, gate-green.
     */
    private behindOutcome(state: PrMergeState, queued: boolean): MergeOutcome {
        const parked = queued ? 'Auto-merge is enabled but parked.' : 'Nothing is queued.';
        return new MergeOutcome(false, queued,
            `did NOT merge — someone else landed on main first, so GitHub wants this branch rebuilt on\n` +
            `      top of theirs before it will merge (${state.describe()}).\n` +
            `      This does NOT self-heal: auto-merge never updates your branch. ${parked}`,
            state.behindKind());
    }

    // Reprint the expected first-attempt failure as CONTEXT, not as a verdict. gh's own `X …` line is
    // captured (never inherited) so this framing is the only thing on screen.
    private announceDirectFailure(ghOutput: string, state: PrMergeState): void {
        const reason = ghOutput.trim().split('\n').filter((l: string): boolean => l.trim() !== '').pop() ?? '';
        process.stdout.write(
            'ℹ️  the direct squash-merge did not go through (expected while checks run, or when repo\n' +
            '   policy forbids direct merges):\n' +
            (reason === '' ? '' : `      ${reason}\n`) +
            (state.describe() === '' ? '' : `   GitHub says: ${state.describe()}\n`),
        );
    }

    /**
     * GitHub's own verdict on the PR. AUTHORITATIVE for the BEHIND check — the alternative is
     * pattern-matching gh's English error prose, which changes between releases. Failure-tolerant on
     * purpose: a gh hiccup returns an all-'' state (never BEHIND) so a transient API blip can only cost
     * us the extra diagnosis, never turn a working run into a crash.
     */
    protected prMergeState(baseBranch: string): PrMergeState {
        const result = spawnSync(
            'gh',
            ['pr', 'view', baseBranch, '--json', 'mergeable,mergeStateStatus,state',
                '--jq', '"\\(.mergeable)\\t\\(.mergeStateStatus)\\t\\(.state)"'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) return new PrMergeState('', '', '');
        const parts = (result.stdout ?? '').trim().split('\t');
        return new PrMergeState(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
    }

    // Whether `gh pr merge --auto` is even possible on this repo. Many orgs set allow_auto_merge=false
    // as a policy control, where `--auto` can only ever fail with `GraphQL: Auto merge is not allowed
    // for this repository`. One API call beats discovering that from an error string. Anything other
    // than a clean `true` counts as NOT allowed: if the setting cannot be read we must not claim the
    // queue is available.
    protected autoMergeAllowed(): boolean {
        const result = spawnSync('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'], { encoding: 'utf8' });
        return result.status === 0 && (result.stdout ?? '').trim() === 'true';
    }

    // Runs `gh`, returning its exit status (-1 when gh could not be spawned at all, which must NOT be
    // mistaken for the 0 that means success).
    protected gh(args: string[], quiet: boolean = false): number {
        const result = spawnSync('gh', args, { stdio: quiet ? 'ignore' : 'inherit' });
        return result.status ?? -1;
    }

    // Runs `gh` CAPTURING both streams instead of inheriting them, so an expected-to-fail attempt can be
    // reported in our own words rather than dumping a raw `X …` line the reader reads as fatal.
    protected ghCapture(args: string[]): GhResult {
        const result = spawnSync('gh', args, { encoding: 'utf8' });
        return new GhResult(result.status ?? -1, (result.stdout ?? '') + (result.stderr ?? ''));
    }
}

// A captured `gh` invocation: its exit status (-1 when gh could not be spawned) and both streams
// combined, in the order a terminal would have shown them.
export class GhResult {
    status: number;
    output: string;

    constructor(status: number, output: string) {
        this.status = status;
        this.output = output;
    }
}
