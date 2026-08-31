import * as fs from 'fs';
import * as path from 'path';

/**
 * READ PARITY, and it is a CODEX-ONLY surface.
 *
 * Claude Code has a first-class `Read` tool, so the read-scoped guard (read-stale-guard) and the
 * `calls/` audit trail see every file the agent opens. Codex has no such tool: a file read arrives as
 * `Bash` running `sed -n '1,240p' <path>` (measured). Without this, every Codex read is invisible to
 * the read guard and to the audit log, and the two harnesses cannot be compared at all.
 *
 * The caller gates this on `aiType === 'codex'`. Nothing here is reachable from a Claude Code payload,
 * and a spec pins that.
 *
 * DELIBERATELY CONSERVATIVE, because a false positive here is not a missed read — it is a Read GUARD
 * verdict applied to a command that was never a read, i.e. a new way to block work:
 *
 *  - ONE command only. Any `;` `&&` `||` `|` backtick `$(` or redirect and the answer is "not a read";
 *    the command still runs the ordinary bash guards, exactly as today.
 *  - `argv[0]` must be one of the six pure pagers, or `sed -n '<range>p'`.
 *  - EVERY non-flag argument must resolve to a file that exists inside the tree. `cat /etc/passwd` is
 *    not a read of this repo, and neither is a heredoc.
 *
 * A match does NOT replace the bash guards — the caller runs BOTH, and either may deny.
 */
export const READ_COMMANDS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat']);

/** Shell syntax that makes a command more than one command, or redirects it. Any hit ⇒ not a read. */
const NOT_ONE_COMMAND = /[;|&`<>]|\$\(/;

/** Flags that consume the FOLLOWING token as their value, so it is never mistaken for a file. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-n', '-c', '-b', '-e', '-f']);

/**
 * The only `sed` script shape that is a read: a line range printed with `-n` — as a regex BODY, so the
 * L0 allowlist's ERE twin can be built from the same characters instead of retyping them.
 *
 * EXPORTED for `bin/l0-allowlist.ts`. The L0 entry that lets a Codex session read its way out of an L0
 * fault has to mean the same thing as this module or the two definitions of "read-shaped" drift, and a
 * drifted L0 entry is either a hole or a deadlock. It cannot literally CALL this module — L0's sh half
 * has no JS at all — so the shared thing is the vocabulary, and `codex-l0-read.spec.ts` asserts the two
 * agree over a corpus.
 */
export const SED_RANGE_BODY = '[0-9]+(,[0-9]+)?p';

const SED_RANGE = new RegExp('^' + SED_RANGE_BODY + '$');

export class ShellReadParity {
    /**
     * The absolute paths this command reads, or an empty list when it is not a read-shaped command.
     * `root` is the tree the read must fall inside; a path outside it is not this repo's read.
     */
    readTargets(command: string, cwd: string, root: string): readonly string[] {
        const trimmed = command.trim();
        if (trimmed === '' || NOT_ONE_COMMAND.test(trimmed)) return [];
        const tokens = this.tokenize(trimmed);
        if (tokens === null || tokens.length < 2) return [];

        const argv0 = tokens[0];
        const rest = argv0 === 'sed' ? this.sedOperands(tokens.slice(1)) : (READ_COMMANDS.has(argv0) ? tokens.slice(1) : null);
        if (rest === null) return [];

        const files: string[] = [];
        let index = 0;
        while (index < rest.length) {
            const token = rest[index];
            if (token.startsWith('-') && token !== '-') {
                if (VALUE_FLAGS.has(token)) index += 1;
                index += 1;
                continue;
            }
            const resolved = path.resolve(cwd, token);
            if (!this.isFileInTree(resolved, root)) return [];
            files.push(resolved);
            index += 1;
        }
        return files;
    }

    /**
     * `sed`'s operands, or null when this `sed` invocation is not a plain range print. `-n` and a
     * single `<range>p` script are BOTH required: without `-n` sed echoes and edits, and any other
     * script is a transformation, not a read.
     */
    private sedOperands(args: readonly string[]): readonly string[] | null {
        if (!args.includes('-n')) return null;
        const scripts = args.filter((a: string): boolean => !a.startsWith('-'));
        if (scripts.length < 2) return null;
        if (!SED_RANGE.test(scripts[0])) return null;
        return scripts.slice(1);
    }

    private isFileInTree(resolved: string, root: string): boolean {
        const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
        if (!resolved.startsWith(rootWithSep)) return false;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(resolved).isFile();
        } catch (err: unknown) {
            // Nothing is swallowed here: a token we cannot stat is simply NOT a read target, which is an
            // ANSWER, and the command still runs the ordinary bash guards either way. The commented-out
            // toError() call below is the form `catch-error-pattern` requires for a deliberately ignored
            // error — it is the rule's spelling of "ignored on purpose", not a disabled line.
            //const error = toError(err);
            return false;
        }
    }

    /**
     * Split on whitespace, honouring single and double quotes. Returns null on an unterminated quote —
     * a command we cannot read confidently is never a read.
     *
     * There is no escape or expansion handling here on purpose: `NOT_ONE_COMMAND` has already refused
     * everything carrying shell syntax, so what reaches this is a literal argv.
     */
    private tokenize(command: string): readonly string[] | null {
        const tokens: string[] = [];
        let current = '';
        let quote = '';
        let started = false;
        for (const ch of command) {
            if (quote !== '') {
                if (ch === quote) quote = '';
                else current += ch;
                continue;
            }
            if (ch === '\'' || ch === '"') { quote = ch; started = true; continue; }
            if (ch === ' ' || ch === '\t' || ch === '\n') {
                if (started) tokens.push(current);
                current = '';
                started = false;
                continue;
            }
            current += ch;
            started = true;
        }
        if (quote !== '') return null;
        if (started) tokens.push(current);
        return tokens;
    }
}
