import { DevDeployConfig } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The "now go watch it deploy" block printed after a copy is published.
 *
 * WHY THIS IS TEXT AND NOT A FEATURE: webpieces cannot know the consumer's CD. The composed branch might
 * be built by GitHub Actions, by Jenkins, by a cron job on a box — so polling for "the run" would mean
 * either a config key naming their workflow, or a heuristic that is wrong for somebody. Handing the AI
 * the exact commands costs nothing, degrades gracefully (an empty `gh run list` is itself an answer), and
 * keeps webpieces out of the business of modelling someone else's pipeline.
 *
 * The commands are pre-substituted with the real sha and refs — an AI given a template with blanks to
 * fill in gets one of them wrong eventually, and a wrong `git merge-base` argument answers the question
 * confidently and incorrectly.
 *
 * All of them are READ-ONLY and none is blocked: `git fetch`/`merge-base` are queries, and
 * `gh run list|view|watch` is on the guards' allowed list.
 */
@injectable(bindingScopeValues.Singleton)
export class DevDeployWatchHints {
    /**
     * @param sha the commit that was just published — the ONLY thing that makes step 1 a proof rather
     *   than a guess, since `<copyRef>` itself moves the next time anyone publishes.
     */
    render(cfg: DevDeployConfig, copyRef: string, sha: string): string {
        return '\n' + SEP + '👀 Is it on the dev server yet? — two questions, in this order\n' + SEP + '\n'
            + this.landedSection(cfg, sha)
            + '\n'
            + this.runSection(cfg, copyRef)
            + '\n'
            + this.orderingWarning(cfg);
    }

    /**
     * Step 1 — pure git, works with ANY CI, and is the only claim provably about YOUR code.
     *
     * `<devBranch>` is recomposed from `origin/main` plus every copy on each CI run, so your published
     * sha is an ancestor of it if and only if the composition included you.
     */
    private landedSection(cfg: DevDeployConfig, sha: string): string {
        return `1. Did YOUR code land in \`${cfg.devBranch}\`?  (pure git — works whatever your CI is)\n`
            + `     git fetch origin ${cfg.devBranch}\n`
            + `     git merge-base --is-ancestor ${sha} origin/${cfg.devBranch} && echo IN || echo "not yet"\n`
            + `   \`${cfg.devBranch}\` is rebuilt from origin/main + every \`${cfg.copyRefGlob()}\` ref on each run, so\n`
            + '   ancestry IS inclusion. Re-run after the next composition if it says "not yet".\n';
    }

    /** Step 2 — GitHub Actions, if that is where this repo's dev deploy lives. Empty output is an answer. */
    private runSection(cfg: DevDeployConfig, copyRef: string): string {
        const rows = [
            [`gh run list --branch ${copyRef} --limit 5`, 'the run your push triggered, if any'],
            [`gh run list --branch ${cfg.devBranch} --limit 5`, 'the composition / deploy run'],
            ['gh run watch <run-id>', 'follow one to completion'],
            ['gh run view <run-id> --log-failed', 'read why it failed'],
        ];
        // Aligned off the longest command, because the ref names are consumer-configurable and any
        // hand-counted padding would go crooked the moment somebody renames the namespace.
        const width = Math.max(...rows.map((row: string[]): number => row[0].length));
        return '2. Is the CI/CD run finished?  (GitHub Actions — all read-only, none of it is blocked)\n'
            + rows.map((row: string[]): string => `     ${row[0].padEnd(width)}   ← ${row[1]}\n`).join('')
            + '   Empty output is not a bug: it means this repo deploys from somewhere other than Actions.\n'
            + '   Ask the human where the dev deploy runs, and do not guess.\n';
    }

    /** The trap worth one sentence: a green run on a SHARED branch is not a statement about your code. */
    private orderingWarning(cfg: DevDeployConfig): string {
        return `A green run on \`${cfg.devBranch}\` is NOT proof your change deployed — that branch carries everyone's\n`
            + 'copies, and the composition may have excluded yours. Question 1 is the one that answers for YOUR\n'
            + 'code; question 2 only tells you whether the machinery finished.\n';
    }
}
