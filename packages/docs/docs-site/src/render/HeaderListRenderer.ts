import { HeaderInfo } from '../spec/ApiSpec';
import { SchemaLens } from '../spec/SchemaLens';
import { Html } from './Html';
import { Markdown } from '../markdown/Markdown';

/** The heading a reader Ctrl-Fs for, above every list of headers. */
export const HEADERS_HEADING = 'Headers';

/**
 * A **Headers** list (#1292): one row per header with its name, type, `REQUIRED` / `OPTIONAL`, and
 * prose — on a response card beside the body schema, and in the request section for `in: "header"`
 * parameters.
 *
 * A response header used to be invisible on the site although the document declared it: the
 * `x-request-id` a partner must quote in a support ticket was in `components.headers` and on every
 * response, and no page said so. Each row uses the SAME markup as a body field, and its type label
 * is the same {@link SchemaLens} reading, so a header reads exactly like a field. Unlike a body field,
 * optional is said out loud: a header list is short, and "may I omit this" is the question a reader
 * of one is asking.
 */
export class HeaderListRenderer {
    private readonly html = new Html();

    constructor(
        private readonly lens: SchemaLens,
        private readonly markdown: Markdown,
    ) {}

    /** The list, or the empty string when there are no headers — no empty heading. */
    render(headers: readonly HeaderInfo[]): string {
        if (headers.length === 0) {
            return '';
        }
        const rows = headers.map((header: HeaderInfo): string => this.row(header)).join('');
        return `<div class="headers"><div class="headers-head">${HEADERS_HEADING}</div>${rows}</div>`;
    }

    private row(header: HeaderInfo): string {
        const parts = ['<div class="field">', '<div class="field-head">'];
        parts.push(`<span class="field-name">${this.html.escape(header.name)}</span>`);
        parts.push(`<span class="field-type">${this.html.escape(this.typeOf(header))}</span>`);
        parts.push(
            header.required
                ? '<span class="field-required">REQUIRED</span>'
                : '<span class="field-optional">OPTIONAL</span>',
        );
        parts.push('</div>');
        const description = header.description !== '' ? header.description : this.lens.describe(header.schema);
        if (description !== '') {
            parts.push(`<div class="field-doc">${this.markdown.render(description)}</div>`);
        }
        parts.push('</div>');
        return parts.join('');
    }

    /** A header with no `schema` is a string on the wire — every HTTP header value is text. */
    private typeOf(header: HeaderInfo): string {
        return header.schema.isObject() ? this.lens.label(header.schema) : 'string';
    }
}
