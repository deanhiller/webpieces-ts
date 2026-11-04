import { CliExitError, WP_BUILD_DEV, WP_PUSH_DEV } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { BuildAffected, BuildGateOptions } from './build-affected';
import { DEV_BUILD_STAGE } from './build-gate-log';
import { DevDeployRefs } from './dev-deploy-refs';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The example printed when the key is missing. An example, never a fallback: nothing ever RUNS it. */
export const EXAMPLE_DEV_BUILD_COMMAND = 'pnpm nx affected --target=ci --base=origin/dev --head=HEAD';

/**
 * The dev-scoped build (#1397): `commands.push-dev.buildCommand`, run through the SAME build gate as
 * `wp-build` and the PR gate (`BuildAffected.runBuildGateWith`) — one log-file capture, one heartbeat, one
 * ledger row pair, one failure rendering. Only the command and the log name (`build-dev.log`) differ.
 *
 * WHY A SECOND COMMAND AND NOT `commands.pr-gate.buildCommand`: the PR gate builds what this branch
 * changes against `main`. Before a dev publish the question is different — does this copy build once it is
 * merged with what is ALREADY on `dev` — and the cheap way to answer it builds only what differs from
 * `origin/dev`. The two are different builds, so they are two keys.
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
            + `${WP_PUSH_DEV} builds your copy merged with origin/dev before it publishes, and ${WP_BUILD_DEV}\n`
            + 'runs that build on its own. WHICH build is this repo\'s decision, so there is no default.\n'
            + 'Nothing was merged, built or published.\n\n'
            + 'Add this to webpieces.config.json, inside "commands", choosing a command that builds only what\n'
            + 'differs from origin/dev in this repo:\n\n'
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
