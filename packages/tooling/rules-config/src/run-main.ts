import { CliExitError } from './cli-exit-error';

/**
 * The SINGLE sanctioned `process.exit` site for every CLI bin. Each bin's entry collapses to:
 *
 *   if (require.main === module) runMain(main);
 *
 * and `main` — plus every library function it calls — NEVER calls `process.exit` itself. Instead a
 * library that must abort throws `CliExitError(exitCode, message)`; this translator prints the
 * message and exits with that code. Any other thrown value is a real bug and exits 1.
 *
 * This is what keeps a helper deep in the call tree from silently killing the whole process (the
 * `git-gatherInfo` → `merge-start` → `wp-start-upsert-pr` bug): control always unwinds to `main`,
 * and only here does the process actually exit. Enforced by `no-process-exit-outside-main`.
 */
export function runMain(main: () => Promise<void>): void {
    // webpieces-disable no-any-unknown -- a promise rejection is genuinely of unknown type; narrowed below.
    main().catch((err: unknown) => {
        if (err instanceof CliExitError) {
            if (err.message) process.stderr.write(err.message + '\n');
            process.exit(err.exitCode);
        }
        process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
        process.exit(1);
    });
}
