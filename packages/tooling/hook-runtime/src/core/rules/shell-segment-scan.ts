import * as path from 'path';

import { CommandScanner, CommandSegment } from '../command-scan';

/**
 * What ROLE one segment of a shell command plays — the question every allowlist-shaped bash guard has
 * to answer before it can judge a compound command.
 *
 * WHY this exists: `merged-branch-bash-guard` allowlists the commands that get you OFF a merged
 * branch, and the redirect it prints tells the agent to run them. An agent bounds tool output by
 * reflex, so it runs `git fetch origin main 2>&1 | tail -5` — and the guard, evaluating `tail -5` as
 * an ordinary command, denied the very remedy it had just printed. Verified pairs from the field:
 *
 *     pnpm wp-cleanup                    allowed
 *     pnpm wp-cleanup 2>&1 | tail -40    BLOCKED
 *     git fetch origin main              allowed
 *     git fetch origin main 2>&1; echo   BLOCKED
 *
 * Nothing in `| tail -40` or `; echo done` can touch the repo, and `done`/`do`/`for x in a b` are not
 * commands at all. So a segment is one of three things:
 *
 *   - STRUCTURE — pure shell syntax, invokes nothing (`for b in a b c`, `done`, `fi`).
 *   - SHAPING   — cannot change the repo: a pager/filter fed by a PIPE (`| tail`, `| head`, `| wc`),
 *                 or an always-inert command (`echo`, `cd`, `pwd`, `true`).
 *   - COMMAND   — a real invocation, with `words` giving the effective argv AFTER leading shell
 *                 keywords are stripped, so `do gh pr list` classifies as `gh pr list`.
 *
 * Two things keep SHAPING honest. A filter counts only when a PIPE fed it — bare `tail src/x.ts`
 * reads the working tree and stays a COMMAND. And a segment carrying an output REDIRECT (`> file`,
 * `>> file`) is always a COMMAND, because `echo x > src/y.ts` writes the repo. `2>&1` is not a
 * redirect to a file and is deliberately not caught.
 *
 * Deciding WHETHER a shaping segment is acceptable is still the guard's call: merged-branch-bash-guard
 * pairs this with ContentReadScan so `git status | cat src/foo.ts` (a filter with a workspace path)
 * stays blocked.
 */
export type SegmentRole = 'structure' | 'shaping' | 'command';

/** Data-only (per CLAUDE.md, classes for data). */
export class SegmentVerdict {
    role: SegmentRole;
    /** The effective argv for a COMMAND, leading shell keywords stripped. Empty for the other roles. */
    words: readonly string[];

    constructor(role: SegmentRole, words: readonly string[]) {
        this.role = role;
        this.words = words;
    }
}

export class ShellSegmentScan {
    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {}

    classify(segment: CommandSegment): SegmentVerdict {
        const words = this.stripKeywords(this.scanner.words(segment.text));
        if (words.length === 0) return STRUCTURE;

        const head = path.basename(words[0]);
        if (STRUCTURE_HEADS.has(head)) return STRUCTURE;

        // A redirect can create or overwrite a file, so it is never inert — judge it as a command.
        if (this.redirectsToFile(words)) return new SegmentVerdict('command', words);

        if (ALWAYS_INERT.has(head)) return new SegmentVerdict('shaping', words);
        if (segment.join === '|' && OUTPUT_FILTERS.has(head)) return new SegmentVerdict('shaping', words);

        return new SegmentVerdict('command', words);
    }

    /**
     * The effective argv of a segment with leading shell keywords removed — what a guard should judge
     * instead of the raw words. `for b in $(…); do git status; done` splits into three segments and
     * the middle one is literally `do git status`; without this, `do` is the command name and every
     * loop body walks straight past a git allowlist.
     */
    effectiveWords(segmentText: string): readonly string[] {
        return this.stripKeywords(this.scanner.words(segmentText));
    }

    private stripKeywords(words: readonly string[]): readonly string[] {
        let i = 0;
        while (i < words.length && STRIPPABLE_KEYWORDS.has(words[i])) i++;
        return words.slice(i);
    }

    /**
     * `>`, `>>`, `>out.txt`, `2>log` — but NOT `2>&1`/`1>&2`, which merely rewire fds.
     *
     * PUBLIC because RecoveryAllowlist asks the same question of a segment it is about to allow on the
     * strength of the program name alone (`curl`, `gh`): those cannot touch the tree by themselves, but
     * `curl … > src/x.ts` can. One implementation, so the two callers cannot disagree about what
     * counts as a redirect — the `2>&1` carve-out above is exactly the kind of detail a second copy
     * gets wrong.
     */
    redirectsToFile(words: readonly string[]): boolean {
        return words.some((word: string): boolean => REDIRECT_TO_FILE.test(word));
    }
}

const STRUCTURE = new SegmentVerdict('structure', []);

// Keywords that PRECEDE a real command; strip them and judge what follows.
const STRIPPABLE_KEYWORDS: ReadonlySet<string> = new Set([
    'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', '(', ')',
]);

// Segments that invoke nothing at all: loop/case HEADERS (their tail is a word list, and any `$(…)`
// inside was already split into its own segment by CommandScanner) and the closing keywords.
const STRUCTURE_HEADS: ReadonlySet<string> = new Set([
    'for', 'case', 'select', 'done', 'fi', 'esac', ';;', 'in',
]);

// Commands that cannot read repo content or change the repo, piped or not.
const ALWAYS_INERT: ReadonlySet<string> = new Set([
    'echo', 'printf', 'true', 'false', ':', 'cd', 'pwd', 'date', 'whoami', 'which', 'sleep', 'test', '[',
]);

// Pagers/filters that read STDIN. Only when a pipe fed them — bare, they read the working tree.
const OUTPUT_FILTERS: ReadonlySet<string> = new Set([
    'head', 'tail', 'wc', 'cat', 'less', 'more', 'nl', 'tac', 'rev', 'sort', 'uniq', 'cut', 'tr',
    'column', 'fold', 'expand', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'jq', 'yq',
]);

const REDIRECT_TO_FILE = /^\d*>>?(?!&)/;
