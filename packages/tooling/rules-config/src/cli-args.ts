import { injectable, bindingScopeValues } from 'inversify';
import { CliExitError } from './cli-exit-error';

/**
 * One optional `--flag` a command accepts. Data-only. The description is printed in `--help`, so it is
 * written for the reader who has to DECIDE whether to pass it, not as a restatement of the name.
 */
export class CliFlag {
    name: string;        // including the leading dashes, e.g. '--no-optional'
    description: string;
    /**
     * The flag MAY carry a value: `--resolve dean/ONE-2275` or `--resolve=dean/ONE-2275`.
     *
     * "May", not "must". The one flag that needs this (`wp-push-dev --resolve`) is meaningful both bare
     * (queue every other copy) and with an argument (queue just that one), and a `valueRequired` variant
     * would be a second concept for a case nothing has. A following token is consumed as the value only
     * when it does not itself start with `-`, so `--resolve --force` still reads as two flags.
     */
    takesValue: boolean;

    constructor(name: string, description: string, takesValue = false) {
        this.name = name;
        this.description = description;
        this.takesValue = takesValue;
    }
}

/**
 * Usage descriptor for a `wp-*` bin. Data-only (classes-over-interfaces): a command name, its one-line
 * summary, and the flags it accepts. `CliArgs.classify` turns it into the `--help` / unknown-arg message.
 *
 * `flags` defaults to [] — the no-argument case stays a two-arg construction, which is what MOST `wp-*`
 * bins are. (Deliberately not a count: the last one written down went stale the next time a bin grew a
 * flag, which is exactly the drift the corollary in CLAUDE.md is about.)
 *
 * A flag a command does not DECLARE here is still rejected with exit 2: that guard is
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
    // Values for the value-taking flags that carried one, keyed by flag name. A flag passed bare is in
    // `present` but absent here, which is exactly the distinction `--resolve` (bare) vs
    // `--resolve <branch>` needs.
    values: Map<string, string>;

    constructor(present: string[] = [], values: Map<string, string> = new Map<string, string>()) {
        this.present = present;
        this.values = values;
    }

    has(flag: string): boolean {
        return this.present.includes(flag);
    }

    /** The value passed with `flag`, or '' when the flag was absent or passed bare. */
    value(flag: string): string {
        return this.values.get(flag) ?? '';
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

/** One argv walk's result: which declared flags were seen, their values, and every unrecognized token. */
class CliScan {
    present: string[] = [];
    values: Map<string, string> = new Map<string, string>();
    unknown: string[] = [];
}

/** Argument guard for the no-argument `wp-*` bins. */
@injectable(bindingScopeValues.Singleton)
export class CliArgs {
    // The help/usage block shown for `--help` and appended to an unknown-arg error. A command with no
    // declared flags says so outright, because "takes no arguments" is the whole usage for most of them.
    private usageText(usage: CliUsage): string {
        const head = `${usage.command} — ${usage.summary}\n\n`;
        if (usage.flags.length === 0) {
            return head + `Usage:  pnpm ${usage.command}\nThis command takes no arguments.`;
        }
        const label = (f: CliFlag): string => (f.takesValue ? `${f.name} [<value>]` : f.name);
        const width = Math.max(...usage.flags.map((f: CliFlag): number => label(f).length));
        const rows = usage.flags.map((f: CliFlag): string => `  ${label(f).padEnd(width)}  ${f.description}`);
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
        const scan = this.scan(args, usage);
        if (scan.unknown.length > 0) {
            return new CliArgsCheck(false, 2, `❌ Unknown argument(s): ${scan.unknown.join(' ')}\n\n` + this.usageText(usage));
        }
        return new CliArgsCheck(true, 0, '');
    }

    /**
     * Walk argv once, classifying every token as a declared flag, a value belonging to the
     * value-taking flag before it, or unknown. ONE walk backs both `classify` and `parse` so the set of
     * tokens the guard accepts and the set `parse` reports can never diverge — an accepted-but-unreported
     * flag would silently run the flow without the behaviour the caller asked for.
     */
    private scan(args: string[], usage: CliUsage): CliScan {
        const byName = new Map<string, CliFlag>();
        for (const flag of usage.flags) byName.set(flag.name, flag);
        const scan = new CliScan();
        for (let i = 0; i < args.length; i += 1) {
            const token = args[i];
            const eq = token.indexOf('=');
            // `--flag=value` — split before lookup so the name is what gets matched, not the whole token.
            const name = eq > 0 ? token.slice(0, eq) : token;
            const flag = byName.get(name);
            if (flag === undefined) {
                scan.unknown.push(token);
                continue;
            }
            scan.present.push(name);
            if (!flag.takesValue) {
                // `--no-optional=x` is a typo, not an accepted flag: the value would be silently dropped.
                if (eq > 0) scan.unknown.push(token);
                continue;
            }
            if (eq > 0) {
                scan.values.set(name, token.slice(eq + 1));
                continue;
            }
            // OPTIONAL value: only a following token that is not itself a flag. `--resolve --force`
            // therefore reads as two flags, not as a resolve of a branch literally named `--force`.
            const next = i + 1 < args.length ? args[i + 1] : '';
            if (next !== '' && !next.startsWith('-')) {
                scan.values.set(name, next);
                i += 1;
            }
        }
        return scan;
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
        const scan = this.scan(args, usage);
        return new CliArgSet(scan.present, scan.values);
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
