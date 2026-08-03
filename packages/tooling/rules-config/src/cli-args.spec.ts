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
