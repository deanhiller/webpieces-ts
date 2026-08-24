/**
 * Shared shell-command scanning for the bash guards.
 *
 * A guard that bans a command family (`git merge`, `git push`, …) must answer one question
 * precisely: *does this command actually invoke `git <subcommand>`?* A bare
 * `/\bgit\s+merge\b/.test(command)` gets that wrong in both directions:
 *
 *  - False positive: `grep 'git merge main' notes.md` or `echo "git rebase main"` merely MENTION
 *    the phrase. A diagnostic grep was blocked this way while triaging the incident that motivated
 *    the merge/rebase ban.
 *  - False positive: `\b` sits between `e` and `-`, so `/\bgit\s+merge\b/` matches the read-only
 *    `git merge-base origin/main HEAD` — which appears in this repo's own documented build command.
 *
 * Both classes vanish if you tokenize instead of substring-match: a command invokes git only when a
 * segment's first word IS `git`, and the subcommand is then an exact token (`merge-base` is simply
 * not the token `merge`). No lookahead regex needed.
 */

// Wrappers/prefixes that may precede the real command word (`sudo git merge`, `GIT_DIR=x git merge`).
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'nohup', 'time', 'env', 'exec']);

// git's own global flags that consume the FOLLOWING token as their value, so
// `git -C /some/path merge main` still resolves to the `merge` subcommand.
const GIT_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
    '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Package-manager wrappers that precede the real program (`pnpm exec vitest`, `npx nx`, `yarn build-all`).
const RUNNERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx']);

// The runner's own verb, consumed with it: `pnpm run build-all` and `pnpm build-all` are one command.
const RUNNER_VERBS: ReadonlySet<string> = new Set(['run', 'run-script', 'exec', 'dlx', 'x']);

/**
 * One invoked segment of a command, plus whether a PIPE fed it.
 *
 * `pipedInto` is what separates `git log | grep foo` (grep consumes the pipe — reads no file) from
 * `grep foo src/` (grep reads the working tree). A guard that cares about which FILES a command
 * reads cannot tell those apart from the segment text alone, because splitting on `|` throws exactly
 * that fact away. Data-only, so a class (per CLAUDE.md).
 */
export class CommandSegment {
    text: string;
    pipedInto: boolean;

    constructor(text: string, pipedInto: boolean) {
        this.text = text;
        this.pipedInto = pipedInto;
    }
}

export class CommandScanner {
    /**
     * Split a raw command into individually-invoked segments.
     *
     * Splits on `&&`, `||`, `;`, `|`, `&`, newline, and the `(`/`)` of subshells and `$(…)` command
     * substitution — the last of these matters, since it means `--base=$(git rebase main)` is scanned
     * as its own `git rebase main` segment rather than hiding inside a `pnpm …` segment.
     *
     * Quoted spans are opaque: a separator inside quotes is literal text, so
     * `git commit -m "fix; ship it"` stays one segment. (Corollary: a `$(…)` nested inside double
     * quotes is not split out. Bash would expand it; we do not scan it. Contrived enough to accept.)
     */
    commandSegments(command: string): readonly string[] {
        return this.segmentsWithPipes(command).map((s: CommandSegment): string => s.text);
    }

    /**
     * commandSegments, but each segment also carries whether the separator BEFORE it was a pipe.
     * Only a guard reasoning about which files a segment reads needs that; everything else uses
     * commandSegments, which is this method with the flag dropped.
     */
    segmentsWithPipes(command: string): readonly CommandSegment[] {
        const segments: CommandSegment[] = [];
        let current = '';
        let quote: string | null = null;
        let piped = false;      // was the separator that ENDED the previous segment a pipe?

        for (let i = 0; i < command.length; i++) {
            const ch = command[i];

            if (quote !== null) {
                current += ch;
                // A backslash-escaped quote does not close the span (only meaningful inside "…").
                if (ch === quote && command[i - 1] !== '\\') quote = null;
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch;
                current += ch;
                continue;
            }

            // The `&` of a REDIRECTION (`2>&1`, `1>&2`, `&>log`) is not a separator. Splitting on it
            // tore `git fetch origin main 2>&1 | tail -5` into THREE segments — `git fetch … 2>`, `1`
            // and `tail -5` — and the bare `1` is not an allowlisted command, so every guard that
            // requires all segments to pass denied the command. That is `2>&1`, the single most common
            // decoration an agent appends.
            if (ch === '&' && command[i + 1] !== '&' && (current.trimEnd().endsWith('>') || command[i + 1] === '>')) {
                current += ch;
                continue;
            }

            if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
                // Consume the second char of `&&` / `||` so it does not start an empty segment.
                const doubled = (ch === '|' || ch === '&') && command[i + 1] === ch;
                if (doubled) i++;
                segments.push(new CommandSegment(current, piped));
                // `|` pipes into the next segment; `||` is a separator, not a pipe.
                piped = ch === '|' && !doubled;
                current = '';
                continue;
            }

            current += ch;
        }
        segments.push(new CommandSegment(current, piped));

