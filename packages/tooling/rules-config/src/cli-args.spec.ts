import { describe, it, expect } from 'vitest';
import { CliArgs, CliUsage } from './cli-args';
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
