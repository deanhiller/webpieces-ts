/**
 * DOT syntax helpers
 *
 * Two small pieces that exist because a generated DOT that nobody parses is a DOT that WILL break:
 *
 * 1. `dotValue()` — the ONE place a runtime value (service name, api name, project name, title)
 *    becomes safe to interpolate into a quoted DOT string. Inlining values at each call site is how
 *    an unescaped `"` shipped and took the whole diagram down: in DOT a bare `"` TERMINATES the
 *    string it appears in, so one bad node line makes the entire graph fail to parse.
 * 2. `assertValidDot()` — a structural check on the emitted DOT that turns exactly that class of
 *    mistake into a thrown error at generation time, instead of a blank page with a Graphviz
 *    "syntax error in line N" that only a human opening the HTML ever sees.
 */

/** Chars a quoted string may legally sit directly after, ignoring whitespace. */
const LEGAL_BEFORE_STRING = new Set(['=', '[', ',', ';', '{', '}', '>', '-']);

/** Chars a quoted string may legally be followed by, ignoring whitespace. */
const LEGAL_AFTER_STRING = new Set(['=', '[', ']', ',', ';', '{', '}', '-', '>']);

/**
 * Escape a runtime value for use INSIDE a quoted DOT string.
 *
 * Only `\` and `"` matter: everything else (parens, spaces, `-`, `#`, unicode) is ordinary text once
 * it is inside quotes. Note this deliberately escapes `\` FIRST, so a value containing a backslash
 * cannot smuggle an escape sequence in. Callers compose label lines with a literal `\\n` AFTER
 * escaping their values — the separator is ours, the value is theirs.
 */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
export function dotValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape a runtime value for a `record`/`Mrecord` label, on TOP of {@link dotValue}.
 *
 * A record label is not ordinary label text: `|` splits fields, `{}` toggles the layout direction
 * and `<>` delimit port names. A queue name carrying any of them would not merely look wrong — it
 * would restructure the node, splitting one queue box into two or rotating it. Graphviz's record
 * grammar escapes those with a backslash, and since {@link dotValue} has already doubled real
 * backslashes, the `\\` emitted here survives into the record parser as a single one.
 *
 * Leading and trailing spaces are also dropped by the record parser, which is exactly why the
 * horizontal-cylinder queue node uses a `" |"` prefix — that empty first field is deliberate.
 */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
export function recordValue(value: string): string {
    return dotValue(value).replace(/[|{}<>]/g, (char: string) => `\\${char}`);
}

/** Thrown when the generator produces DOT that Graphviz could not parse. */
export class InvalidDotError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidDotError';
    }
}

/**
 * Fail loudly on structurally broken DOT.
 *
 * This is not a full Graphviz parser — it is the check that catches the failure mode a string
 * builder actually has: a quote that ends a string early (or never ends it). It scans the quoted
 * strings honouring `\"` escapes and asserts each one is terminated and is bounded by DOT
 * punctuation rather than by bare text. An unescaped `"` inside a label always violates that: the
 * string ends mid-label, and the remaining label text becomes stray tokens.
 */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
export function assertValidDot(dot: string, source: string): void {
    // Comment text is not code: a `"` or a word in it must never be read as a DOT token. Blanking
    // it (offsets preserved) keeps every reported line number the one Graphviz would report.
    const code = blankComments(dot);
    let index = 0;
    while (index < code.length) {
        if (code[index] !== '"') {
            index++;
            continue;
        }
        const start = index;
        index++;
        while (index < code.length && code[index] !== '"') {
            index += code[index] === '\\' ? 2 : 1;
        }
        if (index >= code.length) {
            throw new InvalidDotError(`${source}: unterminated string starting at ${describe(dot, start)}`);
        }
        const end = index;
        index++;
        checkNeighbor(code, dot, start, end, source);
    }
}

/** Replace `//`, `#` and `/* *\/` comment bodies with spaces, preserving length and newlines. */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
function blankComments(dot: string): string {
    const out = dot.split('');
    let index = 0;
    let inString = false;
    while (index < out.length) {
        const two = dot.slice(index, index + 2);
        if (inString) {
            if (dot[index] === '\\') index++;
            else if (dot[index] === '"') inString = false;
            index++;
        } else if (dot[index] === '"') {
            inString = true;
            index++;
        } else if (two === '//' || dot[index] === '#') {
            while (index < out.length && out[index] !== '\n') out[index++] = ' ';
        } else if (two === '/*') {
            while (index < out.length && dot.slice(index, index + 2) !== '*/') {
                if (out[index] !== '\n') out[index] = ' ';
                index++;
            }
            if (index < out.length) {
                out[index] = ' ';
                out[index + 1] = ' ';
                index += 2;
            }
        } else {
            index++;
        }
    }
    return out.join('');
}

/** Verify the non-whitespace chars bracketing a quoted string are DOT punctuation, not stray text. */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
function checkNeighbor(code: string, dot: string, start: number, end: number, source: string): void {
    const before = nonSpaceChar(code, start - 1, -1);
    if (before !== undefined && !LEGAL_BEFORE_STRING.has(before)) {
        throw new InvalidDotError(
            `${source}: a quoted string starts right after '${before}' at ${describe(dot, start)} — ` +
                `an unescaped '"' in an interpolated value almost certainly ended the previous string early. ` +
                `Interpolate values through dotValue().`,
        );
    }
    const after = nonSpaceChar(code, end + 1, 1);
    if (after !== undefined && !LEGAL_AFTER_STRING.has(after)) {
        throw new InvalidDotError(
            `${source}: a quoted string is followed by '${after}' at ${describe(dot, end)} — ` +
                `an unescaped '"' in an interpolated value almost certainly ended this string early. ` +
                `Interpolate values through dotValue().`,
        );
    }
}

/** The first non-whitespace char walking `step` from `from`, or undefined at either end. */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
function nonSpaceChar(dot: string, from: number, step: number): string | undefined {
    for (let i = from; i >= 0 && i < dot.length; i += step) {
        if (!/\s/.test(dot[i])) return dot[i];
    }
    return undefined;
}

/** `line N: <the line>` for the offset, so the error names the same line Graphviz would. */
// webpieces-disable no-function-outside-class -- DOT string helpers, matching the sibling builders in runtime-visualizer.ts
function describe(dot: string, offset: number): string {
    const lineNumber = dot.slice(0, offset).split('\n').length;
    const line = dot.split('\n')[lineNumber - 1];
    return `line ${lineNumber}: ${line.trim()}`;
}