        return segments
            .map((s: CommandSegment): CommandSegment => new CommandSegment(s.text.trim(), s.pipedInto))
            .filter((s: CommandSegment): boolean => s.text.length > 0);
    }

    /**
     * One segment's shell words, with wrappers/env-assignments stripped, so `words('sudo cat a b')`
     * is `['cat', 'a', 'b']`. The public view of the same tokenizer gitSubcommand uses — a guard that
     * must inspect a NON-git command's arguments (which paths does this `grep` actually read?) needs
     * the tokens, and re-splitting on whitespace in the guard would get quoting wrong.
     */
    words(segment: string): readonly string[] {
        return this.stripPrefixes(this.tokenize(segment));
    }

    /**
     * The git subcommand a segment invokes, or null when the segment does not invoke git at all
     * (a different program, a mere mention inside quotes, an empty segment).
     *
     * Returns the subcommand as an EXACT token: `git merge-base …` yields `'merge-base'`, never `'merge'`.
     */
    gitSubcommand(segment: string): string | null {
        return this.gitSubcommandOf(this.stripPrefixes(this.tokenize(segment)));
    }

    /**
     * gitSubcommand, for a caller that already holds the segment's effective words (ShellSegmentScan
     * strips leading shell keywords, so `do git status` must be resolved from ITS words, not from the
     * raw segment text where `do` is the command).
     */
    gitSubcommandOf(words: readonly string[]): string | null {
        const tokens = this.stripPrefixes(words);
        const at = this.gitSubcommandIndex(tokens);
        return at === -1 ? null : tokens[at];
    }

    /**
     * The ARGUMENTS following `git <subcommand>` in this segment, or null when the segment does not
     * invoke that subcommand.
     *
     * `gitSubcommand` answers *which* subcommand; a guard that judges the subcommand's own flags needs
     * the tokens after it, and slicing them in the guard would mean re-deriving where the subcommand
     * sits — i.e. re-deriving the `sudo` / `env VAR=x` / `-C <path>` skipping this class exists to own.
     * `git -C /x commit -m "msg"` yields `['-m', 'msg']`, never `['/x', 'commit', '-m', 'msg']`.
     *
     * The tokens are QUOTE-STRIPPED (see tokenize), so a quoted argument arrives as ONE token holding
     * its literal text — newlines, backticks and all. That is what makes an argument's CONTENT
     * inspectable at all.
     */
    gitSubcommandArgs(segment: string, subcommand: string): readonly string[] | null {
        const tokens = this.stripPrefixes(this.tokenize(segment));
        const at = this.gitSubcommandIndex(tokens);
        if (at === -1 || tokens[at] !== subcommand) return null;
        return tokens.slice(at + 1);
    }

    /** Index of the subcommand token in already-prefix-stripped words, or -1 when git is not invoked. */
    private gitSubcommandIndex(tokens: readonly string[]): number {
        if (tokens.length === 0 || tokens[0] !== 'git') return -1;

        let i = 1;
        while (i < tokens.length) {
            const token = tokens[i];
            if (GIT_FLAGS_WITH_VALUE.has(token)) { i += 2; continue; }
            // `--git-dir=/x` style (value attached) and any other global flag.
            if (token.startsWith('-')) { i++; continue; }
            return i;
        }
        return -1;
    }

    /**
     * The segment's words with the package-manager WRAPPER stripped, so `pnpm exec vitest run` and
     * `vitest run` reduce to the same words. `pnpm --silent run build-all` → `['build-all']`.
     *
     * Lives HERE rather than in a guard because two guards now need it and they must agree: one blocks a
     * whole-repo build, the other blocks piping a build's output. If they disagreed about whether
     * `npx wp-build` is `wp-build`, one of them would have a spelling-shaped side door — which is exactly
     * the failure mode the runner stripping exists to close.
     */
    runnerStrippedWords(segment: string): readonly string[] {
        let words = this.words(segment);
        while (words.length > 0 && RUNNERS.has(this.programName(words[0]))) {
            words = words.slice(1);
            // The runner's own flags (`--silent`, `-r`) sit between it and the program.
            while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1);
            if (words.length > 0 && RUNNER_VERBS.has(words[0])) words = words.slice(1);
        }
        return words;
    }

    /** `./node_modules/.bin/nx` and `/usr/local/bin/pnpm.cmd` are the programs `nx` and `pnpm`. */
    programName(token: string): string {
        const base = token.split('/').pop() ?? token;
        return base.endsWith('.cmd') ? base.slice(0, -'.cmd'.length) : base;
    }

    /** True when a package-manager runner precedes the program (`pnpm …`, `npx …`). */
    viaRunner(segment: string): boolean {
        const raw = this.words(segment);
        return raw.length > 0 && RUNNERS.has(this.programName(raw[0]));
    }

    /** True when this segment actually invokes `git <subcommand>`. */
    invokesGit(segment: string, subcommand: string): boolean {
        return this.gitSubcommand(segment) === subcommand;
    }

    /** True when ANY segment of the command invokes one of `subcommands`. */
    commandInvokesAnyGit(command: string, subcommands: readonly string[]): boolean {
        return this.commandSegments(command).some((seg: string) =>
            subcommands.some((sub: string) => this.invokesGit(seg, sub)));
    }

    /**
     * Split one segment into shell words, dropping quote characters (so the ARGUMENT of
     * `echo "git merge main"` is the single word `git merge main`, never the word `git`).
     */
    private tokenize(segment: string): readonly string[] {
        const tokens: string[] = [];
        let current = '';
        let started = false;
        let quote: string | null = null;

        for (let i = 0; i < segment.length; i++) {
            const ch = segment[i];

            if (quote !== null) {
                if (ch === quote) quote = null;
                else current += ch;
                started = true;
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch;
                started = true;
                continue;
            }

            if (/\s/.test(ch)) {
                if (started) {
                    tokens.push(current);
                    current = '';
                    started = false;
                }
                continue;
            }

            current += ch;
            started = true;
        }
        if (started) tokens.push(current);

        return tokens;
    }

    private stripPrefixes(tokens: readonly string[]): readonly string[] {
        let i = 0;
        while (i < tokens.length) {
            const token = tokens[i];
            if (COMMAND_PREFIXES.has(token)) { i++; continue; }
            if (ENV_ASSIGNMENT.test(token)) { i++; continue; }
            break;
        }
        return tokens.slice(i);
    }
}
