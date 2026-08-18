// TEMPORARY PROBE — proves turnOffRuleWhileOnBranch works in a REAL GitHub pull_request run.
// A deliberate `any` so no-any-unknown fires unless the branch hatch suppresses it.
// Delete this file, and the hatch in webpieces.config.json, before this branch merges.
export class HatchProbe {
    run(value: any): void {
        console.log(value);
    }
}
