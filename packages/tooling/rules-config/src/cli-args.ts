import { injectable, bindingScopeValues } from 'inversify';
import { CliExitError } from './cli-exit-error';

/**
 * Usage descriptor for a `wp-*` bin. Data-only (classes-over-interfaces): a command name and its
 * one-line summary. `CliArgs.classify` turns it into the `--help` / unknown-arg message.
 */
export class CliUsage {
    command: string;
    summary: string;

    constructor(command: string, summary: string) {
        this.command = command;
        this.summary = summary;
    }
}

/**
 * Data-only outcome of checking argv against a no-argument command. `ok` true → run normally; else
 * `exitCode`/`message` are what the bin should exit with (help = 0, unknown arg = 2). Kept a pure
 * value so it can be asserted directly in tests without provoking a throw.
 */
export class CliArgsCheck {
    ok: boolean;
    exitCode: number;
    message: string;

    constructor(ok: boolean, exitCode: number, message: string) {
        this.ok = ok;
        this.exitCode = exitCode;
        this.message = message;
    }
}

/** Argument guard for the no-argument `wp-*` bins. */
@injectable(bindingScopeValues.Singleton)
export class CliArgs {
    // The help/usage block shown for `--help` and appended to an unknown-arg error. These commands
    // take NO arguments, so that fact is the whole "usage".
    private usageText(usage: CliUsage): string {
        return (
            `${usage.command} — ${usage.summary}\n\n` +
            `Usage:  pnpm ${usage.command}\n` +
            `This command takes no arguments.`
        );
    }

    /**
     * Pure argv classifier for a no-argument command. No args → ok. `--help`/`-h` → not-ok, exit 0
     * with the usage block. Anything else → not-ok, exit 2 naming the offending token(s). Split out
     * from `assertNoArgs` so the decision is unit-testable without a thrown exception.
     */
    classify(args: string[], usage: CliUsage): CliArgsCheck {
        if (args.length === 0) return new CliArgsCheck(true, 0, '');
        if (args.includes('--help') || args.includes('-h')) {
            return new CliArgsCheck(false, 0, this.usageText(usage));
        }
        return new CliArgsCheck(false, 2, `❌ Unknown argument(s): ${args.join(' ')}\n\n` + this.usageText(usage));
    }

    /**
     * Call it as the FIRST thing inside `runMain`, BEFORE the app touches git — a bogus flag must
     * never start a mutation flow (the `wp-start-upsert-pr --help` incident: an ignored flag silently
     * launched the squash-merge and stranded the checkout on a `…PreMerge<n>` branch).
     *
     * Throws `CliExitError` (never `process.exit`) so `runMain` stays the single sanctioned exit site
     * (`no-process-exit-outside-main`): help exits 0, an unknown arg exits 2, and in both cases the
     * flow never begins.
     */
    assertNoArgs(usage: CliUsage): void {
        const check = this.classify(process.argv.slice(2), usage);
        if (check.ok) return;
        throw new CliExitError(check.exitCode, check.message);
    }
}
