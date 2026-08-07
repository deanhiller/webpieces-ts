import { execSync } from 'child_process';

import { WholeRepoBuildGuardConfig, DEFAULT_BUILD_COMMAND, HomeConfigService } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { toError } from '../to-error';
import { logGuardDecision, GuardDecision } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { WholeRepoBuildScan, WholeRepoBuildHit } from './whole-repo-build-scan';

/**
 * Blocks a Bash command that would build or test the WHOLE monorepo, and hands back the narrow
 * command to run instead. Which shapes count is `WholeRepoBuildScan`'s job; this rule owns the
 * decision, the log line and the two refusal messages.
 *
 * ─── Why: SCOPE and AGREEMENT, not a speed claim ───────────────────────────────────────────────────
 * `nx affected --target=ci --base=<fork point>` is the command the PR gate itself runs
 * (`commands.pr-gate.buildCommand`), so a green local result is evidence about the gate. A whole-repo
 * build is a different, wider command whose green says nothing extra — it just also compiles projects
 * the change cannot reach.
 *
 * It is NOT automatically faster, and this guard deliberately does not claim it is. Measured on a
 * `core-util` change, `affected` selected the IDENTICAL 20 projects / 104 tasks as the whole-repo
 * build: a package at the BASE of the dependency graph prunes nothing. The pruning win is real for
 * LEAF projects and absent for base ones. The long builds people blamed on scope were caused by a cold
 * nx cache and by CPU contention between agents running full sweeps at once (measured: ~3.2x total
 * test time under contention) — neither of which a narrower target list fixes on its own.
 *
 * So what this guard buys is the scope being right by default. Building the world is never the
 * correct inner-loop move in a monorepo; the correct one has existed all along, and nothing stopped
 * the wide one.
 *
 * ─── The message is READ FROM CONFIG, and it is RESOLVED ───────────────────────────────────────────
 * The replacement command comes from `commands.pr-gate.buildCommand` (injected into this guard's
 * config by load-config), so the refusal follows the project when the gate command changes. The `$(…)`
 * in it is EXPANDED before printing: handing an agent `--base=$(git merge-base origin/main HEAD)` is
 * handing it a template, and a template pasted where no shell expands it produces a confusing failure
 * that reads like the guard's advice was wrong. Only `$(git …)` is expanded, and only read-only git;
 * anything else is left verbatim.
 *
 * ─── Two messages, chosen by ~/.webpieces/config.json ──────────────────────────────────────────────
 * With `experimental.buildGateLogCapture` ON, the pr-gate captures its build's full output to a log
 * file and hands the agent that path instead of a rebuild instruction — so the right advice is not
 * "build smaller", it is "do not build; stage ② already builds and you can READ the result". That flag
 * lives in the OPTIONAL machine-local `~/.webpieces/config.json`; absent (the state of essentially
 * every consumer) means the first message. `HomeConfigService` is the one reader of that file.
 *
 * ─── Humans are not affected, by construction ──────────────────────────────────────────────────────
 * This is a PreToolUse hook. It sees the AI's Bash tool calls and nothing else — a human typing
 * `pnpm run build-all` in their own terminal never reaches a hook, and the `build-all` script itself is
 * deliberately left in package.json for exactly that reason. The guard is about what the AI does in a
 * loop, not about the command being wrong for a person who chooses to run it once.
 */
export class WholeRepoBuildGuardRule extends BashRuleBase<WholeRepoBuildGuardConfig> {
    constructor(config: WholeRepoBuildGuardConfig) { super(config, 'whole-repo-build-guard'); }

    private readonly scanner = new CommandScanner();
    private readonly homeConfig = new HomeConfigService();

    readonly description =
        'Block a whole-monorepo build (build-all, an unnarrowed nx run-many, nx affected with no ' +
        '--base, a bare vitest run) and name the affected-scoped command to run instead.';

    /**
     * The command this rule last printed, so the fix hint and the violation message are one string and
     * cannot disagree. Empty until check() runs (fixHint is also read without it), at which point the
     * getter falls back to the configured TEMPLATE — never to a second literal, which is exactly the
     * drift this guard's own docstring says a duplicated command string causes.
     */
    private resolvedCommand = '';

