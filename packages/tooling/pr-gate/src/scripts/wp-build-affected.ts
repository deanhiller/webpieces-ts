#!/usr/bin/env node
import { execSync } from 'child_process';
import { loadAndValidate } from '@webpieces/rules-config';
import { runBuildAffected } from './workflow/build-affected';

// Single shared build entry point. CI runs this AND the PR command runs this, so the two can
// never diverge. The build command is sourced from PrGateConfig.buildCommand (webpieces.config.json
// "pr-gate" section), defaulting to `pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)`.
// The `--base` is the FORK POINT (git merge-base), NOT origin/main: basing on origin/main would mark
// projects touched by other people's already-merged PRs as "affected" (your branch still has their
// pre-merge versions), wasting a rebuild. The fork point scopes "affected" to only your branch's work.
export function main(): void {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const config = loadAndValidate(repoRoot).prGate;
    const code = runBuildAffected(repoRoot, config.buildCommand);
    process.exit(code);
}

if (require.main === module) {
    main();
}
