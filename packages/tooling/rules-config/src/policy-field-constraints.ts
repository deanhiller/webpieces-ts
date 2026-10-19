import { LAST_RESORT_TURN_OFF_SECONDS } from './turn-off-rule-cure';

export const MAX_TURN_OFF_EPOCH_DAYS = 7;

/** Generic consumer-field constraints are shared by owner files and client-authored match rules. */
export class PolicyFieldConstraints {
    epochError(label: string, value: number): string | null {
        const maxEpoch = Math.floor(Date.now() / 1000) + MAX_TURN_OFF_EPOCH_DAYS * 24 * 60 * 60;
        if (value <= maxEpoch) return null;
        const daysOut = Math.round((value - Date.now() / 1000) / (24 * 60 * 60));
        const maxDate = new Date(maxEpoch * 1000).toISOString().split('T')[0];
        return (
            `${label} "turnOffRuleUntilEpoch": ${value} is ${daysOut} days in the future — the maximum is ` +
            `${MAX_TURN_OFF_EPOCH_DAYS} days. A rule switched off for longer than that is off for work nobody ` +
            `had in mind when it was written, because this hatch is REPO-WIDE while it lasts.\n` +
            `  CURE: if the rule is off for ONE branch's work, set "turnOffRuleWhileOnBranch": "<exact branch name>" ` +
            `and "turnOffRuleUntilEpoch": 0 instead — it is off only on that branch (including its own PR's CI ` +
            `run), and that hatch has no cap. Only when your CI cannot see the branch name (a detached-HEAD ` +
            `checkout, a fork or pull_request_target run, another CI provider), set it to now + 1 hour in epoch ` +
            `SECONDS (right now that is ${String(Math.floor(Date.now() / 1000) + LAST_RESORT_TURN_OFF_SECONDS)}) ` +
            `— never past ${maxEpoch} (${maxDate}) — knowing it turns the rule off REPO-WIDE for that hour.`
        );
    }

    private readonly renamedFields: Readonly<Record<string, string>> = {
        ignoreModifiedUntilEpoch: 'turnOffRuleUntilEpoch',
        ignoreRuleWhileOnBranch: 'turnOffRuleWhileOnBranch',
    };

    retiredFields(): readonly string[] { return Object.keys(this.renamedFields); }

    renamedField(key: string): string | undefined { return this.renamedFields[key]; }

    isRationale(key: string): boolean {
        return key.length > 3 && key.endsWith('Why');
    }
}
