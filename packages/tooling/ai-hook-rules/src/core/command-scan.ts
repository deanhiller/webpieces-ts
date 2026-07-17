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
        const segments: string[] = [];
        let current = '';
        let quote: string | null = null;

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

            if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
                // Consume the second char of `&&` / `||` so it does not start an empty segment.
                if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
                segments.push(current);
                current = '';
                continue;
            }

            current += ch;
        }
        segments.push(current);

        return segments.map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    }

    /**
     * The git subcommand a segment invokes, or null when the segment does not invoke git at all
     * (a different program, a mere mention inside quotes, an empty segment).
     *
     * Returns the subcommand as an EXACT token: `git merge-base …` yields `'merge-base'`, never `'merge'`.
     */
    gitSubcommand(segment: string): string | null {
        const tokens = this.stripPrefixes(this.tokenize(segment));
        if (tokens.length === 0 || tokens[0] !== 'git') return null;

        let i = 1;
        while (i < tokens.length) {
            const token = tokens[i];
            if (GIT_FLAGS_WITH_VALUE.has(token)) { i += 2; continue; }
            // `--git-dir=/x` style (value attached) and any other global flag.
            if (token.startsWith('-')) { i++; continue; }
            return token;
        }
        return null;
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
