import { CommandScanner, CommandSegment } from '../command-scan';
import { ShellSegmentScan } from './shell-segment-scan';

/**
 * Decides the one question `build-output-pipe-guard` asks: does this command BOUND the output of a
 * webpieces command that already writes its output to a file?
 *
 * ─── The three commands, and why only these three ──────────────────────────────────────────────────
 * `wp-build`, `wp-review-upsert-pr` and `wp-finish-upsert-pr` are the commands that RUN A BUILD. Each
 * one redirects the build's full stdout+stderr to a log file, prints a ~10-second heartbeat while it
 * runs, and ends with a `FullLog :` pointer at the file. Nothing else in the `wp-*` family both takes
 * minutes and writes a log, so nothing else belongs on this list — a guard that also refused
 * `pnpm wp-cleanup | tail` would be refusing something with no cure.
 *
 * ─── What is a hit ─────────────────────────────────────────────────────────────────────────────────
 *   BLOCKED  a PIPE out of the command — `pnpm wp-build | tail -50`, `… 2>&1 | grep error`, `| tee`.
 *            A pipe is the measured hazard and it does not depend on WHAT it feeds: the pipeline's
 *            reader (`tail`, `head`, `grep`, `wc`) withholds every byte until the writer EXITS, so the
 *            heartbeat never reaches the terminal, the harness sees a command silent for 600 seconds,
 *            and it kills a full build. Measured in this repo's own call log: 85 piped `wp-*` calls,
 *            42 of them on one of these three commands.
 *   BLOCKED  a stdout REDIRECT to a file — `pnpm wp-build > /tmp/out.log`. Same silence, and it also
 *            makes a SECOND copy of a log the command already wrote.
 *
 *   ALLOWED  the bare command, which is the whole cure.
 *   ALLOWED  `2>&1` on its own — it rewires fds and buffers nothing. `ShellSegmentScan.redirectsToFile`
 *            owns that carve-out, and it is shared rather than re-spelled here.
 *   ALLOWED  every other command, piped or not. This guard is blocklist-shaped and narrow on purpose.
 */

/** The commands whose output already goes to a file, so bounding it can only ever lose information. */
export const LOGGED_BUILD_COMMANDS: readonly string[] = [
    'wp-build', 'wp-review-upsert-pr', 'wp-finish-upsert-pr',
];

const LOGGED_SET: ReadonlySet<string> = new Set(LOGGED_BUILD_COMMANDS);

/** How the output was bounded. The two shapes read differently in a refusal, so they are named. */
export const BOUND_BY_PIPE = 'pipe';
export const BOUND_BY_REDIRECT = 'redirect';

/** One bounded invocation: WHICH command, and HOW its output was bounded. Data-only (per CLAUDE.md). */
export class BoundedOutputHit {
    command: string;
    shape: string;

    constructor(command: string, shape: string) {
        this.command = command;
        this.shape = shape;
    }
}

export class BuildOutputPipeScan {
    constructor(
        private readonly scanner: CommandScanner,
        private readonly segments: ShellSegmentScan,
    ) {}

    /** The first bounded logging command in `command`, or null when there is none. */
    firstHit(command: string): BoundedOutputHit | null {
        const parts = this.scanner.segmentsWithJoins(command);
        for (let i = 0; i < parts.length; i++) {
            const name = this.loggingCommandIn(parts[i]);
            if (name === '') continue;
            // The NEXT segment carries the separator that preceded it, so "this segment pipes OUT" is
            // "the segment after me was piped into". Splitting on `|` throws that away; CommandSegment
            // exists precisely so it does not have to be re-derived here.
            if (i + 1 < parts.length && parts[i + 1].join === '|') return new BoundedOutputHit(name, BOUND_BY_PIPE);
            if (this.segments.redirectsToFile(this.scanner.words(parts[i].text))) {
                return new BoundedOutputHit(name, BOUND_BY_REDIRECT);
            }
        }
        return null;
    }

    // The logging command this segment invokes, or '' — `pnpm wp-build`, `npx wp-build` and a bare
    // `wp-build` are one command, which is CommandScanner's `runnerStrippedWords` to decide.
    private loggingCommandIn(segment: CommandSegment): string {
        const words = this.scanner.runnerStrippedWords(segment.text);
        if (words.length === 0) return '';
        const program = this.scanner.programName(words[0]);
        return LOGGED_SET.has(program) ? program : '';
    }
}
