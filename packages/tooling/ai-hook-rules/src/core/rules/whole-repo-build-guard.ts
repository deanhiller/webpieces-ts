import { execSync } from 'child_process';

import { DEFAULT_BUILD_COMMAND, HomeConfig, HomeConfigService, InformAiError } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase, EmptyRuleConfig } from '../rule-base';
import { FixHint } from '../fix-hint';
import { toError } from '../to-error';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { logGuardDecision, GuardDecision, Verdict, MATRIX_L2_UNROWED } from '../decision-log';
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
 * ─── EXPERIMENTAL: the ONLY switch is ~/.webpieces/config.json ─────────────────────────────────────
 * `experimental.whole-repo-build-guard` (a boolean) decides whether this guard blocks anything at all.
 * There is NO webpieces.config.json entry — deliberately, and the reason is a live incident: this guard
 * first shipped as an ordinary validated guard with `mode: 'ON'` by default AND a required entry under
 * `hookGuards`, so every consumer that upgraded hit fault Y — EVERY Bash call blocked — for a feature
 * they had never asked for. An experimental feature is opted into from a machine-local file whose absent
 * state is byte-for-byte the old behaviour, or it is not experimental.
 *
 * Three states, and only three:
 *   - the file does not exist (essentially every consumer) → this guard is INERT. It blocks nothing and
 *     logs nothing, for every command, including the ones it would otherwise refuse.
 *   - the file exists and defines the key → the key's value decides.
 *   - the file exists but does NOT define the key → the guard is OFF, exactly as if there were no file.
 *     Every key in that file is optional, because it is MACHINE-GLOBAL and the repos on one machine pin
 *     different webpieces releases — a required key there is unsatisfiable (see home-config.ts). The
 *     default can only fail towards "never opted in", which is the safe direction.
 *   - the file exists and is unparseable, or a key it DOES define has the wrong type → HARD FAILURE
 *     naming the edit. That is a file somebody wrote wrongly, not one written for another release.
 *     Editing that file is an unconditional PASS in the guards, so the block is always self-curable.
 *
 * ─── Two messages, chosen by a DIFFERENT key ───────────────────────────────────────────────────────
 * `experimental.buildGateLogCapture` is a separate feature (the pr-gate captures its build's full output
 * to a log file and hands the agent that path instead of a rebuild instruction) and it is NOT this
 * guard's switch. It only picks WHICH refusal is printed once the guard is on: with capture ON the right
 * advice is not "build smaller", it is "do not build; stage ② already builds and you can READ the
 * result". `HomeConfigService` is the one reader of both keys.
 *
 * ─── Humans are not affected, by construction ──────────────────────────────────────────────────────
 * This is a PreToolUse hook. It sees the AI's Bash tool calls and nothing else — a human typing
 * `pnpm run build-all` in their own terminal never reaches a hook, and the `build-all` script itself is
 * deliberately left in package.json for exactly that reason. The guard is about what the AI does in a
 * loop, not about the command being wrong for a person who chooses to run it once.
 */
export class WholeRepoBuildGuardRule extends BashRuleBase<EmptyRuleConfig> {
    /**
     * `affectedBuildCommand` is the project's gate command (`commands.pr-gate.buildCommand`), handed in
     * by the runner off the loaded config. It is a CONSTRUCTOR ARGUMENT rather than a config field
     * because this guard has no config entry to read one from — and that is the point.
     */
    constructor(private readonly affectedBuildCommand: string) {
        // configKey === name and is DELIBERATELY not a real key: this guard has no
        // webpieces.config.json entry at all (see RETIRED_CONFIG_KEYS), and it is loaded outside the
        // config-driven set so the fault-Y sync check never sees it. Naming it here keeps the
        // AbstractRule contract honest without putting the string in HOOK_GUARD_NAMES.
        super(new EmptyRuleConfig(), 'whole-repo-build-guard', 'whole-repo-build-guard');
    }

    private readonly scanner = new CommandScanner();
    private readonly homeConfig = new HomeConfigService();

