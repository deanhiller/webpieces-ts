import { spawnSync } from 'child_process';
import { loadAndValidate } from '@webpieces/rules-config';

// Single source of truth for the build gate. Both `wp-build-affected` (CI + local) and the
// merge validation gate (`wp-finish-upsert-pr`) run THIS, so "what CI runs" and "what the
// PR command runs" can never drift. nx `affected` only rebuilds changed projects, so this
// stays fast on a large monorepo.
// `--base=$(git merge-base origin/main HEAD)` (the fork point) instead of `--base=origin/main`:
// origin/main rebuilds projects touched by OTHER people's merged PRs (your branch still holds the
// pre-merge versions, so nx sees them as "affected"). The fork point scopes affected to only YOUR
// branch's changes. The `$(...)` resolves because runBuildAffected runs with shell: true.
export const DEFAULT_BUILD_COMMAND = 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)';

/**
 * Resolve the exact build command this gate will run for a repo: the project's configured
 * PrGateConfig.buildCommand, or the default affected-ci command when none is set. Callers
 * print this so the AI knows precisely which command to run locally to get the gate passing.
 */
export function resolveBuildCommand(repoRoot: string): string {
    const configured = loadAndValidate(repoRoot).prGate.buildCommand;
    return configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_BUILD_COMMAND;
}

/**
 * Run the build gate. Returns the process exit code (0 = pass). `buildCommand` overrides
 * the default (sourced from PrGateConfig.buildCommand by callers); empty/undefined uses the
 * default affected-ci command.
 */
export function runBuildAffected(repoRoot: string, buildCommand?: string): number {
    const cmd = buildCommand !== undefined && buildCommand.trim() !== '' ? buildCommand : DEFAULT_BUILD_COMMAND;
    process.stdout.write(`\n▶ Build gate: ${cmd}\n\n`);
    const result = spawnSync(cmd, { stdio: 'inherit', cwd: repoRoot, shell: true });
    return result.status ?? 1;
}

/**
 * Run the build gate using the project's configured command (PrGateConfig.buildCommand). The
 * finish-upsert-pr gate and wp-start-upsert-pr both call THIS so they provably build with the same
 * command — the resolution the AI validates is built exactly as the PR command builds it.
 * Returns the exit code; callers print their own re-run hint.
 */
export function runConfiguredBuildGate(repoRoot: string): number {
    return runBuildAffected(repoRoot, loadAndValidate(repoRoot).prGate.buildCommand);
}
