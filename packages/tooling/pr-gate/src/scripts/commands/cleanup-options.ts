import { CliExitError, CliFlag, CliUsage } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * `wp-cleanup`'s flags, parsed — the whole decision about what this run deletes, as a value.
 *
 * WHY A CLASS AND NOT A BAG OF BOOLEANS THREADED THROUGH ARGUMENTS: the decision "delete these
 * worktrees / those branches / nothing at all" is ONE thing, made once at the bin, and every method
 * downstream has to agree about it. Passed as separate parameters it becomes four independent
 * arguments that a new call site can get half-right — and half-right, here, means deleting a ref
 * nobody chose. Same argument BuildOptions makes for its single `force` field.
 */

// The flag names, shared by the bin (which declares them to CliArgs) and by the parser below, so the
// spelling a caller is told about and the spelling that is honoured can never drift apart.
export const FLAG_DELETE_BRANCHES = '--delete-branches';
export const FLAG_DELETE_WORKTREES = '--delete-worktrees';
export const FLAG_REPORT = '--report';
export const FLAG_INTERACTIVE = '--interactive';

// What a `--delete-*` flag said. UNSET is "the flag was not passed at all" and is a genuinely
// different answer from NONE: unset defers to the tty sniff, NONE is a caller saying no out loud.
export const SELECTION_UNSET = 'unset';
export const SELECTION_ALL = 'all';
export const SELECTION_NONE = 'none';
export const SELECTION_NUMBERS = 'numbers';

/**
 * One `--delete-branches=` / `--delete-worktrees=` answer: `all`, `none`, or the numbers printed in
 * the classified block on this run.
 *
 * THE NUMBERING CONTRACT: `numbers` index the block wp-cleanup just printed, 1-based, and an index
 * outside that block is a hard failure rather than a silent skip. A number that lands on the wrong
 * ref is the single way this command can delete something nobody asked for, so "the list moved under
 * me" must stop the run, not quietly delete four of the five refs the caller meant.
 */
export class DeleteSelection {
    readonly mode: string;
    readonly numbers: readonly number[];
    private readonly flag: string;

    /**
     * ONE constructor, taking argv's two facts about the flag: was it there, and what did it carry.
     *
     * Parsing in the constructor rather than in a static factory is what keeps this to one spelling —
     * there is no way to hold a DeleteSelection that was never checked. `present === false` is the
     * absent flag (the run falls back to its tty sniff); present with an EMPTY value is an error, not
     * an implicit `all` and not an implicit `none`: both readings are defensible, which is exactly
     * why neither may be guessed at when the outcome is a delete.
     */
    constructor(flag: string, present: boolean, raw: string) {
        this.flag = flag;
        this.numbers = [];
        if (!present) {
            this.mode = SELECTION_UNSET;
            return;
        }
        const value = raw.trim().toLowerCase();
        if (value === '') throw this.usage('a value is required.');
        if (value === SELECTION_ALL || value === SELECTION_NONE) {
            this.mode = value;
            return;
        }
        this.mode = SELECTION_NUMBERS;
        this.numbers = this.parseNumbers(value, raw);
    }

    private parseNumbers(value: string, raw: string): number[] {
        const numbers: number[] = [];
        for (const token of value.split(/[\s,]+/)) {
            if (token === '') continue;
            const index = Number(token);
            if (!Number.isInteger(index) || index < 1) {
                throw this.usage(`'${raw}' — '${token}' is not one of the numbers printed.`);
            }
            numbers.push(index);
        }
        if (numbers.length === 0) throw this.usage(`'${raw}' named no numbers.`);
        return numbers;
    }

    /** Did the caller say anything? An explicit flag ALWAYS beats the terminal sniff. */
    given(): boolean {
        return this.mode !== SELECTION_UNSET;
    }