    /** Set by check() when the home config is unreadable, so the fix hint names the same repair. */
    private homeConfigError = '';

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
        if (this.homeConfigError !== '') {
            return new FixHint(
                '~/.webpieces/config.json exists but cannot be read.',
                'Edit ~/.webpieces/config.json (editing it is always permitted, including right now), or ' +
                'delete it outright — with no such file every webpieces command behaves exactly as it ' +
                'does by default.',
            );
        }
        const command = this.resolvedCommand !== '' ? this.resolvedCommand : this.buildCommandTemplate();
        return new FixHint(
            'That command builds the WHOLE monorepo. Build only what your change affects.',
            'Build the affected projects, or one project, or one spec file — never the workspace:\n' +
            `  ${command}   # the gate's own build\n` +
            '  pnpm nx run <project>:ci   # one project\n' +
            '  pnpm exec vitest run <path>   # one suite\n' +
            'Turn this guard off for this machine by setting "experimental": ' +
            '{ "whole-repo-build-guard": false } in ~/.webpieces/config.json (there is no ' +
            'webpieces.config.json entry for it).',
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        const home = this.loadHome();
        // A file someone deliberately created must be correct — see the class docstring. Reported for
        // whatever command happens to be running, because a broken opt-in file is not a build question.
        if (home instanceof Error) return this.blockOnBrokenHomeConfig(ctx, home);

        // THE EXPERIMENTAL GATE, and the state of essentially every consumer. Silent on purpose: no
        // block, no log, no file touched — "no ~/.webpieces/config.json" must be indistinguishable from
        // "this guard does not exist".
        this.homeConfigError = '';
        if (!home.wholeRepoBuildGuard) return [];

        // Blocklist-shaped, so match on commandCode: stripping heredocs and quoted prose can only ever
        // block LESS, and this repo's own commit messages are full of the command names above.
        const hit = new WholeRepoBuildScan(this.scanner, ctx.effectiveCwd === ctx.workspaceRoot)
            .firstHit(ctx.commandCode);
        if (hit === null) return this.allow(ctx, 'not-a-whole-repo-build');

        // Resolved ONCE, here, and read by both the violation message and the fix hint.
        this.resolvedCommand = this.resolvedBuildCommand(ctx.workspaceRoot);
        return this.block(ctx, hit, this.message(home));
    }

    /**
     * The home config, or the Error explaining why it is unusable. NOT a boolean: "absent" is already
     * folded into the returned HomeConfig (all-defaults, guard off), so the only thing left to
     * distinguish is "present and wrong", which must be reported rather than swallowed.
     */
    private loadHome(): HomeConfig | Error {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a rejected home config is converted
        // into this guard's own block, which carries the loader's fix instruction verbatim
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return this.homeConfig.load();
        } catch (err: unknown) {
            const error = toError(err);
            return error;
        }
    }

    private blockOnBrokenHomeConfig(ctx: BashContext, error: Error): readonly Violation[] {
        this.homeConfigError = error.message;
        this.logDecision(ctx, 'BLOCK_AI_CURE', 'home-config-invalid');
        return [new V(1, this.truncate(ctx.command), this.brokenHomeConfigMessage(error))];
    }

    private brokenHomeConfigMessage(error: Error): string {
        const detail = error instanceof InformAiError
            ? error.message
            : `~/.webpieces/config.json could not be read: ${error.message}`;
        return `Blocked: ~/.webpieces/config.json is present but unusable.\n\n${detail}`;
    }

    // The whole refusal. Short on purpose: it is read mid-task by an agent that needs the ONE command
    // to run next, and a guard message long enough to skim is a guard message that gets skimmed.
    private message(home: HomeConfig): string {
        if (home.buildGateLogCapture) {
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
     * The project's build command, unexpanded. ONE source: `commands.pr-gate.buildCommand`, handed to
     * the constructor by the runner, falling back to the same DEFAULT_BUILD_COMMAND the gate itself
     * falls back to. This guard never spells a build command of its own — a second copy is how a refusal
     * starts teaching a command the gate does not run.
     */
    private buildCommandTemplate(): string {
        return this.affectedBuildCommand.trim() === '' ? DEFAULT_BUILD_COMMAND : this.affectedBuildCommand;
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

    private allow(ctx: BashContext, reason: string): readonly Violation[] {
        this.logDecision(ctx, 'ALLOW', reason);
        return [];
    }

    private block(ctx: BashContext, hit: WholeRepoBuildHit, message: string): readonly Violation[] {
        // BLOCK_AI_CURE, not BLOCK_HUMAN: the cure is one command the agent runs itself, and the
        // refusal hands it over already resolved.
        this.logDecision(ctx, 'BLOCK_AI_CURE', hit.shape);
        return [new V(1, this.truncate(ctx.command), message)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, verdict: Verdict, reason: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('whole-repo-build-guard', 'Bash', ctx.command, '-', verdict, reason, '-', L0_FAULT_NONE, MATRIX_L2_UNROWED),
        );
    }
}
