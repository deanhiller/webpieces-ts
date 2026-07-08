import { spawnSync } from 'child_process';
import { loadAndValidate, CliExitError } from '@webpieces/rules-config';

// Single source of truth for the build gate. The PR flow's advisory gate (`wp-start-upsert-pr`)
// and authoritative merge gate (`wp-finish-upsert-pr`) both run THIS, so the two can never drift.
// nx `affected` only rebuilds changed projects, so this stays fast on a large monorepo.
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

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The two facts that differ between the wp-start (advisory) and wp-finish (authoritative) build
 * gates. Everything else — resolve command, run it, print the re-run hint, exit non-zero on failure
 * — is identical, so it lives once in runBuildGate and the difference is passed in here. A class (not
 * an object literal) per the codebase's data-structure convention.
 */
export class BuildGateOptions {
    label: string;            // section header shown above the gate
    rerunCommand: string;     // command the AI re-runs after fixing the build
    failureHeadline: string;  // first line printed on failure

    constructor(label: string, rerunCommand: string, failureHeadline: string) {
        this.label = label;
        this.rerunCommand = rerunCommand;
        this.failureHeadline = failureHeadline;
    }
}

/**
 * Run the configured build gate with consistent framing, throwing CliExitError(buildCode) on failure
 * so the bin's main()/runMain owns the exit. Single source of truth: wp-start-upsert-pr and
 * wp-finish-upsert-pr both call THIS (only the BuildGateOptions differ) so a fix to the gate flow is
 * made once, not in two near-identical copies.
 */
export function runBuildGate(repoRoot: string, opts: BuildGateOptions): void {
    const buildCommand = resolveBuildCommand(repoRoot);
    process.stdout.write('\n' + SEP + opts.label + '\n' + SEP + '\n');
    process.stdout.write(
        `Running the build gate. To get it passing, run the SAME command yourself and fix everything it reports:\n\n` +
        `    ${buildCommand}\n\n`,
    );
    const buildCode = runConfiguredBuildGate(repoRoot);
    if (buildCode !== 0) {
        throw new CliExitError(buildCode,
            `\n❌ ${opts.failureHeadline}\n\n` +
            `Run THIS exact command to reproduce and fix all errors, then re-run ${opts.rerunCommand}:\n\n` +
            `    ${buildCommand}\n`,
        );
    }
    process.stdout.write('\n✅ Build passed.\n');
}
