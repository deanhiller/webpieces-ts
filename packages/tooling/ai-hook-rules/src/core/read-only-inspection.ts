import * as path from 'path';

import { CommandScanner, CommandSegment } from './command-scan';
import { ShellSegmentScan } from './rules/shell-segment-scan';

/**
 * Is this shell command pure INSPECTION — can it be trusted to change nothing?
 *
 * WHY this exists: when webpieces.config.json cannot be loaded (unparseable, or invalid against the
 * installed validator) every bash command is denied, because with no config there are no guards and
 * fail-closed is the only safe answer. That is right for work — and catastrophic for recovery, because
 * the denial also took out `cat`, `grep` and `sed -n` against webpieces.config.json itself. The guard
 * blocked the exact tools needed to see and fix the problem it was reporting, which is a dead end an
 * agent cannot escape from inside the session. (Reproduced live: mid-merge, the config legitimately
 * held `<<<<<<< HEAD` markers and every attempt to look at it was refused.)
 *
 * The rest of the system already models the escape hatch correctly — reading AND editing
 * webpieces.config.json is always allowed (hook-core's config bypass, the stale-shim recovery
 * carve-out, ContentReadScan's escape-hatch paths). This closes the one place that did not honour it.
 *
 * The bar is deliberately paranoid, because this is a bypass of ALL guards:
 *   - every invoked segment's command word must be an allowlisted inspector;
 *   - `git`/`gh` are excluded outright, even their read-only subcommands — the guards exist to police
 *     git, and "read-only git" is not a line worth drawing while flying blind;
 *   - any output redirect to a file (`> x`, `>> x`) makes the command a writer;
 *   - the in-place/mutating flags of otherwise-read-only tools (`sed -i`, `find -delete`) are refused.
 * Anything not provably inert stays blocked.
 */
export class ReadOnlyInspectionScan {
    private readonly shell: ShellSegmentScan;

    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {
        this.shell = new ShellSegmentScan(this.scanner);
    }

    /** True only when EVERY segment of the command is provably inert. Empty command → false. */
    isReadOnlyInspection(command: string): boolean {
        const segments = this.scanner.segmentsWithPipes(command);
        if (segments.length === 0) return false;
        return segments.every((segment: CommandSegment): boolean => this.segmentIsInert(segment));
    }

    private segmentIsInert(segment: CommandSegment): boolean {
        const words = this.shell.effectiveWords(segment.text);
        if (words.length === 0) return true;            // pure shell structure (`done`, `fi`)
        if (this.redirectsToFile(words)) return false;  // `… > file` writes, whatever the command is
        const head = path.basename(words[0]);
        if (!INSPECTORS.has(head)) return false;
        return !this.hasMutatingFlag(head, words.slice(1));
    }

    // `>`, `>>`, `>out.txt`, `2>log` — but NOT `2>&1`/`1>&2`, which only rewire fds and are the single
    // most common decoration an agent appends to a diagnostic command.
    private redirectsToFile(words: readonly string[]): boolean {
        return words.some((word: string): boolean => REDIRECT_TO_FILE.test(word));
    }

    // Read-only tools that grow teeth with one flag: `sed -i` rewrites in place, `find -delete`/`-exec`
    // runs arbitrary commands. Matching is prefix-based so `-i.bak` and `-inplace` are caught too.
    private hasMutatingFlag(head: string, args: readonly string[]): boolean {
        const mutating = MUTATING_FLAGS[head];
        if (!mutating) return false;
        return args.some((arg: string): boolean => mutating.some((flag: string): boolean => arg.startsWith(flag)));
    }
}

// Commands whose entire job is showing what is already there. Kept to viewers/searchers/formatters:
// no package managers, no build or test runners, no interpreters, no git.
const INSPECTORS: ReadonlySet<string> = new Set([
    'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'rev', 'strings', 'xxd', 'od',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq', 'yq',
    'ls', 'find', 'tree', 'wc', 'diff', 'cmp', 'file', 'stat', 'realpath', 'readlink',
    'basename', 'dirname', 'sort', 'uniq', 'cut', 'tr', 'column', 'fold', 'expand',
    'echo', 'printf', 'true', 'false', ':', 'cd', 'pwd', 'which', 'test', '[',
]);

// Per-command flags that turn an inspector into a mutator.
const MUTATING_FLAGS: Readonly<Record<string, readonly string[]>> = {
    sed: ['-i', '--in-place'],
    find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'],
    awk: ['-i'],
    sort: ['-o', '--output'],
};

const REDIRECT_TO_FILE = /^\d*>>?(?!&)/;
