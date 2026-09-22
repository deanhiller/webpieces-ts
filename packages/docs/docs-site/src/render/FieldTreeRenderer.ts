import { FieldNode, SchemaVariant } from '../spec/FieldTree';
import { Html } from './Html';
import { Markdown } from '../markdown/Markdown';
import { SiteUrls } from './SiteUrls';

/** The literal line a reader Ctrl-Fs for when they want to know what an enum accepts. */
export const POSSIBLE_VALUES = 'Possible values:';

/**
 * Renders the parameter tree: field name, type label, prose, and — for an enum — the COMPLETE
 * `Possible values:` chip line.
 *
 * The list is complete or it is absent; there is no "…and 3 more". A truncated list of accepted
 * values is the shape of documentation that makes a partner guess, and the guess is a 400 they
 * cannot debug from the page they are reading.
 *
 * A field whose type is a named object renders as a LINK to that object's page and is NOT expanded
 * underneath — see `FieldTreeBuilder` for why the example body resolves the same reference fully.
 */
export class FieldTreeRenderer {
    private readonly html = new Html();

    constructor(
        private readonly markdown: Markdown,
        private readonly urls: SiteUrls,
    ) {}

    /** One tree. `prefix` is the page's `../` prefix, so the links work at any hosting path. */
    render(fields: readonly FieldNode[], prefix: string): string {
        if (fields.length === 0) {
            return '<p class="field-doc">No fields.</p>';
        }
        return fields.map((field: FieldNode): string => this.field(field, prefix)).join('');
    }

    /**
     * The `oneOf` variants, ALL EXPANDED, one labelled block per branch keyed by its discriminator
     * value. Never tabbed: a partner writing one handler needs every shape at once, and a tab is
     * invisible to Ctrl-F and to print.
     */
    renderVariants(
        variants: readonly SchemaVariant[],
        discriminator: string,
        prefix: string,
    ): string {
        return variants
            .map((variant: SchemaVariant): string => this.variant(variant, discriminator, prefix))
            .join('');
    }

    private variant(variant: SchemaVariant, discriminator: string, prefix: string): string {
        const key =
            variant.discriminatorValue === '' || discriminator === ''
                ? ''
                : ` — <code>${this.html.escape(discriminator)}: "${this.html.escape(variant.discriminatorValue)}"</code>`;
        return [
            '<section class="variant">',
            `<div class="variant-head">${this.html.escape(variant.label)}${key}</div>`,
            this.render(variant.fields, prefix),
            '</section>',
        ].join('');
    }

    private field(field: FieldNode, prefix: string): string {
        const parts = ['<div class="field">', '<div class="field-head">'];
        parts.push(`<span class="field-name">${this.html.escape(field.name)}</span>`);
        parts.push(`<span class="field-type">${this.typeLabel(field, prefix)}</span>`);
        if (field.required) {
            parts.push('<span class="field-required">REQUIRED</span>');
        }
        parts.push('</div>');
        if (field.description !== '') {
            parts.push(`<div class="field-doc">${this.markdown.render(field.description)}</div>`);
        }
        parts.push(this.chips(field));
        if (field.children.length > 0) {
            parts.push(`<div class="field-children">${this.render(field.children, prefix)}</div>`);
        }
        parts.push('</div>');
        return parts.join('');
    }

    private typeLabel(field: FieldNode, prefix: string): string {
        if (field.linkTo === undefined) {
            return this.html.escape(field.typeLabel);
        }
        const href = `${prefix}${this.urls.schema(field.linkTo)}`;
        const label = this.html.escape(field.typeLabel);
        return `<a href="${href}">${label}</a>`;
    }

    private chips(field: FieldNode): string {
        if (field.possibleValues.length === 0) {
            return '';
        }
        const chips = field.possibleValues
            .map((value: string): string => `<span class="chip">${this.html.escape(value)}</span>`)
            .join('');
        return `<div class="chips">${POSSIBLE_VALUES} ${chips}</div>`;
    }
}
