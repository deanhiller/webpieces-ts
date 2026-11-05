import { CliExitError, WP_BUILD_PUSH_DEV } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { BuildAffected, BuildGateOptions } from './build-affected';
import { DEV_BUILD_STAGE } from './build-gate-log';
import { DevDeployRefs } from './dev-deploy-refs';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The example printed when the key is missing. An example, never a fallback: nothing ever RUNS it. */
export const EXAMPLE_DEV_BUILD_COMMAND = 'pnpm nx affected -t build test --base=origin/dev --head=HEAD';

/**
 * The dev-scoped build (#1397): `commands.push-dev.buildCommand`, run through the SAME build gate as
 * `wp-build` and the PR gate (`BuildAffected.runBuildGateWith`) — one log-file capture, one heartbeat, one
 * ledger row pair, one failure rendering. Only the command and the log name (`build-dev.log`) differ.
 *
 * WHY A SECOND COMMAND AND NOT `commands.pr-gate.buildCommand`: `wp-build-push-dev` runs BOTH (#1405). The
 * PR gate's build runs first, on the feature branch alone, with the code rules judging it against main. This
 * one runs on the merge with `dev` and answers a different question — does everyone's code still compile and
 * pass tests together — so it should compile and test ONLY, affected vs `origin/dev`. It must not run the
 * code rules (`architecture:validate-code`, i.e. an nx `ci` target): that tree holds every other developer's
 * copy, and diffed against main their code is judged as the publisher's change. The two are different
 * builds, so they are two keys.
 *
 * NO DEFAULT, deliberately (`.claude/rules/no-rule-defaults.md`): which build vouches for a dev publish is
 * the consumer's decision. Missing ⇒ the command refuses before it touches anything, naming the key and
 * printing the entry to paste.
 */
@injectable(bindingScopeValues.Singleton)
export class DevBuild {
    constructor(
        private readonly buildAffected: BuildAffected,
        private readonly refs: DevDeployRefs,
    ) {}

    /** The configured command, or the refusal naming the key. Called BEFORE any git write, so it fails fast. */
    command(repoRoot: string): string {
        const configured = this.refs.devBuildCommand(repoRoot);
        if (configured !== undefined && configured.trim() !== '') return configured;
        throw new CliExitError(2,
            '\n' + SEP + '⛔ `commands.push-dev.buildCommand` is not configured\n' + SEP + '\n'
            + `${WP_BUILD_PUSH_DEV} builds your copy merged with origin/dev before wp-finish-push-dev publishes it.\n`
            + 'WHICH build is this repo\'s decision, so there is no default.\n'
            + 'Nothing was merged, built or published.\n\n'
            + 'Add this to webpieces.config.json, inside "commands", choosing a command that compiles and tests\n'
            + 'only what differs from origin/dev — and runs NO code rules (no `ci` target): the rules already judged\n'
            + 'your branch against main, and on this tree they would judge every other developer\'s copy as yours:\n\n'
            + `  "push-dev": { "buildCommand": "${EXAMPLE_DEV_BUILD_COMMAND}" }\n`);
    }

    /**
     * Run the dev build on the CURRENT checkout. Throws CliExitError on a red build, with the `FullLog :`
     * pointer, exactly like `wp-build`. `rerunCommand` is what the failure text tells the reader to run
     * after fixing it.
     */
    run(repoRoot: string, rerunCommand: string): Promise<void> {
        const command = this.command(repoRoot);
        return this.buildAffected.runBuildGateWith(repoRoot, command, new BuildGateOptions(
            '🛠️  dev build (commands.push-dev.buildCommand)',
            rerunCommand,
            'Dev build failed — nothing was published.',
            DEV_BUILD_STAGE,
        ));
    }
}
