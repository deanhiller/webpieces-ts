/**
 * The one exception a CLI *library* function throws when it needs to abort the whole process. It
 * carries the intended `exitCode` so the bin's terminal boundary (`runMain`) can translate it into
 * `process.exit(exitCode)` — the single sanctioned exit site.
 *
 * WHY this exists: a library function must NEVER call `process.exit` directly. When it did (e.g.
 * `git-gatherInfo`'s old `main()` calling `process.exit(0)` while imported by `merge-start`), it
 * killed the *parent* CLI (`wp-start-upsert-pr`) mid-flow — with a SUCCESS code — so push + build
 * were silently skipped. Throwing instead lets the exception propagate to `main()`, where `runMain`
 * prints the message and exits with the right code. Enforced by the `no-process-exit-outside-main`
 * ESLint rule.
 *
 * Distinct from `RuleFailError` (rules-domain: one rule's failure, caught per-rule) — this is
 * "abort the CLI process with this exit code". Positional constructor per this package's
 * classes-over-interfaces convention.
 *
 *   throw new CliExitError(1, '❌ Failed to push branch');
 *   throw new CliExitError(buildCode, '❌ Build failed — fix it before reviewing.');
 */
export class CliExitError extends Error {
    override cause?: Error;
    readonly exitCode: number;

    constructor(exitCode: number, message: string, cause?: Error) {
        super(message);
        this.name = 'CliExitError';
        this.exitCode = exitCode;
        this.cause = cause;
    }
}
