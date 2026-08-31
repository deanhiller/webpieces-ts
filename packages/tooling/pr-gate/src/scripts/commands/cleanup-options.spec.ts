import { describe, it, expect } from 'vitest';
import { CliArgs, CliExitError } from '@webpieces/rules-config';

import {
    CleanupUsage,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
    FLAG_INTERACTIVE,
    FLAG_REPORT,
    FLAG_IGNORE_STALE_LOCKS,
    SELECTION_ALL,
    SELECTION_NONE,
    SELECTION_NUMBERS,
    SELECTION_UNSET,
} from './cleanup-options';

/**
 * The FLAG half of wp-cleanup, on its own: what a `--delete-*` value parses to, and what `--help`
 * tells a caller. cleanup-command.spec.ts covers what the command then does with it.
 */
describe('DeleteSelection', () => {
    it('reads all / none / numbers, and an absent flag as unset', () => {
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'all').mode).toBe(SELECTION_ALL);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'NONE').mode).toBe(SELECTION_NONE);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, false, '').mode).toBe(SELECTION_UNSET);

        const numbers = new DeleteSelection(FLAG_DELETE_WORKTREES, true, '1, 3');
        expect(numbers.mode).toBe(SELECTION_NUMBERS);
        expect([...numbers.numbers]).toEqual([1, 3]);
    });

    // Only an explicit flag is an answer. `unset` must not read as either yes or no.
    it('reports whether the caller said anything at all', () => {
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, false, '').given()).toBe(false);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'none').given()).toBe(true);
    });

    /**
     * Garbage never becomes a silent `none` — and far more importantly, never a silent `all`. A bare
     * `--delete-branches` is garbage for the same reason: "all" and "none" are both defensible
     * readings of it, and a delete is not a thing to pick a reading for.
     */
    it('refuses a value that is neither all, none, nor numbers', () => {
        expect(() => new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'yes please')).toThrow(CliExitError);
        expect(() => new DeleteSelection(FLAG_DELETE_BRANCHES, true, '')).toThrow(CliExitError);
        expect(() => new DeleteSelection(FLAG_DELETE_BRANCHES, true, '0')).toThrow(CliExitError);
        expect(() => new DeleteSelection(FLAG_DELETE_BRANCHES, true, '-2')).toThrow(CliExitError);
    });

    // THE NUMBERING CONTRACT. A number past the end of the block means the caller is holding numbers
    // from an earlier run — the refs have moved under them, so the run stops instead of guessing.
    it('refuses a number outside the block it was given, naming the way back', () => {
        const selection = new DeleteSelection(FLAG_DELETE_BRANCHES, true, '1,4');

        expect(() => selection.pick(['a', 'b'])).toThrow(/--report/);
    });

    it('picks by the printed numbers, in the order given', () => {
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, '3,1').pick(['a', 'b', 'c']))
            .toEqual(['c', 'a']);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'all').pick(['a', 'b'])).toEqual(['a', 'b']);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, true, 'none').pick(['a', 'b'])).toEqual([]);
        expect(new DeleteSelection(FLAG_DELETE_BRANCHES, false, '').pick(['a', 'b'])).toEqual([]);
    });
});

describe('wp-cleanup --help', () => {
    // A flag that works but is undocumented, and one documented but rejected, are the same defect
    // seen from the two ends — so the declared list is asserted to carry every one of them.
    it('lists every flag the command honours', () => {
        const check = new CliArgs().classify(['--help'], new CleanupUsage().declare());

        expect(check.ok).toBe(false);
        expect(check.exitCode).toBe(0);
        expect(check.message).toContain(FLAG_DELETE_BRANCHES);
        expect(check.message).toContain(FLAG_DELETE_WORKTREES);
        expect(check.message).toContain(FLAG_REPORT);
        expect(check.message).toContain(FLAG_INTERACTIVE);
        expect(check.message).toContain(FLAG_IGNORE_STALE_LOCKS);
    });

    // The guard that makes the flags safe to add at all: an undeclared token is still fatal.
    it('still rejects a mistyped flag with exit 2', () => {
        const check = new CliArgs().classify(['--delete-branchs=all'], new CleanupUsage().declare());

        expect(check.ok).toBe(false);
        expect(check.exitCode).toBe(2);
    });
});
