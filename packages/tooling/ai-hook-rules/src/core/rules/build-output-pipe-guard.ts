import { Option } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase, EmptyRuleConfig } from '../rule-base';
import { FixHint } from '../fix-hint';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { logGuardDecision, GuardDecision, Verdict, MATRIX_L2_UNROWED } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { ShellSegmentScan } from './shell-segment-scan';
import {
    BuildOutputPipeScan, BoundedOutputHit, BOUND_BY_PIPE,
} from './build-output-pipe-scan';

/**
 * Blocks a Bash command that PIPES or REDIRECTS the output of `pnpm wp-build`,
 * `pnpm wp-review-upsert-pr` or `pnpm wp-finish-upsert-pr`, and hands back the bare command plus a
 * `grep` of the log those commands already write.
 *
 * ─── The incident, measured ────────────────────────────────────────────────────────────────────────
 * The Claude Code harness backgrounds — and then kills — a foreground Bash command that has produced
 * no output for 600 seconds. Those three commands defend against that already: the build's output goes
 * to a FILE, and the console gets a heartbeat roughly every ten seconds plus a `FullLog :` pointer.
 *
 * A PIPE deletes that defence. `pnpm wp-review-upsert-pr 2>&1 | tail -50` withholds every byte until
 * the writer exits, because that is what `tail` is — so the terminal sees NOTHING for the length of a
 * full build, the watchdog fires, and the work is thrown away. The last fleet audit attributed ≥100
 * minutes of wall time to those kills across 8 agents, and this repo's primary tree alone holds 85
 * piped `wp-*` calls, 42 of them on a build-running command (`wp-review-upsert-pr` 22,
 * `wp-finish-upsert-pr` 17, `wp-build` 3).
 *
 * A `> file` redirect is the same silence, and additionally writes a second copy of a log the command
 * already wrote.
 *
 * ─── Why the ORDER of the fix matters, and why this half came second ───────────────────────────────
 * Agents pipe these commands for a REASON: stage ② and stage ③ used to print everything they did. So
 * the output was shrunk FIRST — both stages now capture their verbose body to a log and keep only the
 * lines an agent must act on (see `StageOutputLog` in @webpieces/pr-gate). Blocking the pipe before
 * that would have traded a watchdog kill for a flooded context, and an agent would have routed around
 * it with `> file` — which is why the redirect is on the blocklist too.
 *
 * ─── It acts UNCONDITIONALLY, and has NO config key ────────────────────────────────────────────────
 * Like `commit-message-substitution-guard`, and for the same two reasons.
 *
 * It has no key because a NEW key under `hookGuards` is a key every consumer must ADD or have every
 * Bash call blocked on upgrade (fault Y) — that shipped once already, with `whole-repo-build-guard`,
 * and took upgrading consumers' shells down for a feature nobody had asked for. Loading here, outside
 * the config-driven set, makes the config-sync check structurally unable to see it.
 *
 * It needs no switch because there is nothing for one to rescue: the cure is available for every
 * input, is strictly better than what was blocked, and can never itself match this guard. Running the
 * command bare gives you a heartbeat instead of silence and a log you can `grep` any number of times
 * instead of a fixed 50 lines you have to re-run a build to change.
 */
export class BuildOutputPipeGuardRule extends BashRuleBase<EmptyRuleConfig> {
    constructor() {
        // configKey === name and is DELIBERATELY not a real webpieces.config.json key — see the class
        // docstring on fault Y.
        super(new EmptyRuleConfig(), 'build-output-pipe-guard', 'build-output-pipe-guard');
    }

    private readonly scan = new BuildOutputPipeScan(new CommandScanner(), new ShellSegmentScan());

    readonly description =
        'Block piping or redirecting the output of pnpm wp-build / wp-review-upsert-pr / ' +
        'wp-finish-upsert-pr — a pipe withholds their heartbeat until exit, so the 600s watchdog kills ' +
        'the build — and name the bare command plus a grep of the log they already write.';

    get fixHint(): FixHint {
        return new FixHint(
            'Piping one of these commands hides the heartbeat that proves it is alive, and the harness ' +
            'kills a command that has printed nothing for 600 seconds — after a full build has run.',
            'Their output is ALREADY in a file. Run the command bare and read the file it names:',
            [
                // Names NO command. `fixHint` is static per-rule and cannot see which command was
                // actually piped, while `message(hit)` above already prints that exact command bare —
                // so hardcoding one here spelled `wp-build` at somebody who piped `wp-review-upsert-pr`,
                // which is a cure that does not match the block. One statement of the command, in the
                // one place that knows it.
                new Option(
                    'Re-run the command named above with nothing after it — no pipe, no redirect.\n' +
                    'The console stays short — a size heartbeat, then the result and a "FullLog : <path>" line.',
                    true),
                new Option(
                    'Then read as much or as little of that log as you like, as many times as you like:\n' +
                    '    grep -n error "<the FullLog path it printed>"\n' +
                    '    tail -50 "<the FullLog path it printed>"\n' +
                    'Use the path from THIS run, never one typed from memory — a stale relative path ' +
                    'greps nothing, which reads exactly like a clean build.'),
                new Option(
                    'The previous run is still on disk as "<that path>.bak", so comparing two runs ' +
                    'needs no third one.'),
            ],
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        // Blocklist-shaped, so match on commandCode: stripping heredocs and quoted prose can only ever
        // block LESS, and this repo's own commit messages and docs are full of these command names.
        const hit = this.scan.firstHit(ctx.commandCode);
        if (hit === null) return this.allow(ctx);
        return this.block(ctx, hit);
    }

    private allow(ctx: BashContext): readonly Violation[] {
        this.logDecision(ctx, 'ALLOW', 'output-not-bounded');
        return [];
    }

    private block(ctx: BashContext, hit: BoundedOutputHit): readonly Violation[] {
        // BLOCK_AI_CURE: the cure is the SAME command with less typing, which the agent runs itself.
        this.logDecision(ctx, 'BLOCK_AI_CURE', `${hit.command}-${hit.shape}`);
        return [new V(1, this.truncate(ctx.command), this.message(hit))];
    }

    // Short on purpose: it is read mid-task by an agent that needs the ONE next move.
    private message(hit: BoundedOutputHit): string {
        return `Blocked: ${this.what(hit)} \`${hit.command}\`. That command already writes its full output `
            + 'to a log file and prints a heartbeat while it runs — and bounding it withholds every byte '
            + 'until the command exits, so the harness sees a silent command and KILLS it at 600s, after '
            + 'the whole build has run.\n\n'
            + `    pnpm ${hit.command}\n\n`
            + 'Then grep the "FullLog : <path>" it prints. The previous run is kept beside it as `.bak`.';
    }

    private what(hit: BoundedOutputHit): string {
        return hit.shape === BOUND_BY_PIPE ? 'you piped' : 'you redirected the output of';
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, verdict: Verdict, reason: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision(
                'build-output-pipe-guard', 'Bash', ctx.command, '-', verdict, reason,
                '-', L0_FAULT_NONE, MATRIX_L2_UNROWED,
            ),
        );
    }
}