    get fixHint(): FixHint {
        const command = this.resolvedCommand !== '' ? this.resolvedCommand : this.buildCommandTemplate();
        return new FixHint(
            'That command builds the WHOLE monorepo. Build only what your change affects.',
            'Build the affected projects, or one project, or one spec file — never the workspace:\n' +
            `  ${command}   # the gate's own build\n` +
            '  pnpm nx run <project>:ci   # one project\n' +
            '  pnpm exec vitest run <path>   # one suite\n' +
            'Disable in webpieces.config.json under hookGuards → whole-repo-build-guard (mode OFF) if intentional.',
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        // Blocklist-shaped, so match on commandCode: stripping heredocs and quoted prose can only ever
        // block LESS, and this repo's own commit messages are full of the command names above.
        const hit = new WholeRepoBuildScan(this.scanner, ctx.effectiveCwd === ctx.workspaceRoot)
            .firstHit(ctx.commandCode);
        if (hit === null) return this.allow(ctx, 'not-a-whole-repo-build');

        // Resolved ONCE, here, and read by both the violation message and the fix hint.
        this.resolvedCommand = this.resolvedBuildCommand(ctx.workspaceRoot);
        return this.block(ctx, hit, this.message());
    }

    // The whole refusal. Short on purpose: it is read mid-task by an agent that needs the ONE command
    // to run next, and a guard message long enough to skim is a guard message that gets skimmed.
    private message(): string {
        if (this.captureEnabled()) {
            return 'Blocked: that builds the WHOLE monorepo — and you should not be building at all.\n'
                + '`pnpm wp-review-upsert-pr` (stage ②) runs the build for you, captures the full output to a\n'
                + 'log file, and names that file if it fails. Read the file; do not rebuild.\n'
                + 'Need a check before then: pnpm exec vitest run <path>.';
        }
        return 'Blocked: that builds the WHOLE monorepo. Build only what your change affects:\n\n'
            + `    ${this.resolvedCommand}\n\n`
            + 'Narrower still: pnpm nx run <project>:ci, or pnpm exec vitest run <path>.';
    }

    /**
     * The project's build command, unexpanded. ONE source: `commands.pr-gate.buildCommand`, injected
     * into this guard's config by load-config exactly as the other guards' command hints are, falling
     * back to the same DEFAULT_BUILD_COMMAND the gate itself falls back to. This guard never spells a
     * build command of its own — a second copy is how a refusal starts teaching a command the gate
     * does not run.
     */
    private buildCommandTemplate(): string {
        const configured = this.config.affectedBuildCommand ?? '';
        return configured.trim() === '' ? DEFAULT_BUILD_COMMAND : configured;
    }

    /**
     * The configured build command with its `$(git …)` substitutions expanded, so what is printed is
     * runnable as-is. Expansion is limited to git, and any failure leaves the template untouched — a
     * guard may degrade its own message, never fail the tool call it is judging.
     */
    private resolvedBuildCommand(workspaceRoot: string): string {
        const template = this.buildCommandTemplate();
        return template.replace(/\$\(([^()]*)\)/g, (match: string, inner: string): string => {
            const trimmed = inner.trim();
            if (!trimmed.startsWith('git ')) return match;
            const output = this.capture(trimmed, workspaceRoot);
            return output === null ? match : output;
        });
    }

    private capture(command: string, workspaceRoot: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return execSync(command, {
                cwd: workspaceRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * Is build-log capture on? The OPTIONAL `~/.webpieces/config.json` is absent for essentially every
     * consumer, and absent means false, silently — so a broken or unreadable home config can never be
     * the reason a Bash command is judged differently. Fail toward the ordinary message.
     */
    private captureEnabled(): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return this.homeConfig.load().buildGateLogCapture;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    private allow(ctx: BashContext, reason: string): readonly Violation[] {
        this.logDecision(ctx, 'ALLOW', reason);
        return [];
    }

    private block(ctx: BashContext, hit: WholeRepoBuildHit, message: string): readonly Violation[] {
        this.logDecision(ctx, 'BLOCK', hit.shape);
        return [new V(1, this.truncate(ctx.command), message)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, verdict: 'ALLOW' | 'BLOCK', reason: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('whole-repo-build-guard', 'Bash', ctx.command, '-', verdict, reason, '-'),
        );
    }
}
