import { injectable, bindingScopeValues } from 'inversify';

// git's C-style quoting for the escapes it does NOT emit as octal. `\"` and `\\` are the two that
// actually show up in real paths; the control-character ones are here for completeness.
const SIMPLE_ESCAPES = new Map<string, number>([
    ['"', 0x22], ['\\', 0x5c], ['a', 0x07], ['b', 0x08], ['t', 0x09],
    ['n', 0x0a], ['v', 0x0b], ['f', 0x0c], ['r', 0x0d],
]);

const RENAME_ARROW = ' -> ';

/**
 * One entry of `git status --porcelain` (v1), already split into its two status columns and its
 * (unquoted) path, with the staged/unstaged question answered as BOOLEANS.
 *
 * The booleans are the whole point. Porcelain is `XY <path>` where X is the INDEX state and Y the
 * WORKING TREE state, so an unstaged modification is `" M path"` and a staged one is `"M  path"` —
 * they differ ONLY in which column the space lands in. Every caller that handed the raw line around
 * had to re-derive that, and the one that ran `.trim()` first got the exact INVERSE of the truth,
 * because trimming deletes the index column and shifts the worktree column into its place.
 *
 * A comment saying "do not trim" cannot stop that; a type that never exposes the columns as a
 * positional string can. Data-only (per CLAUDE.md).
 */
export class GitStatusEntry {
    /** Porcelain column 1 — the INDEX (staged) state. `' '` = nothing staged, `'?'` = untracked. */
    indexStatus: string;
    /** Porcelain column 2 — the WORKING TREE (unstaged) state. `' '` = worktree matches the index. */
    worktreeStatus: string;
    /** The path on disk, already unquoted/unescaped. For a rename this is the NEW name. */
    path: string;
    /** The OLD name of a rename/copy, `''` when the entry is not one. */
    renamedFrom: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(indexStatus: string, worktreeStatus: string, entryPath: string, renamedFrom = '') {
        this.indexStatus = indexStatus;
        this.worktreeStatus = worktreeStatus;
        this.path = entryPath;
        this.renamedFrom = renamedFrom;
    }

    /** `?? path` — the file exists on disk and nobody has ever committed or added it. */
    isUntracked(): boolean {
        return this.indexStatus === '?';
    }

    /** `!! path` — matched by .gitignore. Only ever present with `--ignored`. */
    isIgnored(): boolean {
        return this.indexStatus === '!';
    }

    /** Something is in the INDEX for this path, i.e. `git commit` would record it. */
    isStaged(): boolean {
        return !this.isUntracked() && !this.isIgnored() && this.indexStatus !== ' ';
    }

    /** The working tree differs from the index — a `git commit` right now would NOT capture it. */
    isUnstaged(): boolean {
        if (this.isIgnored()) return false;
        return this.isUntracked() || this.worktreeStatus !== ' ';
    }

    /** True when this path is fully captured by a commit made right now (committed OR staged). */
    isCommittedOrStaged(): boolean {
        return !this.isUnstaged();
    }
}

/** Where a path token ended, so the caller can look for the rename arrow after it. */
class ParsedPath {
    value: string;
    end: number;

    constructor(value: string, end: number) {
        this.value = value;
        this.end = end;
    }
}

/**
 * Parses `git status --porcelain` (v1) text into {@link GitStatusEntry} objects.
 *
 * MUST be fed UNTRIMMED text — see {@link GitStatusEntry} for why trimming inverts staged-ness. It
 * handles the two things hand-rolled `line.slice(3)` parsers historically got wrong: git QUOTES any
 * path containing a space, a quote, a backslash or a non-ASCII byte (`" M \"a b.txt\""`, with
 * non-ASCII as octal escapes), and a rename arrives as `R  old -> new` where only the NEW name is
 * the file on disk.
 */
@injectable(bindingScopeValues.Singleton)
export class GitStatusParser {
    /** Split porcelain text into entries, skipping blank lines. */
    parse(porcelain: string): GitStatusEntry[] {
        const entries: GitStatusEntry[] = [];
        for (const line of porcelain.split('\n')) {
            const entry = this.parseLine(line.replace(/\r$/, ''));
            if (entry !== null) entries.push(entry);
        }
        return entries;
    }

    /** One line → an entry, or null when the line is blank/too short to be an entry. */
    parseLine(line: string): GitStatusEntry | null {
        // `XY p` is the shortest legal entry: 2 status chars, a space, at least one path char.
        if (line.length < 4) return null;
        const indexStatus = line.charAt(0);
        const worktreeStatus = line.charAt(1);
        // ONLY an R/C entry carries the `old -> new` pair. Checking the status first means a plain path
        // that happens to contain the literal ` -> ` is never mis-split into a rename.
        const renamed = this.isRenameOrCopy(indexStatus) || this.isRenameOrCopy(worktreeStatus);
        const first = this.readPath(line, 3, renamed);
        if (renamed && line.slice(first.end, first.end + RENAME_ARROW.length) === RENAME_ARROW) {
            const second = this.readPath(line, first.end + RENAME_ARROW.length, false);
            if (second.value === '') return null;
            return new GitStatusEntry(indexStatus, worktreeStatus, second.value, first.value);
        }
        if (first.value === '') return null;
        return new GitStatusEntry(indexStatus, worktreeStatus, first.value);
    }

    private isRenameOrCopy(status: string): boolean {
        return status === 'R' || status === 'C';
    }

    // Read one path token: either a C-quoted string, or (for a rename source) everything up to the
    // arrow, or the rest of the line.
    private readPath(line: string, start: number, stopAtArrow: boolean): ParsedPath {
        if (line.charAt(start) === '"') return this.readQuoted(line, start);
        const arrow = stopAtArrow ? line.indexOf(RENAME_ARROW, start) : -1;
        const end = arrow === -1 ? line.length : arrow;
        return new ParsedPath(line.slice(start, end), end);
    }

    // Decode git's C-style quoting back to the real path. Octal escapes are BYTES, so they are
    // collected as bytes and decoded as UTF-8 at the end — decoding each one alone would mangle any
    // multi-byte character (é arrives as \303\251, two separate escapes).
    private readQuoted(line: string, start: number): ParsedPath {
        const bytes: number[] = [];
        let i = start + 1;
        while (i < line.length && line.charAt(i) !== '"') {
            if (line.charAt(i) === '\\') {
                i = this.decodeEscape(line, i + 1, bytes);
                continue;
            }
            this.pushUtf8(line.charAt(i), bytes);
            i += 1;
        }
        return new ParsedPath(Buffer.from(Uint8Array.from(bytes)).toString('utf8'), i + 1);
    }

    // Append the escape that starts at `i` (the char AFTER the backslash); return the next index.
    private decodeEscape(line: string, i: number, bytes: number[]): number {
        const escaped = line.charAt(i);
        const simple = SIMPLE_ESCAPES.get(escaped);
        if (simple !== undefined) {
            bytes.push(simple);
            return i + 1;
        }
        const octal = line.slice(i, i + 3);
        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(parseInt(octal, 8));
            return i + 3;
        }
        // Unknown escape — git would not emit one, so keep the character verbatim rather than lose it.
        this.pushUtf8(escaped, bytes);
        return i + 1;
    }

    private pushUtf8(char: string, bytes: number[]): void {
        for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte);
    }
}
