import { Html } from '../render/Html';

/**
 * A DOCUMENTED SUBSET of CommonMark, over trusted, PR-reviewed input — the JSDoc a developer wrote
 * and the markdown files a manifest names. It is not a CommonMark implementation and does not try to
 * be; #985 puts a full one explicitly out of scope, because the alternative to ~180 lines here is a
 * dependency in every upstream project that wants an API reference.
 *
 * What it renders:
 *
 * | block | spelling |
 * |---|---|
 * | heading | `#` through `######` |
 * | fenced code | ` ``` ` with an optional language word |
 * | table | a `\|` row, then a `\|---\|` row, then rows |
 * | list | `- ` / `* ` for bullets, `1. ` for numbers |
 * | blockquote | `> ` |
 * | rule | `---` on its own line |
 * | paragraph | anything else, blank-line separated |
 *
 * and inline: `` `code` ``, `**bold**`, `*italic*`, `[text](url)`.
 *
 * **Everything is HTML-escaped first**, before any inline pattern runs, so a `<` in a JSDoc body is
 * text rather than the start of a tag. That ordering is the whole safety argument: escape-then-mark
 * cannot produce a tag the source did not ask for, while mark-then-escape would escape the tags this
 * renderer just wrote.
 */
export class Markdown {
    private readonly html = new Html();

    /** The rendered HTML for a markdown document. */
    render(source: string): string {
        const lines = source.replace(/\r\n/g, '\n').split('\n');
        const out: string[] = [];
        let index = 0;
        while (index < lines.length) {
            const consumed = this.block(lines, index, out);
            index = consumed > index ? consumed : index + 1;
        }
        return out.join('\n');
    }

    /** Inline markdown only — for a place that is already one line, like a table cell. */
    inline(source: string): string {
        const escaped = this.html.escape(source);
        return escaped
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    }

    /** @returns the index of the first line AFTER the block this consumed. */
    private block(lines: readonly string[], start: number, out: string[]): number {
        const line = lines[start] ?? '';
        if (line.trim() === '') {
            return start + 1;
        }
        if (line.startsWith('```')) {
            return this.fence(lines, start, out);
        }
        if (/^#{1,6}\s/.test(line)) {
            return this.heading(line, start, out);
        }
        if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
            out.push('<hr />');
            return start + 1;
        }
        if (line.trimStart().startsWith('|') && this.isDivider(lines[start + 1])) {
            return this.table(lines, start, out);
        }
        if (this.isBullet(line) || this.isNumber(line)) {
            return this.list(lines, start, out);
        }
        if (line.trimStart().startsWith('> ')) {
            return this.quote(lines, start, out);
        }
        return this.paragraph(lines, start, out);
    }

    private fence(lines: readonly string[], start: number, out: string[]): number {
        const language = (lines[start] ?? '').slice(3).trim();
        const body: string[] = [];
        let index = start + 1;
        while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
            body.push(lines[index] ?? '');
            index++;
        }
        const languageClass =
            language === '' ? '' : ` class="language-${this.html.escape(language)}"`;
        out.push(`<pre><code${languageClass}>${this.html.escape(body.join('\n'))}</code></pre>`);
        return index + 1;
    }

    private heading(line: string, start: number, out: string[]): number {
        const hashes = (/^#{1,6}/.exec(line) ?? [''])[0].length;
        out.push(`<h${hashes}>${this.inline(line.slice(hashes).trim())}</h${hashes}>`);
        return start + 1;
    }

    private table(lines: readonly string[], start: number, out: string[]): number {
        const header = this.cells(lines[start] ?? '');
        const rows: string[][] = [];
        let index = start + 2;
        while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
            rows.push(this.cells(lines[index] ?? ''));
            index++;
        }
        const head = header.map((cell: string): string => `<th>${this.inline(cell)}</th>`).join('');
        const body = rows
            .map(
                (row: string[]): string =>
                    `<tr>${row.map((cell: string): string => `<td>${this.inline(cell)}</td>`).join('')}</tr>`,
            )
            .join('');
        out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        return index;
    }

    private list(lines: readonly string[], start: number, out: string[]): number {
        const ordered = this.isNumber(lines[start] ?? '');
        const items: string[] = [];
        let index = start;
        while (
            index < lines.length &&
            (this.isBullet(lines[index] ?? '') || this.isNumber(lines[index] ?? ''))
        ) {
            items.push(this.inline(this.itemTextOf(lines[index] ?? '')));
            index++;
        }
        const tag = ordered ? 'ol' : 'ul';
        const body = items.map((item: string): string => `<li>${item}</li>`).join('');
        out.push(`<${tag}>${body}</${tag}>`);
        return index;
    }

    private quote(lines: readonly string[], start: number, out: string[]): number {
        const body: string[] = [];
        let index = start;
        while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('> ')) {
            body.push((lines[index] ?? '').trimStart().slice(2));
            index++;
        }
        out.push(`<blockquote>${this.render(body.join('\n'))}</blockquote>`);
        return index;
    }

    private paragraph(lines: readonly string[], start: number, out: string[]): number {
        const body: string[] = [];
        let index = start;
        while (
            index < lines.length &&
            (lines[index] ?? '').trim() !== '' &&
            !this.startsBlock(lines, index)
        ) {
            body.push(lines[index] ?? '');
            index++;
        }
        out.push(`<p>${this.inline(body.join('\n'))}</p>`);
        return index === start ? start + 1 : index;
    }

    /** True when the line at `index` begins a block that a paragraph must not swallow. */
    private startsBlock(lines: readonly string[], index: number): boolean {
        if (index === 0) {
            return false;
        }
        const line = lines[index] ?? '';
        return (
            line.startsWith('```') ||
            /^#{1,6}\s/.test(line) ||
            this.isBullet(line) ||
            this.isNumber(line) ||
            line.trimStart().startsWith('> ') ||
            (line.trimStart().startsWith('|') && this.isDivider(lines[index + 1]))
        );
    }

    private isDivider(line: string | undefined): boolean {
        return line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line);
    }

    private isBullet(line: string): boolean {
        return /^\s*[-*]\s+/.test(line);
    }

    private isNumber(line: string): boolean {
        return /^\s*\d+\.\s+/.test(line);
    }

    private itemTextOf(line: string): string {
        return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
    }

    private cells(line: string): string[] {
        const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return trimmed.split('|').map((cell: string): string => cell.trim());
    }
}
