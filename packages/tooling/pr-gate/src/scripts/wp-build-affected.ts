#!/usr/bin/env node
import { execSync } from 'child_process';
import { loadAndValidate } from '@webpieces/rules-config';
import { runBuildAffected } from './workflow/build-affected';

// Single shared build entry point. CI runs this AND the PR command runs this, so the two can
// never diverge. The build command is sourced from PrGateConfig.buildCommand (webpieces.config.json
// "pr-gate" section), defaulting to `pnpm nx affected --target=ci --base=origin/main`.
export function main(): void {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const config = loadAndValidate(repoRoot).prGate;
    const code = runBuildAffected(repoRoot, config.buildCommand);
    process.exit(code);
}

if (require.main === module) {
    main();
}
