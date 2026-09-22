/**
 * A reader for the block-YAML subset this package emits.
 *
 * It exists for ONE job: proving that an emitted YAML document is the same document as its JSON
 * counterpart. It is exported because the consumer that needs it is a golden spec in a DIFFERENT
 * project (`apps/app-example/partner-api`), and a reader that only the emitter's own package could
 * reach would leave every downstream golden with no way to check its YAML at all.
 *
 * ## Why it exists rather than a YAML dependency
 *
 * The goldens commit JSON only: committing both serializations would double the review surface every
 * decorator change has to be diffed against, for a second file that is the first one restated. What
 * proves the YAML instead is one spec that PARSES it and asserts deep equality with its JSON
 * counterpart — and doing that with a real YAML library would put a dependency into a package whose
 * whole story is `typescript` plus two webpieces packages.
 *
 * ## Why a mirror bug is unlikely
 *
 * It is written in the OPPOSITE direction from {@link YamlWriter}: indentation and quoting are
 * re-derived here from the text rather than shared with the emitter, so the two do not fail together
 * for the same reason. It understands exactly what the writer produces — double-quoted keys and
 * string scalars, bare numbers/booleans/null, `{}` and `[]` for empties, `- ` list items — and
 * anything else is a parse failure rather than a guess. It is NOT a general YAML parser and must not
 * be used as one.
 */
// webpieces-disable no-any-unknown -- it parses arbitrary JSON-shaped YAML; `unknown` IS the honest return type, and the caller compares it against a JSON.parse result
export class YamlReader {
    private lines: string[] = [];
    private index = 0;

    // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
    read(text: string): unknown {
        this.lines = text.split('\n').filter((line: string) => line.trim() !== '');
        this.index = 0;
        return this.lines.length === 0 ? {} : this.value(0);
    }

    /** The value whose first line is at `indent`, consuming every line that belongs to it. */
    // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
    private value(indent: number): unknown {
        const line = this.lines[this.index];
        if (line === undefined) {
            return {};
        }
        return line.trimStart().startsWith('-') ? this.list(indent) : this.map(indent);
    }

    // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
    private map(indent: number): Record<string, unknown> {
        // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
        const out: Record<string, unknown> = {};
        while (this.index < this.lines.length) {
            const line = this.lines[this.index]!;
            const depth = line.length - line.trimStart().length;
            if (depth < indent) {
                break;
            }
            const text = line.trim();
            const split = text.indexOf('": ');
            if (split === -1) {
                // `"key":` with the value nested under it.
                const key = JSON.parse(text.slice(0, text.length - 1)) as string;
                this.index += 1;
                out[key] = this.value(depth + 4);
                continue;
            }
            out[JSON.parse(text.slice(0, split + 1)) as string] = this.scalar(
                text.slice(split + 3),
            );
            this.index += 1;
        }
        return out;
    }

    // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
    private list(indent: number): unknown[] {
        // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
        const out: unknown[] = [];
        while (this.index < this.lines.length) {
            const line = this.lines[this.index]!;
            const depth = line.length - line.trimStart().length;
            const text = line.trim();
            if (depth < indent || !text.startsWith('-')) {
                break;
            }
            const rest = text.slice(1).trim();
            if (rest.startsWith('"') && rest.includes('": ')) {
                // An object whose FIRST key shares the `- ` line; the rest align under it.
                this.lines[this.index] = ' '.repeat(depth + 2) + rest;
                out.push(this.map(depth + 2));
                continue;
            }
            this.index += 1;
            out.push(this.scalar(rest));
        }
        return out;
    }

    // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
    private scalar(text: string): unknown {
        if (text === '{}') {
            return {};
        }
        if (text === '[]') {
            return [];
        }
        if (text === 'null') {
            return null;
        }
        // webpieces-disable no-any-unknown -- see the class doc: a JSON-shaped value read from text
        return JSON.parse(text) as unknown;
    }
}
