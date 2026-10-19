import { Option } from './fix-option';

/**
 * How far into the future the LAST-RESORT `turnOffRuleUntilEpoch` cure tells a reader to reach: one hour.
 *
 * Short on purpose (issue #1318). `shouldSkipRule` ORs the two hatches, so a future epoch turns the rule
 * off for the WHOLE REPO, on every branch, until it passes — naming a branch beside it does not narrow
 * that. A ~6-week epoch meant for one legacy-port branch kept max-file-lines and max-method-lines off
 * repo-wide for the whole window in a consumer repo, and nobody noticed. An hour is enough to land one
 * change from a CI that cannot see the branch name, and the rule is back on before anyone forgets it.
 */
export const LAST_RESORT_TURN_OFF_SECONDS = 60 * 60;

/**
 * The ONE wording of "how to turn this rule off", shared by every cure that offers it, so the BRANCH
 * hatch always leads and the EPOCH hatch is always the short, explicitly repo-wide last resort.
 *
 * A class rather than two string constants because the epoch cure carries a COMPUTED value (now + 1 hour,
 * in epoch SECONDS): a reader handed "a future epoch" picks a date, and a date is how the six-week window
 * above happened. The clock is injectable so a spec can pin the printed number.
 */
export class TurnOffRuleCure {
    private readonly nowSeconds: () => number;

    constructor(nowSeconds: () => number = (): number => Math.floor(Date.now() / 1000)) {
        this.nowSeconds = nowSeconds;
    }

    /**
     * The preferred cure: turn the rule off on ONE branch. `entry` names where the setting lives (e.g.
     * `the "max-file-lines" entry in .webpieces-config/rules/code-rules.json`). `branchName` fills in the
     * exact branch when the caller knows it; otherwise the reader gets a `<exact branch name>` placeholder.
     */
    byBranchText(entry: string, branchName?: string | null): string {
        const branch = branchName && branchName !== 'HEAD' ? branchName : '<exact branch name>';
        return (
            `Turn the rule off for THIS BRANCH ONLY: on ${entry} set "turnOffRuleWhileOnBranch": "${branch}" ` +
            `and keep "turnOffRuleUntilEpoch": 0. The rule is then off only on that branch — including its own ` +
            `PR's CI run (GITHUB_HEAD_REF) — stays on everywhere else, and is back on for good once the branch ` +
            `lands.`
        );
    }

    /** The last-resort cure, for a CI that cannot see the branch name. Always states that it is repo-wide. */
    byEpochText(entry: string): string {
        const until = this.nowSeconds() + LAST_RESORT_TURN_OFF_SECONDS;
        const untilIso = new Date(until * 1000).toISOString();
        return (
            `LAST RESORT, only when the branch name does not work (a detached-HEAD checkout, a fork or ` +
            `pull_request_target run, a CI provider that does not expose the branch): on ${entry} set ` +
            `"turnOffRuleUntilEpoch" to now + 1 hour, in epoch SECONDS (right now that is ${String(until)}, ` +
            `${untilIso}). This turns the rule off REPO-WIDE, on every branch, for that hour — keep it to the ` +
            `hour so the rule turns back on quickly.`
        );
    }

    /** Both cures as `Option`s, branch first and preferred. */
    options(entry: string, branchName?: string | null): Option[] {
        return [new Option(this.byBranchText(entry, branchName), true), new Option(this.byEpochText(entry))];
    }
}
