// TEMPORARY PROBE — proves turnOffRuleWhileOnBranch fires in a REAL GitHub pull_request run.
//
// Deliberately lives in an APP (no package.json → never published), not in a packages/tooling
// library: rules-config/tsconfig.lib.json includes src/**/*.ts and excludes only specs, so a probe
// there would compile into the published @webpieces/rules-config and, via the role:bundle umbrella,
// become a deep-importable public class carrying the very `any` no-any-unknown exists to prevent.
//
// The `any` below is the bait: no-any-unknown must fire on it unless the branch hatch suppresses it.
// Delete this file, and set no-any-unknown.turnOffRuleWhileOnBranch back to null, before merging.
export class HatchProbe {
    run(value: any): void {
        console.log(value);
    }
}