    /**
     * The chosen entries out of the block that was just printed.
     *
     * Range is checked against THAT block: a number past its end means the caller is holding numbers
     * from an older run, and the refs have moved under them. That stops the run.
     */
    pick<T>(block: readonly T[]): T[] {
        if (this.mode === SELECTION_ALL) return [...block];
        if (this.mode === SELECTION_NONE || this.mode === SELECTION_UNSET) return [];
        const out: T[] = [];
        for (const index of this.numbers) {
            if (index > block.length) {
                throw this.usage(
                    `it names [${String(index)}], but the list above has only ${String(block.length)} entr(ies).\n`
                    + 'Those numbers came from a different run. Re-run `pnpm wp-cleanup --report`, read the\n'
                    + 'numbers it prints, and pass those — nothing was deleted from that list.');
            }
            out.push(block[index - 1]);
        }
        return out;
    }

    private usage(detail: string): CliExitError {
        return new CliExitError(2,
            `❌ ${this.flag}: ${detail}\n\n`
            + `Usage:  ${this.flag}=all | ${this.flag}=none | ${this.flag}=1,3\n`
            + 'The numbers are the ones wp-cleanup printed in the classified block on the SAME run.');
    }
}

/**
 * Everything argv said about this cleanup run.
 *
 * `report` prints the full classified report and deletes NOTHING — the print-and-exit case, and the
 * one honest way to get numbers that are still valid on the next command, because a run that deletes
 * nothing cannot renumber anything.
 *
 * `interactive` forces the prompt when stdin is not a tty. It exists because `process.stdin.isTTY`
 * was never a fact about who is standing there, only a proxy: a human running
 * `pnpm wp-cleanup | tee log` has no tty, and an agent on a pty has one. The sniff stays as the
 * DEFAULT, and any explicit flag beats it.
 */
export class CleanupOptions {
    readonly branches: DeleteSelection;
    readonly worktrees: DeleteSelection;
    readonly report: boolean;
    readonly interactive: boolean;

    // Every parameter REQUIRED, no defaults — same reasoning as BuildOptions: a defaulted parameter
    // means a call site written before this class grew a field silently keeps the old behaviour, and
    // the old behaviour here is "delete without being told to".
    constructor(
        branches: DeleteSelection,
        worktrees: DeleteSelection,
        report: boolean,
        interactive: boolean,
    ) {
        this.branches = branches;
        this.worktrees = worktrees;
        this.report = report;
        this.interactive = interactive;
    }

    /**
     * Does this run get to ASK? A tty is the default evidence; `--interactive` says so outright.
     * A `--delete-*` flag overrides both for the half it names — see `CleanupCommand.decide`.
     */
    prompts(): boolean {
        return this.interactive || process.stdin.isTTY === true;
    }
}

/**
 * What `wp-cleanup --help` prints, and the ONE list CliArgs validates argv against.
 *
 * It lives here rather than inline in the bin so a spec can assert that every flag this command
 * honours is a flag it also tells you about. A flag that works but is undocumented, or documented but
 * rejected, is the same defect from either side — and the bin itself is a `runMain` call that cannot
 * be imported into a test without executing.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanupUsage {
    declare(): CliUsage {
        return new CliUsage(
            'wp-cleanup',
            'Remove worktrees and branches that are provably dead, reap the zero-commit husks, and report the rest.',
            [
                new CliFlag(FLAG_DELETE_BRANCHES,
                    'all | none | 1,3 — which of the classified BRANCHES to delete. The\n'
                    + '                                numbers are the ones printed in the same run\'s block.', true),
                new CliFlag(FLAG_DELETE_WORKTREES,
                    'all | none | 1,3 — the same, for the classified WORKTREES.', true),
                new CliFlag(FLAG_REPORT,
                    'Print the full classified report and exit. Deletes NOTHING — the only\n'
                    + '                                run whose numbers are still valid for the next command.'),
                new CliFlag(FLAG_INTERACTIVE,
                    'Prompt even when stdin is not a terminal.'),
            ]);
    }
}
