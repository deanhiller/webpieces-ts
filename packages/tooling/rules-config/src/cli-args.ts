import { injectable, bindingScopeValues } from 'inversify';
import { CliExitError } from './cli-exit-error';

/**
 * One optional `--flag` a command accepts. Data-only. The description is printed in `--help`, so it is
 * written for the reader who has to DECIDE whether to pass it, not as a restatement of the name.
 */
export class CliFlag {
    name: string;        // including the leading dashes, e.g. '--no-optional'
    description: string;

    constructor(name: string, description: string) {
        this.name = name;
        this.description = description;
    }
}

/**
 * Usage descriptor for a `wp-*` bin. Data-only (classes-over-interfaces): a command name, its one-line
 * summary, and the flags it accepts. `CliArgs.classify` turns it into the `--help` / unknown-arg message.
 *
 * `flags` defaults to [] — the no-argument case stays a two-arg construction, which is what eight of the
 * nine `wp-*` bins are. A flag a command does not DECLARE here is still rejected with exit 2: that guard is
 * the reason this class exists (`wp-start-upsert-pr --help` once launched a squash-merge), and making it
 * flag-aware must not soften it.
 */
export class CliUsage {
    command: string;
    summary: string;
    flags: CliFlag[];

    constructor(command: string, summary: string, flags: CliFlag[] = []) {
        this.command = command;
        this.summary = summary;
        this.flags = flags;
    }
}

/**
 * Which declared flags argv actually carried. Data-only (a class, per CLAUDE.md), with a `has()` accessor
 * so every consumer asks the question the same way instead of open-coding `includes` against a raw array.
 */
export class CliArgSet {
    present: string[];

    constructor(present: string[] = []) {
        this.present = present;
    }

    has(flag: string): boolean {
        return this.present.includes(flag);
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
    // The help/usage block shown for `--help` and appended to an unknown-arg error. A command with no
    // declared flags says so outright, because "takes no arguments" is the whole usage for eight of nine.
    private usageText(usage: CliUsage): string {
        const head = `${usage.command} — ${usage.summary}\n\n`;
        if (usage.flags.length === 0) {
            return head + `Usage:  pnpm ${usage.command}\nThis command takes no arguments.`;
        }
        const width = Math.max(...usage.flags.map((f: CliFlag): number => f.name.length));
        const rows = usage.flags.map((f: CliFlag): string => `  ${f.name.padEnd(width)}  ${f.description}`);
        return head + `Usage:  pnpm ${usage.command} [flags]\n\nFlags:\n${rows.join('\n')}`;
    }

    /**
     * Pure argv classifier. No args → ok. `--help`/`-h` → not-ok, exit 0 with the usage block. Any token
     * the command did not DECLARE → not-ok, exit 2 naming the offending one(s). Split out from
     * `assertNoArgs`/`parse` so the decision is unit-testable without a thrown exception.
     *
     * An undeclared token is still fatal even for a command that accepts flags — a mistyped `--no-optionl`
     * must never be silently ignored and then run the flow WITH the reviews the caller meant to skip.
     */
    classify(args: string[], usage: CliUsage): CliArgsCheck {
        if (args.length === 0) return new CliArgsCheck(true, 0, '');
        if (args.includes('--help') || args.includes('-h')) {
            return new CliArgsCheck(false, 0, this.usageText(usage));
        }
        const declared = new Set(usage.flags.map((f: CliFlag): string => f.name));
        const unknown = args.filter((a: string): boolean => !declared.has(a));
        if (unknown.length > 0) {
            return new CliArgsCheck(false, 2, `❌ Unknown argument(s): ${unknown.join(' ')}\n\n` + this.usageText(usage));
        }
        return new CliArgsCheck(true, 0, '');
    }

    /**
     * The flag-accepting sibling of {@link assertNoArgs}: same guard, but it RETURNS which declared flags
     * were passed. Call it in exactly the same place — first thing inside `runMain`, before the app touches
     * git.
     */
    parse(usage: CliUsage): CliArgSet {
        const args = process.argv.slice(2);
        const check = this.classify(args, usage);
        if (!check.ok) throw new CliExitError(check.exitCode, check.message);
        const declared = new Set(usage.flags.map((f: CliFlag): string => f.name));
        return new CliArgSet(args.filter((a: string): boolean => declared.has(a)));
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
