import { spawnSync } from 'child_process';
import { loadPrGateConfig } from '@webpieces/rules-config';

// Single source of truth for the build gate. Both `wp-build-affected` (CI + local) and the
// merge validation gate (`wp-git-merge-complete`) run THIS, so "what CI runs" and "what the
// PR command runs" can never drift. nx `affected` only rebuilds changed projects, so this
// stays fast on a large monorepo.
export const DEFAULT_BUILD_COMMAND = 'pnpm nx affected --target=ci --base=origin/main';

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
 * merge-complete gate and wp-upsert-pr both call THIS so they provably build with the same
 * command — the resolution the AI validates is built exactly as the PR command builds it.
 * Returns the exit code; callers print their own re-run hint.
 */
export function runConfiguredBuildGate(repoRoot: string): number {
    return runBuildAffected(repoRoot, loadPrGateConfig(repoRoot).buildCommand);
}
