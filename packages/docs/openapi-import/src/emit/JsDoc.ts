/**
 * Vendor prose as a JSDoc block. ESCAPED, because the text is foreign: a `*\/` would end the comment
 * early, and an `@` would start a tag (`@returns`, `{@link X}`) the vendor never meant — which the
 * webpieces doc extractor would then try to resolve.
 */
export class JsDoc {
    /** The text, made safe to sit inside a `/** ... *\/` block. */
    escape(text: string): string {
        return text.replace(/\*\//g, '*&#47;').replace(/@/g, '&#64;').replace(/\r/g, '');
    }

    /** One line, at most `max` characters — for a `@summary`. */
    oneLine(text: string, max: number): string {
        const line = this.escape(text).replace(/\s+/g, ' ').trim();
        return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
    }

    /** A block of `lines` (already escaped), indented by `indent`; empty when there are none. */
    block(lines: readonly string[], indent: string): string {
        if (lines.length === 0) return '';
        const body = lines.map((line: string) => (line === '' ? `${indent} *` : `${indent} * ${line}`)).join('\n');
        return `${indent}/**\n${body}\n${indent} */\n`;
    }

    /** Escaped prose split into lines (blank lines kept, trailing whitespace dropped). */
    prose(text: string | undefined): string[] {
        if (text === undefined || text.trim() === '') return [];
        return this.escape(text.trim())
            .split('\n')
            .map((line: string) => line.trimEnd());
    }
}
