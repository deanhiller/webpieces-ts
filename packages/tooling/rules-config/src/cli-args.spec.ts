import { describe, it, expect } from 'vitest';
import { CliArgs, CliFlag, CliUsage } from './cli-args';
import { CliExitError } from './cli-exit-error';

const cliArgs = new CliArgs();
const usage = new CliUsage('wp-start-upsert-pr', 'Update from main, push, run the build gate.');

describe('CliArgs.classify', () => {
    it('is ok when there are no args', () => {
        expect(cliArgs.classify([], usage).ok).toBe(true);
    });

    it('returns exit 0 with the usage block for --help', () => {
        const check = cliArgs.classify(['--help'], usage);
        expect(check.ok).toBe(false);
        expect(check.exitCode).toBe(0);
        expect(check.message).toContain('wp-start-upsert-pr');
        expect(check.message).toContain('takes no arguments');
    });

    it('returns exit 0 for the -h short flag', () => {
        expect(cliArgs.classify(['-h'], usage).exitCode).toBe(0);
    });

    it('returns exit 2 naming the offending token for an unknown flag', () => {
        const check = cliArgs.classify(['--force'], usage);
        expect(check.ok).toBe(false);
        expect(check.exitCode).toBe(2);
        expect(check.message).toContain('Unknown argument');
        expect(check.message).toContain('--force');
    });

    it('lists every unknown arg (exit 2)', () => {
        const check = cliArgs.classify(['foo', '--bar'], usage);
        expect(check.exitCode).toBe(2);
        expect(check.message).toContain('foo --bar');
    });
});

describe('CliArgs.assertNoArgs', () => {
    const savedArgv = process.argv;
    const withArgs = (args: string[], fn: () => void): void => {
        process.argv = ['node', 'wp-start-upsert-pr.js', ...args];
        fn();
        process.argv = savedArgv;
    };

    it('does not throw when there are no args', () => {
        withArgs([], () => {
            expect(() => cliArgs.assertNoArgs(usage)).not.toThrow();
        });
    });

    it('throws a CliExitError for --help (so runMain prints usage and exits 0)', () => {
        withArgs(['--help'], () => {
            expect(() => cliArgs.assertNoArgs(usage)).toThrow(CliExitError);
            expect(() => cliArgs.assertNoArgs(usage)).toThrow(/takes no arguments/);
        });
    });

    it('throws a CliExitError for an unknown flag', () => {
        withArgs(['--bogus'], () => {
            expect(() => cliArgs.assertNoArgs(usage)).toThrow(CliExitError);
            expect(() => cliArgs.assertNoArgs(usage)).toThrow(/--bogus/);
        });
    });
});

/**
 * Flag-accepting commands. The guard must stay exactly as strict for them: the reason this class exists is
 * that `wp-start-upsert-pr --help` once silently launched a squash-merge, and a command that tolerates one
 * flag must not start tolerating typos of it.
 */
describe('CliArgs with declared flags', () => {
    const flagUsage = new CliUsage(
        'wp-review-upsert-pr', 'Brief the reviewer subagents.',
        [new CliFlag('--no-optional', 'Skip offering the optional reviews.')]);

    it('accepts a DECLARED flag', () => {
        expect(cliArgs.classify(['--no-optional'], flagUsage).ok).toBe(true);
    });

    it('still rejects an undeclared token — a typo must never be silently ignored', () => {
        const check = cliArgs.classify(['--no-optionl'], flagUsage);
        expect(check.ok).toBe(false);
        expect(check.exitCode).toBe(2);
        expect(check.message).toContain('--no-optionl');
    });

    it('rejects only the undeclared tokens, naming them and not the valid one', () => {
        const check = cliArgs.classify(['--no-optional', '--force'], flagUsage);
        expect(check.exitCode).toBe(2);
        expect(check.message).toContain('Unknown argument(s): --force');
    });

    it('lists the flags in --help instead of claiming the command takes no arguments', () => {
        const check = cliArgs.classify(['--help'], flagUsage);
        expect(check.exitCode).toBe(0);
        expect(check.message).not.toContain('takes no arguments');
        expect(check.message).toContain('--no-optional');
        expect(check.message).toContain('Skip offering the optional reviews.');
    });

    it('parse() reports which declared flags were actually passed', () => {
        const argv = process.argv;
        // webpieces-disable no-unmanaged-exceptions -- test fixture: argv is restored in the finally
        try {
            process.argv = ['node', 'wp-review-upsert-pr', '--no-optional'];
            expect(cliArgs.parse(flagUsage).has('--no-optional')).toBe(true);
            process.argv = ['node', 'wp-review-upsert-pr'];
            expect(cliArgs.parse(flagUsage).has('--no-optional')).toBe(false);
        } finally {
            process.argv = argv;
        }
    });

    it('parse() throws CliExitError on an undeclared token, before any flow can begin', () => {
        const argv = process.argv;
        // webpieces-disable no-unmanaged-exceptions -- test fixture: argv is restored in the finally
        try {
            process.argv = ['node', 'wp-review-upsert-pr', '--nope'];
            expect((): unknown => cliArgs.parse(flagUsage)).toThrow(CliExitError);
        } finally {
            process.argv = argv;
        }
    });
});

/**
 * A value-taking flag: `wp-push-dev --resolve [<branch>]`. The value is OPTIONAL — bare means "every
 * other copy", with an argument means "just that one" — so the parser has to distinguish a following
 * BRANCH NAME from a following FLAG, and neither may be mistaken for an unknown token.
 */
const valueUsage = new CliUsage('wp-push-dev', 'Publish a disposable dev copy.', [
    new CliFlag('--resolve', 'Compose the other copies onto this one.', true),
    new CliFlag('--force', 'Discard a published resolution.'),
]);

function parseArgv(...args: string[]): ReturnType<CliArgs['parse']> {
    const argv = process.argv;
    // webpieces-disable no-unmanaged-exceptions -- test fixture: argv is restored in the finally
    try {
        process.argv = ['node', 'wp-push-dev', ...args];
        return cliArgs.parse(valueUsage);
    } finally {
        process.argv = argv;
    }
}

describe('CliArgs — value-taking flags', () => {
    it('accepts the flag bare, with no value', () => {
        const parsed = parseArgv('--resolve');
        expect(parsed.has('--resolve')).toBe(true);
        expect(parsed.value('--resolve')).toBe('');
    });

    it('consumes a following non-flag token as the value', () => {
        expect(parseArgv('--resolve', 'dean/ONE-2275').value('--resolve')).toBe('dean/ONE-2275');
    });

    it('accepts the --flag=value form', () => {
        expect(parseArgv('--resolve=dean/ONE-2275').value('--resolve')).toBe('dean/ONE-2275');
    });

    it('does NOT swallow a following flag as the value', () => {
        const parsed = parseArgv('--resolve', '--force');
        expect(parsed.value('--resolve')).toBe('');
        expect(parsed.has('--force')).toBe(true);
    });

    it('still rejects an undeclared token — a mistype must never silently run the flow', () => {
        expect((): unknown => parseArgv('--resolv', 'x')).toThrow(CliExitError);
    });

    it('rejects a value handed to a flag that takes none, rather than dropping it', () => {
        expect((): unknown => parseArgv('--force=yes')).toThrow(CliExitError);
    });

    it('shows the value placeholder in --help', () => {
        expect(cliArgs.classify(['--help'], valueUsage).message).toContain('--resolve [<value>]');
    });
});
